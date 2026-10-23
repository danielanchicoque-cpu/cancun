// Compositor WebGL2 de Cancun. Lo usan la vista previa y la exportación, así que lo
// que se ve es exactamente lo que se exporta. Cada clip se dibuja con su propio
// procesamiento (color, retoque, fondo, máscara, luz) y se compone con su modo de
// mezcla; los efectos se aplican después sobre todo lo de debajo.

import { BAKE_SIZE, bakeGrade, isNeutral } from '@shared/color'
import type { CubeLut } from '@shared/cube'
import { type EffectClip, type MediaClip, type Project, type TextClip, US, defaultAdjust } from '@shared/project'
import type { ClipFrame, Layer } from '@shared/timeline'
import { BLEND_FS, BLEND_MODES, COPY_FS, EFFECTS, EFFECT_FS, LAYER_FS, QUAD_VS, TRANSITION_FS, TRANSITION_KINDS, YUV_FS } from './shaders'

type Program = { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }

interface Target {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
}

export type FrameSource = HTMLVideoElement | HTMLImageElement | VideoFrame | ImageBitmap | ImageData

/** Máscaras de segmentación por clip: r = persona, g = piel. */
export type SegSource = TexImageSource

const MASK_SHAPES = ['none', 'linear', 'mirror', 'circle', 'rectangle', 'heart', 'star']

function sourceSize(src: FrameSource): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight]
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight]
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return [src.displayWidth, src.displayHeight]
  if (src instanceof ImageData) return [src.width, src.height]
  return [(src as ImageBitmap).width, (src as ImageBitmap).height]
}

function sourceReady(src: FrameSource): boolean {
  if (src instanceof HTMLVideoElement) return src.readyState >= 2 && src.videoWidth > 0
  if (src instanceof HTMLImageElement) return src.complete && src.naturalWidth > 0
  return true
}

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
  return new Float32Array([
    cos * w, sin * w, 0,
    -sin * h, cos * h, 0,
    cx - 0.5 * (cos * w - sin * h), cy - 0.5 * (sin * w + cos * h), 1
  ])
}

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
}

export interface ClipGeometry {
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
}

/** Rectángulo que ocupa un clip en el lienzo (en píxeles del lienzo del proyecto). */
export function clipGeometry(p: Project, clip: MediaClip, mw: number, mh: number): ClipGeometry {
  const t = clip.transform
  const cw = mw * (1 - clip.crop.left - clip.crop.right)
  const ch = mh * (1 - clip.crop.top - clip.crop.bottom)
  const fit = Math.min(p.canvas.width / mw, p.canvas.height / mh)
  return {
    cx: p.canvas.width / 2 + (t.x * p.canvas.width) / 2,
    cy: p.canvas.height / 2 + (t.y * p.canvas.height) / 2,
    w: Math.max(1, cw * fit * t.scale),
    h: Math.max(1, ch * fit * (t.scaleY ?? t.scale)),
    rotation: t.rotation
  }
}

