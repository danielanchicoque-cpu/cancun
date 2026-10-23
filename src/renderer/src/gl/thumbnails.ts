// Miniaturas animadas de transiciones y efectos, dibujadas con los mismos shaders del
// compositor sobre dos imágenes de muestra. Se generan bajo demanda y quedan en caché.

import { EFFECTS, EFFECT_FS, QUAD_VS, TRANSITION_FS, TRANSITION_KINDS } from './shaders'

const W = 192
const H = 108
export const THUMB_FRAMES = 16

let ctx: {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  trans: { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }
  effect: { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }
  a: WebGLTexture
  b: WebGLTexture
} | null = null

function sample(top: string, bottom: string, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, top)
  grad.addColorStop(1, bottom)
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  // Unas formas para que se note el movimiento.
  g.fillStyle = 'rgba(255,255,255,0.18)'
  for (let i = 0; i < 6; i++) g.fillRect(i * 36 - 10, H * 0.62 + (i % 2) * 10, 22, 60)
  g.beginPath()
  g.arc(W * 0.72, H * 0.32, 18, 0, Math.PI * 2)
  g.fillStyle = 'rgba(255,240,200,0.9)'
  g.fill()
  g.fillStyle = '#fff'
  g.font = 'bold 34px Segoe UI'
  g.fillText(label, 16, 44)
  return c
}

function setup() {
  if (ctx) return ctx
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })!
  const compile = (fs: string, uniforms: string[]) => {
    const make = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, make(gl.VERTEX_SHADER, QUAD_VS))
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs))
    gl.bindAttribLocation(prog, 0, 'aPos')
    gl.linkProgram(prog)
    const loc: Record<string, WebGLUniformLocation | null> = {}
    for (const u of uniforms) loc[u] = gl.getUniformLocation(prog, u)
    return { prog, loc }
  }
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const tex = (img: HTMLCanvasElement) => {
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Igual que las capas del compositor: guardadas con la Y invertida.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    return t
  }
  const common = ['uMatrix', 'uCanvas', 'uSize']
  ctx = {
    gl,
    canvas,
    trans: compile(TRANSITION_FS, [...common, 'uA', 'uB', 'uP', 'uKind']),
    effect: compile(EFFECT_FS, [...common, 'uSrc', 'uEffect', 'uTime', 'uIntensity', 'uSpeed']),
    a: tex(sample('#1f6f86', '#0d2a36', 'A')),
    b: tex(sample('#d88a3c', '#6a2c4a', 'B'))
  }
  return ctx
}

function draw(kind: 'transition' | 'effect', index: number, value: number): string {
  const c = setup()
  const { gl } = c
  const p = kind === 'transition' ? c.trans : c.effect
  gl.viewport(0, 0, W, H)
  gl.useProgram(p.prog)
  gl.uniformMatrix3fv(p.loc.uMatrix, false, new Float32Array([W, 0, 0, 0, H, 0, 0, 0, 1]))
  gl.uniform2f(p.loc.uCanvas, W, H)
  gl.uniform2f(p.loc.uSize, W, H)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, c.a)
  if (kind === 'transition') {
    gl.uniform1i(p.loc.uA, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, c.b)
    gl.uniform1i(p.loc.uB, 1)
    gl.uniform1f(p.loc.uP, value)
    gl.uniform1i(p.loc.uKind, index)
  } else {
    gl.uniform1i(p.loc.uSrc, 0)
    gl.uniform1i(p.loc.uEffect, index)
    gl.uniform1f(p.loc.uTime, value)
    gl.uniform1f(p.loc.uIntensity, 0.8)
    gl.uniform1f(p.loc.uSpeed, 0.5)
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  return c.canvas.toDataURL('image/jpeg', 0.8)
}

const cache = new Map<string, string[]>()

/** Cuadros de la miniatura animada (el primero sirve de imagen fija). */
export function thumbFrames(kind: 'transition' | 'effect', id: string): string[] {
  const key = `${kind}:${id}`
  let frames = cache.get(key)
  if (!frames) {
    const index = kind === 'transition' ? TRANSITION_KINDS.indexOf(id as never) : EFFECTS.findIndex((e) => e.id === id)
    frames = Array.from({ length: THUMB_FRAMES }, (_, i) =>
      kind === 'transition' ? draw(kind, index, 0.1 + (0.8 * i) / (THUMB_FRAMES - 1)) : draw(kind, index, (i / THUMB_FRAMES) * 2)
    )
    cache.set(key, frames)
  }
  return frames
}

/** Solo la imagen fija (más barata para pintar la cuadrícula completa). */
export function thumbStill(kind: 'transition' | 'effect', id: string): string {
  const key = `${kind}:${id}:still`
  let url = cache.get(key)?.[0]
  if (!url) {
    const index = kind === 'transition' ? TRANSITION_KINDS.indexOf(id as never) : EFFECTS.findIndex((e) => e.id === id)
    url = draw(kind, index, kind === 'transition' ? 0.45 : 0.6)
    cache.set(key, [url])
  }
  return url
}
