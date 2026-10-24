// Worker de segmentación: MediaPipe corre aquí para no frenar la reproducción.
// Recibe cuadros ya reducidos a 256×256 y devuelve la máscara como ImageBitmap
// (r = persona, g = piel). Todo se combina en la GPU: leer las máscaras a memoria
// costaba ~60 ms por cuadro y era el cuello de botella de la exportación.

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

const BACKGROUND = 0
const BODY_SKIN = 2
const FACE_SKIN = 3
/** Suavizado temporal: cuánto pesa el cuadro nuevo (evita parpadeo en los bordes). */
const TEMPORAL = 0.65

let segmenter: ImageSegmenter | null = null
let canvas: OffscreenCanvas
let gl: WebGL2RenderingContext
let program: WebGLProgram
let quad: WebGLBuffer
let lastTs = 0

/** Máscara anterior de cada clip (para el suavizado temporal), en una textura propia. */
const history = new Map<string, { tex: WebGLTexture; w: number; h: number }>()

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBg;
uniform sampler2D uBody;
uniform sampler2D uFace;
uniform sampler2D uPrev;
uniform float uBlend;
out vec4 outColor;
void main() {
  // Las máscaras de MediaPipe tienen la fila 0 arriba; el lienzo, abajo.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  float person = 1.0 - texture(uBg, uv).r;
  float skin = texture(uBody, uv).r + texture(uFace, uv).r;
  vec2 cur = vec2(person, min(1.0, skin));
  vec2 m = mix(texture(uPrev, vUv).rg, cur, uBlend);
  outColor = vec4(m, 0.0, 1.0);
}`

function setupGl() {
  gl = canvas.getContext('webgl2') as WebGL2RenderingContext
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  program = gl.createProgram()!
  gl.attachShader(program, sh(gl.VERTEX_SHADER, VS))
  gl.attachShader(program, sh(gl.FRAGMENT_SHADER, FS))
  gl.bindAttribLocation(program, 0, 'aPos')
  gl.linkProgram(program)
  quad = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
}

function historyTex(key: string, w: number, h: number) {
  const t = history.get(key)
  if (t && t.w === w && t.h === h) return t
  if (t) gl.deleteTexture(t.tex)
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fresh = { tex, w, h }
  history.set(key, fresh)
  return fresh
}

interface InitMsg {
  type: 'init'
  wasm: string
  model: string
}

interface SegMsg {
  type: 'segment'
  id: number
  key: string
  frame: ImageBitmap
  reset: boolean
}

self.onmessage = async (e: MessageEvent<InitMsg | SegMsg | { type: 'forget'; key: string }>) => {
  const msg = e.data
  if (msg.type === 'init') {
    try {
      canvas = new OffscreenCanvas(256, 256)
      const fileset = await FilesetResolver.forVisionTasks(msg.wasm)
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.model, delegate: 'GPU' },
        canvas,
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })
      setupGl()
      postMessage({ type: 'ready' })
    } catch (err) {
      postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.type === 'forget') {
    const t = history.get(msg.key)
    if (t) gl.deleteTexture(t.tex)
    history.delete(msg.key)
    return
  }
  if (!segmenter) return
  lastTs = Math.max(lastTs + 1, Math.floor(performance.now()))
  const t0 = performance.now()
  const result = segmenter.segmentForVideo(msg.frame, lastTs)
  msg.frame.close()
  const masks = result.confidenceMasks ?? []
  const w = masks[0]?.width ?? 256
  const h = masks[0]?.height ?? 256
  const textures = [BACKGROUND, BODY_SKIN, FACE_SKIN].map((i) => masks[i]?.getAsWebGLTexture())

  // Combina las máscaras (y la anterior, para suavizar) en una sola imagen, en la GPU.
  const fresh = msg.reset || !history.has(msg.key)
  const hist = historyTex(msg.key, w, h)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, w, h)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.SCISSOR_TEST)
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const names = ['uBg', 'uBody', 'uFace', 'uPrev']
  const texs = [...textures, hist.tex]
  texs.forEach((t, i) => {
    gl.activeTexture(gl.TEXTURE0 + i)
    gl.bindTexture(gl.TEXTURE_2D, t ?? hist.tex)
    gl.uniform1i(gl.getUniformLocation(program, names[i]), i)
  })
  gl.uniform1f(gl.getUniformLocation(program, 'uBlend'), fresh ? 1 : TEMPORAL)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  // Guarda el resultado como "anterior" para el siguiente cuadro de este clip.
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, hist.tex)
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h)
  const bitmap = canvas.transferToImageBitmap()
  for (const m of masks) m.close()
  postMessage({ type: 'mask', id: msg.id, key: msg.key, bitmap, ms: performance.now() - t0 }, { transfer: [bitmap] })
}