export class Compositor {
  private gl: WebGL2RenderingContext
  private layerProg: Program
  private copyProg: Program
  private blendProg: Program
  private effectProg: Program
  private transProg: Program
  private yuvProg: Program
  private targets = new Map<string, Target>()
  private width = 0
  private height = 0
  private srcTex = new Map<string, WebGLTexture>()
  private segTex = new Map<string, WebGLTexture>()
  private gradeTex = new Map<string, { key: string; tex: WebGLTexture }>()
  private textTex = new Map<string, { key: string; tex: WebGLTexture; w: number; h: number }>()
  private identity: WebGLTexture
  private blank: WebGLTexture
  /** Escala del lienzo de vista previa respecto al del proyecto. */
  private scale = 1

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 no está disponible')
    this.gl = gl
    const common = ['uMatrix', 'uCanvas']
    this.layerProg = compile(gl, QUAD_VS, LAYER_FS, [
      ...common, 'uSrc', 'uOpacity', 'uGrade', 'uSeg', 'uHasSeg', 'uUseGrade', 'uGradeSize', 'uCrop', 'uFlip', 'uTexel', 'uClipPx',
      'uSharpen', 'uVignette', 'uChroma', 'uKey', 'uKeyIntensity', 'uKeyShadow', 'uRemoveBg', 'uBgFeather', 'uBgShrink', 'uRetouch',
      'uMaskShape', 'uMaskRect', 'uMaskParams', 'uMaskInvert', 'uLight', 'uLightColor', 'uLightParams', 'uLightSubject'
    ])
    this.copyProg = compile(gl, QUAD_VS, COPY_FS, [...common, 'uSrc', 'uOpacity', 'uFlipY'])
    this.blendProg = compile(gl, QUAD_VS, BLEND_FS, [...common, 'uBase', 'uLayer', 'uMode'])
    this.effectProg = compile(gl, QUAD_VS, EFFECT_FS, [...common, 'uSrc', 'uEffect', 'uTime', 'uIntensity', 'uSpeed', 'uSize'])
    this.transProg = compile(gl, QUAD_VS, TRANSITION_FS, [...common, 'uA', 'uB', 'uP', 'uKind', 'uSize'])
    this.yuvProg = compile(gl, QUAD_VS, YUV_FS, [...common, 'uSrc', 'uSize', 'uPlane'])

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    this.identity = this.make3D(bakeGrade(defaultAdjust(), null, 0, 2), 2)
    this.blank = this.tex2D()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]))
  }

  /** `w`,`h` = tamaño de salida; `projectWidth` = ancho del lienzo del proyecto. */
  resize(w: number, h: number, projectWidth: number) {
    this.scale = w / projectWidth
    if (w === this.width && h === this.height) return
    const gl = this.gl
    this.width = this.canvas.width = w
    this.height = this.canvas.height = h
    for (const t of this.targets.values()) {
      gl.deleteFramebuffer(t.fbo)
      gl.deleteTexture(t.tex)
    }
    this.targets.clear()
  }

  private target(name: string, w = this.width, h = this.height): Target {
    const existing = this.targets.get(name)
    if (existing && existing.w === w && existing.h === h) return existing
    const gl = this.gl
    const tex = this.tex2D()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const t = { fbo, tex, w, h }
    this.targets.set(name, t)
    return t
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
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes)
    return tex
  }

  /** Textura 3D del color de un clip; se rehornea solo cuando cambia el ajuste. */
  private gradeFor(clip: MediaClip, luts: Map<string, CubeLut>): WebGLTexture | null {
    const lut = clip.color.lut
    const lutData = lut ? luts.get(lut.path) ?? null : null
    if (!lutData && isNeutral(clip.color.adjust)) return null
    // Con keyframes de color el valor cambia cada cuadro: se redondea para no rehornear de más.
    const r = (v: number) => Math.round(v * 200) / 200
    const adj = Object.fromEntries(Object.entries(clip.color.adjust).map(([k, v]) => [k, r(v)])) as unknown as typeof clip.color.adjust
    const key = JSON.stringify([adj, lut?.path, r(lut?.intensity ?? 0), Boolean(lutData)])
    const cached = this.gradeTex.get(clip.id)
    if (cached?.key === key) return cached.tex
    if (cached) this.gl.deleteTexture(cached.tex)
    const tex = this.make3D(bakeGrade(adj, lutData, r(lut?.intensity ?? 0)), BAKE_SIZE)
    this.gradeTex.set(clip.id, { key, tex })
    return tex
  }

  private upload(id: string, src: TexImageSource, map: Map<string, WebGLTexture>, mipmap = false): WebGLTexture {
    const gl = this.gl
    let tex = map.get(id)
    if (!tex) {
      tex = this.tex2D()
      map.set(id, tex)
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    if (mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    return tex
  }

  /** Dibuja un clip en el destino actual. */
  private drawClip(p: Project, f: ClipFrame, src: FrameSource | undefined, seg: SegSource | undefined, luts: Map<string, CubeLut>) {
    const c = f.clip
    if (!src) return
    if (!sourceReady(src)) {
      if (!this.srcTex.has(c.id)) return
    } else {
      this.upload(c.id, src, this.srcTex, c.retouch.evenTone > 0)
    }
    const gl = this.gl
    const media = p.media[c.mediaId]
    const [sw, sh] = sourceSize(src)
    const mw = media.width ?? sw
    const mh = media.height ?? sh
    const g = clipGeometry(p, c, mw, mh)
    const s = this.scale
    const { prog, loc } = this.layerProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, quadMatrix(g.cx * s, g.cy * s, g.w * s, g.h * s, g.rotation))
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
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, seg ? this.upload(c.id, seg, this.segTex) : this.blank)
    gl.uniform1i(loc.uSeg, 2)
    gl.uniform1i(loc.uHasSeg, seg ? 1 : 0)
    gl.uniform1f(loc.uOpacity, Math.max(0, Math.min(1, c.transform.opacity)))
    gl.uniform4f(loc.uCrop, c.crop.left, c.crop.top, c.crop.right, c.crop.bottom)
    gl.uniform2f(loc.uFlip, c.transform.flipX ? 1 : 0, c.transform.flipY ? 1 : 0)
    gl.uniform2f(loc.uTexel, 1 / Math.max(1, sw), 1 / Math.max(1, sh))
    gl.uniform2f(loc.uClipPx, g.w * s, g.h * s)
    gl.uniform1f(loc.uSharpen, c.color.adjust.sharpen)
    gl.uniform1f(loc.uVignette, c.color.adjust.vignette)
    gl.uniform1i(loc.uChroma, c.background.mode === 'chroma' ? 1 : 0)
    gl.uniform3f(loc.uKey, ...hexRgb(c.background.chroma.color))
    gl.uniform1f(loc.uKeyIntensity, c.background.chroma.intensity)
    gl.uniform1f(loc.uKeyShadow, c.background.chroma.shadow)
    gl.uniform1i(loc.uRemoveBg, c.background.mode === 'auto' && seg ? 1 : 0)
    gl.uniform1f(loc.uBgFeather, c.background.feather)
    gl.uniform1f(loc.uBgShrink, c.background.shrink)
    gl.uniform4f(loc.uRetouch, c.retouch.smooth, c.retouch.whiten, c.retouch.removeBlemishes, c.retouch.evenTone)
    const m = c.mask
    gl.uniform1i(loc.uMaskShape, Math.max(0, MASK_SHAPES.indexOf(m.shape)))
    gl.uniform4f(loc.uMaskRect, m.x, m.y, m.width, m.height)
    gl.uniform3f(loc.uMaskParams, (m.rotation * Math.PI) / 180, m.feather, m.roundness)
    gl.uniform1i(loc.uMaskInvert, m.invert ? 1 : 0)
    gl.uniform1i(loc.uLight, c.light.enabled ? 1 : 0)
    gl.uniform3f(loc.uLightColor, ...hexRgb(c.light.color))
    gl.uniform4f(loc.uLightParams, c.light.x, c.light.y, c.light.radius, c.light.intensity)
    gl.uniform1i(loc.uLightSubject, c.light.subjectOnly ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private textTexture(p: Project, clip: TextClip) {
    const s = clip.style
    const size = Math.max(4, Math.round(s.size * (p.canvas.height / 1080) * this.scale))
    const key = JSON.stringify([clip.text, s, size])
    const cached = this.textTex.get(clip.id)
    if (cached?.key === key) return cached
    const cv = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)
    let ctx = cv.getContext('2d') as CanvasRenderingContext2D
    const font = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${size}px "${s.font}", Arial, sans-serif`
    ctx.font = font
    const lines = clip.text.split('\n')
    const lineH = Math.round(size * 1.2)
    const pad = Math.ceil(size * (s.background ? 0.25 : 0) + s.strokeWidth * size * 0.08 + 2)
    const w = Math.ceil(Math.max(1, ...lines.map((l) => ctx.measureText(l).width))) + pad * 2
    const h = lineH * lines.length + pad * 2
    cv.width = Math.max(1, w)
    cv.height = Math.max(1, h)
    ctx = cv.getContext('2d') as CanvasRenderingContext2D
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv as TexImageSource)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    const entry = { key, tex, w, h }
    this.textTex.set(clip.id, entry)
    return entry
  }

  /** Tamaño del texto en píxeles del lienzo del proyecto (para el recuadro de selección). */
  textSize(p: Project, clip: TextClip): [number, number] {
    const t = this.textTexture(p, clip)
    return [(t.w / this.scale) * clip.transform.scale, (t.h / this.scale) * (clip.transform.scaleY ?? clip.transform.scale)]
  }

  private drawText(p: Project, clip: TextClip) {
    const t = this.textTexture(p, clip)
    const gl = this.gl
    const s = this.scale
    const cx = (p.canvas.width / 2 + (clip.transform.x * p.canvas.width) / 2) * s
    const cy = (p.canvas.height / 2 + (clip.transform.y * p.canvas.height) / 2) * s
    const { prog, loc } = this.copyProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, quadMatrix(cx, cy, t.w * clip.transform.scale, t.h * (clip.transform.scaleY ?? clip.transform.scale), clip.transform.rotation))
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.uniform1i(loc.uSrc, 0)
    gl.uniform1f(loc.uOpacity, Math.max(0, Math.min(1, clip.transform.opacity)))
    gl.uniform1i(loc.uFlipY, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private fullQuad(): Float32Array {
    return new Float32Array([this.width, 0, 0, 0, this.height, 0, 0, 0, 1])
  }

  private bind(t: Target | null, clear?: [number, number, number, number]) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null)
    gl.viewport(0, 0, t ? t.w : this.width, t ? t.h : this.height)
    if (clear) {
      gl.clearColor(...clear)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  private acc = 'accA'
  private swapAcc(): Target {
    this.acc = this.acc === 'accA' ? 'accB' : 'accA'
    return this.target(this.acc)
  }

  /** Dibuja una capa: normal va directo con mezcla de GL; otros modos pasan por el shader de mezcla. */
  private composite(blend: string, draw: () => void) {
    const gl = this.gl
    const mode = BLEND_MODES.indexOf(blend as (typeof BLEND_MODES)[number])
    if (mode <= 0) {
      this.bind(this.target(this.acc))
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      draw()
      return
    }
    const layer = this.target('layer')
    this.bind(layer, [0, 0, 0, 0])
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    draw()
    gl.disable(gl.BLEND)
    const base = this.target(this.acc)
    const out = this.swapAcc()
    this.bind(out)
    const { prog, loc } = this.blendProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, this.fullQuad())
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, base.tex)
    gl.uniform1i(loc.uBase, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, layer.tex)
    gl.uniform1i(loc.uLayer, 1)
    gl.uniform1i(loc.uMode, mode)
    // Las texturas de FBO están invertidas en Y, igual en ambas: se lee y escribe sin voltear.
    gl.uniformMatrix3fv(loc.uMatrix, false, new Float32Array([this.width, 0, 0, 0, -this.height, 0, 0, this.height, 1]))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private applyEffect(clip: EffectClip, local: number) {
    const gl = this.gl
    const idx = EFFECTS.findIndex((e) => e.id === clip.effect)
    if (idx < 0) return
    gl.disable(gl.BLEND)
    const src = this.target(this.acc)
    const out = this.swapAcc()
    this.bind(out)
    const { prog, loc } = this.effectProg
    gl.useProgram(prog)
    // vUv con y=0 arriba; el shader del efecto voltea al leer.
    gl.uniformMatrix3fv(loc.uMatrix, false, this.fullQuad())
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(loc.uSrc, 0)
    gl.uniform1i(loc.uEffect, idx)
    gl.uniform1f(loc.uTime, local / US)
    gl.uniform1f(loc.uIntensity, clip.params.intensity ?? 0.6)
    gl.uniform1f(loc.uSpeed, clip.params.speed ?? 0.5)
    gl.uniform2f(loc.uSize, this.width, this.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  render(
    p: Project,
    layers: Layer[],
    sources: Map<string, FrameSource>,
    luts: Map<string, CubeLut>,
    segs: Map<string, SegSource> = new Map()
  ) {
    const gl = this.gl
    this.acc = 'accA'
    this.bind(this.target(this.acc), [...hexRgb(p.canvas.background), 1])

    for (const layer of layers) {
      if (layer.kind === 'clip') {
        const f = layer.frame
        this.composite(f.clip.blend, () => this.drawClip(p, f, sources.get(f.clip.id), segs.get(f.clip.id), luts))
      } else if (layer.kind === 'text') {
        this.composite(layer.clip.blend, () => this.drawText(p, layer.clip))
      } else if (layer.kind === 'effect') {
        this.applyEffect(layer.clip, layer.local)
      } else {
        // Transición: A y B en capas propias, luego se mezclan sobre el acumulado.
        const ta = this.target('trA')
        const tb = this.target('trB')
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        for (const [t, f] of [[ta, layer.a], [tb, layer.b]] as const) {
          this.bind(t, [...hexRgb(p.canvas.background), 1])
          this.drawClip(p, f, sources.get(f.clip.id), segs.get(f.clip.id), luts)
        }
        this.bind(this.target(this.acc))
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
        gl.uniform1i(loc.uKind, Math.max(0, TRANSITION_KINDS.indexOf(layer.transition.kind as (typeof TRANSITION_KINDS)[number])))
        gl.uniform2f(loc.uSize, this.width, this.height)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }

    // Copia el acumulado a pantalla (las texturas de FBO quedan con la Y invertida).
    gl.disable(gl.BLEND)
    this.bind(null)
    const { prog, loc } = this.copyProg
    gl.useProgram(prog)
    gl.uniformMatrix3fv(loc.uMatrix, false, new Float32Array([this.width, 0, 0, 0, -this.height, 0, 0, this.height, 1]))
    gl.uniform2f(loc.uCanvas, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.target(this.acc).tex)
    gl.uniform1i(loc.uSrc, 0)
    gl.uniform1f(loc.uOpacity, 1)
    gl.uniform1i(loc.uFlipY, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** El último cuadro en YUV 4:2:0 (planos Y, U, V seguidos). El ancho debe ser múltiplo de 8. */
  readYUV(): Uint8Array {
    const gl = this.gl
    const W = this.width
    const H = this.height
    const out = new Uint8Array(W * H * 1.5)
    const src = this.target(this.acc)
    const planes: [number, number, number, number][] = [
      [0, W / 4, H, 0],
      [1, W / 8, H / 2, W * H],
      [2, W / 8, H / 2, W * H * 1.25]
    ]
    gl.disable(gl.BLEND)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    const { prog, loc } = this.yuvProg
    for (const [plane, pw, ph, offset] of planes) {
      const t = this.target(`yuv${plane}`, pw, ph)
      this.bind(t)
      gl.useProgram(prog)
      gl.uniformMatrix3fv(loc.uMatrix, false, new Float32Array([pw, 0, 0, 0, ph, 0, 0, 0, 1]))
      gl.uniform2f(loc.uCanvas, pw, ph)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src.tex)
      gl.uniform1i(loc.uSrc, 0)
      gl.uniform2f(loc.uSize, W, H)
      gl.uniform1i(loc.uPlane, plane)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, out.subarray(offset, offset + pw * ph * 4))
    }
    return out
  }

  /** Libera texturas de clips que ya no existen. */
  prune(alive: Set<string>) {
    for (const map of [this.srcTex, this.segTex]) {
      for (const [id, tex] of map) if (!alive.has(id)) (this.gl.deleteTexture(tex), map.delete(id))
    }
    for (const map of [this.gradeTex, this.textTex] as Map<string, { tex: WebGLTexture }>[]) {
      for (const [id, v] of map) if (!alive.has(id)) (this.gl.deleteTexture(v.tex), map.delete(id))
    }
  }
}
