// Compositor WebGL2 de la vista previa. Cada clip se dibuja en una capa del tamaño
// del lienzo (con su transformación y su color horneado) y las capas se apilan con
// alfa premultiplicado. Las transiciones mezclan dos capas con su propio shader.

import { BAKE_SIZE, bakeGrade, isNeutral } from '@shared/color'
import type { CubeLut } from '@shared/cube'
import { type MediaClip, type Project, type TextClip, defaultAdjust } from '@shared/project'
import type { ClipFrame, Layer } from '@shared/timeline'
import { COPY_FS, LAYER_FS, QUAD_VS, TRANSITION_FS, TRANSITION_KINDS } from './shaders'

type Program = { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }

interface Target {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
}

export type FrameSource = HTMLVideoElement | HTMLImageElement

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): Program {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, make(gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs))
  gl.bindAttribLocation(prog, 0, 'aPos')
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
  const loc: Program['loc'] = {}
  for (const u of uniforms) loc[u] = gl.getUniformLocation(prog, u)
  return { prog, loc }
}

/** Matriz 3x3 (columnas) que lleva el cuadrado unidad al rectángulo transformado. */
function quadMatrix(cx: number, cy: number, w: number, h: number, rotDeg: number): Float32Array {
  const a = (rotDeg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  // p = R * S * (u - 0.5) + c
  return new Float32Array([
    cos * w, sin * w, 0,
    -sin * h, cos * h, 0,
    cx - 0.5 * (cos * w - sin * h), cy - 0.5 * (sin * w + cos * h), 1
  ])
}

export class Compositor {
  private gl: WebGL2RenderingContext
  private layerProg: Program
  private copyProg: Program
  private transProg: Program
  private targets: Target[] = []
  private width = 0
  private height = 0
  private srcTex = new Map<string, WebGLTexture>()
  private gradeTex = new Map<string, { key: string; tex: WebGLTexture }>()
  private textTex = new Map<string, { key: string; tex: WebGLTexture; w: number; h: number }>()
  private identity: WebGLTexture

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('WebGL2 no está disponible')
    this.gl = gl
    const common = ['uMatrix', 'uCanvas', 'uSrc', 'uOpacity']
    this.layerProg = compile(gl, QUAD_VS, LAYER_FS, [
      ...common, 'uGrade', 'uUseGrade', 'uGradeSize', 'uTexel', 'uSharpen', 'uVignette', 'uChroma', 'uKey', 'uKeyIntensity', 'uKeyShadow'
    ])
    this.copyProg = compile(gl, QUAD_VS, COPY_FS, common)
    this.transProg = compile(gl, QUAD_VS, TRANSITION_FS, ['uMatrix', 'uCanvas', 'uA', 'uB', 'uP', 'uKind', 'uSize'])

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    this.identity = this.make3D(bakeGrade(defaultAdjust(), null, 0, 2), 2)
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height) return
    const gl = this.gl
    this.width = this.canvas.width = w
    this.height = this.canvas.height = h
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fbo)
      gl.deleteTexture(t.tex)
    }
    this.targets = []
  }

  private target(i: number): Target {
    const gl = this.gl
    while (this.targets.length <= i) {
      const tex = this.tex2D()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      this.targets.push({ fbo, tex })
    }
    return this.targets[i]
  }

  private tex2D(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  private make3D(data: Float32Array, size: number): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    const bytes = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, data[i])) * 255)
    // RGB8 de 33³ es suficiente y mucho más liviano que float para una GTX 1060.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes)
    return tex
  }

  /** Textura 3D del color de un clip; se rehornea solo cuando cambia el ajuste. */
  private gradeFor(clip: MediaClip, luts: Map<string, CubeLut>): WebGLTexture | null {
    const lut = clip.color.lut
    const lutData = lut ? luts.get(lut.path) ?? null : null
    if (!lutData && isNeutral(clip.color.adjust)) return null
    const key = JSON.stringify([clip.color.adjust, lut?.path, lut?.intensity, Boolean(lutData)])
    const cached = this.gradeTex.get(clip.id)
    if (cached?.key === key) return cached.tex
    if (cached) this.gl.deleteTexture(cached.tex)
    const tex = this.make3D(bakeGrade(clip.color.adjust, lutData, lut?.intensity ?? 0), BAKE_SIZE)
    this.gradeTex.set(clip.id, { key, tex })
    return tex
  }

  private upload(clipId: string, src: FrameSource): boolean {
    const ready = src instanceof HTMLVideoElement ? src.readyState >= 2 && src.videoWidth > 0 : src.complete && src.naturalWidth > 0
    if (!ready) return Boolean(this.srcTex.get(clipId))
    const gl = this.gl
    let tex = this.srcTex.get(clipId)
    if (!tex) {
      tex = this.tex2D()
      this.srcTex.set(clipId, tex)
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    return true
  }

  /** Dibuja un clip en el destino actual, en coordenadas del lienzo de vista previa. */
  private drawClip(p: Project, f: ClipFrame, src: FrameSource | undefined, luts: Map<string, CubeLut>) {
    if (!src || !this.upload(f.clip.id, src)) return
    const gl = this.gl
    const c = f.clip
    const media = p.media[c.mediaId]
    const mw = media.width ?? (src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth)
    const mh = media.height ?? (src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight)
    const s = this.width / p.canvas.width
    const fit = Math.min(p.canvas.width / mw, p.canvas.height / mh) * c.transform.scale
    const w = mw * fit * s
    const h = mh * fit * s
    const cx = this.width / 2 + (c.transform.x * this.width) / 2
    const cy = this.height / 2 + (c.transform.y * this.height) / 2

    const { prog, loc } = this.layerProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, quadMatrix(cx, cy, w, h, c.transform.rotation))
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex.get(c.id)!)
    gl.uniform1i(loc.uSrc, 0)
    const grade = this.gradeFor(c, luts)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, grade ?? this.identity)
    gl.uniform1i(loc.uGrade, 1)
    gl.uniform1i(loc.uUseGrade, grade ? 1 : 0)
    gl.uniform1f(loc.uGradeSize, BAKE_SIZE)
    gl.uniform1f(loc.uOpacity, c.transform.opacity)
    gl.uniform2f(loc.uTexel, 1 / Math.max(1, w), 1 / Math.max(1, h))
    gl.uniform1f(loc.uSharpen, c.color.adjust.sharpen)
    gl.uniform1f(loc.uVignette, c.color.adjust.vignette)
    const chroma = c.background.mode === 'chroma'
    gl.uniform1i(loc.uChroma, chroma ? 1 : 0)
    const hex = c.background.chroma.color.replace('#', '')
    gl.uniform3f(loc.uKey, parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255)
    gl.uniform1f(loc.uKeyIntensity, c.background.chroma.intensity)
    gl.uniform1f(loc.uKeyShadow, c.background.chroma.shadow)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private textTexture(p: Project, clip: TextClip) {
    const s = clip.style
    const size = Math.max(4, Math.round(s.size * (p.canvas.height / 1080) * (this.height / p.canvas.height) * clip.transform.scale))
    const key = JSON.stringify([clip.text, s, size])
    const cached = this.textTex.get(clip.id)
    if (cached?.key === key) return cached
    const cv = document.createElement('canvas')
    const ctx = cv.getContext('2d')!
    const font = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${size}px "${s.font}", Arial, sans-serif`
    ctx.font = font
    const lines = clip.text.split('\n')
    const lineH = Math.round(size * 1.2)
    const pad = Math.ceil(size * (s.background ? 0.25 : 0) + s.strokeWidth * size * 0.08 + 2)
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2
    const h = lineH * lines.length + pad * 2
    cv.width = Math.max(1, w)
    cv.height = Math.max(1, h)
    ctx.font = font
    ctx.textBaseline = 'middle'
    ctx.textAlign = s.align
    if (s.background) {
      ctx.fillStyle = s.background
      ctx.fillRect(0, 0, w, h)
    }
    const x = s.align === 'left' ? pad : s.align === 'right' ? w - pad : w / 2
    lines.forEach((line, i) => {
      const y = pad + lineH * i + lineH / 2
      if (s.strokeWidth > 0) {
        ctx.lineJoin = 'round'
        ctx.lineWidth = Math.max(1, s.strokeWidth * size * 0.08) * 2
        ctx.strokeStyle = s.strokeColor
        ctx.strokeText(line, x, y)
      }
      ctx.fillStyle = s.color
      ctx.fillText(line, x, y)
    })
    const gl = this.gl
    if (cached) gl.deleteTexture(cached.tex)
    const tex = this.tex2D()
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    const entry = { key, tex, w, h }
    this.textTex.set(clip.id, entry)
    return entry
  }

  private drawText(p: Project, clip: TextClip) {
    const t = this.textTexture(p, clip)
    const gl = this.gl
    const cx = this.width / 2 + (clip.transform.x * this.width) / 2
    const cy = this.height / 2 + (clip.transform.y * this.height) / 2
    const { prog, loc } = this.copyProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, quadMatrix(cx, cy, t.w, t.h, clip.transform.rotation))
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.uniform1i(loc.uSrc, 0)
    gl.uniform1f(loc.uOpacity, clip.transform.opacity)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private fullQuad(): Float32Array {
    return new Float32Array([this.width, 0, 0, 0, this.height, 0, 0, 0, 1])
  }

  private bindTarget(t: Target | null, clear: boolean) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null)
    gl.viewport(0, 0, this.width, this.height)
    if (clear) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  render(p: Project, layers: Layer[], sources: Map<string, FrameSource>, luts: Map<string, CubeLut>) {
    const gl = this.gl
    const acc = this.target(0)
    this.bindTarget(acc, false)
    const bg = p.canvas.background.replace('#', '')
    gl.clearColor(parseInt(bg.slice(0, 2), 16) / 255, parseInt(bg.slice(2, 4), 16) / 255, parseInt(bg.slice(4, 6), 16) / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    for (const layer of layers) {
      if (layer.kind === 'clip') {
        this.drawClip(p, layer.frame, sources.get(layer.frame.clip.id), luts)
      } else if (layer.kind === 'text') {
        this.drawText(p, layer.clip)
      } else {
        // Transición: A y B en capas propias, luego se mezclan sobre el acumulado.
        const ta = this.target(1)
        const tb = this.target(2)
        for (const [t, f] of [[ta, layer.a], [tb, layer.b]] as const) {
          this.bindTarget(t, false)
          gl.clearColor(0, 0, 0, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          this.drawClip(p, f, sources.get(f.clip.id), luts)
        }
        this.bindTarget(acc, false)
        const { prog, loc } = this.transProg
        gl.useProgram(prog)
        gl.uniformMatrix3fv(loc.uMatrix, false, this.fullQuad())
        gl.uniform2f(loc.uCanvas, this.width, this.height)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, ta.tex)
        gl.uniform1i(loc.uA, 0)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, tb.tex)
        gl.uniform1i(loc.uB, 1)
        gl.uniform1f(loc.uP, Math.min(1, Math.max(0, layer.progress)))
        gl.uniform1i(loc.uKind, Math.max(0, TRANSITION_KINDS.indexOf(layer.transition.kind)))
        gl.uniform2f(loc.uSize, this.width, this.height)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }

    // Copia el acumulado a pantalla (las texturas de FBO quedan con la Y invertida).
    gl.disable(gl.BLEND)
    this.bindTarget(null, false)
    const { prog, loc } = this.copyProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, new Float32Array([this.width, 0, 0, 0, -this.height, 0, 0, this.height, 1]))
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, acc.tex)
    gl.uniform1i(loc.uSrc, 0)
    gl.uniform1f(loc.uOpacity, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Libera texturas de clips que ya no existen. */
  prune(alive: Set<string>) {
    for (const map of [this.srcTex] as Map<string, WebGLTexture>[]) {
      for (const [id, tex] of map) if (!alive.has(id)) (this.gl.deleteTexture(tex), map.delete(id))
    }
    for (const map of [this.gradeTex, this.textTex] as Map<string, { tex: WebGLTexture }>[]) {
      for (const [id, v] of map) if (!alive.has(id)) (this.gl.deleteTexture(v.tex), map.delete(id))
    }
  }
}
