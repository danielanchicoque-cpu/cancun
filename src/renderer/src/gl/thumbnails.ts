// Miniaturas de transiciones y efectos, dibujadas con los mismos shaders del compositor
// sobre fotos de muestra. Son cuadradas (como en CapCut). La imagen fija se genera en
// segundo plano, de a pocas por cuadro, y se guarda entre sesiones; al pasar el mouse
// se anima en vivo copiando el lienzo WebGL a la miniatura (sin codificar imágenes).

import { mediaUrl } from '../api'
import { EFFECTS, EFFECT_FS, QUAD_VS, TRANSITION_FS, TRANSITION_KINDS } from './shaders'

const W = 160
const H = 160
/** Cambiar cuando cambien los shaders o las fotos: invalida las miniaturas guardadas. */
const CACHE_VERSION = 'thumbs-v4'

/** Fotos de muestra propias (generadas para Cancun) sobre las que se ven transiciones y efectos. */
const SAMPLE_NAMES = ['chico-gafas', 'casa-blanca', 'mujer-sonrisa', 'auto-clasico', 'faro-isla', 'montana-nieve', 'ciudad-atardecer', 'retrato-nina'] as const
const images = new Map<string, HTMLImageElement>()
let loading: Promise<void> | null = null

/** Carga las fotos de muestra (una vez). */
export function loadSamples(): Promise<void> {
  loading ??= window.cancun.paths.app().then((root: string) => Promise.all(
    SAMPLE_NAMES.map(
      (n) =>
        new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => {
            images.set(n, img)
            resolve()
          }
          img.onerror = () => resolve()
          // Por media:// (con CORS) para poder leer sus píxeles en WebGL y en el canvas.
          img.crossOrigin = 'anonymous'
          img.src = mediaUrl(`${root.split('\\').join('/')}/resources/samples/${n}.jpg`)
        })
    )
  )).then(() => undefined)
  return loading
}

export const samplesReady = () => images.size > 0

/** La foto de muestra ya cargada (para las miniaturas de los LUT). */
export const sampleImage = (name: string) => images.get(name)

const PAIRS: [string, string][] = [
  ['chico-gafas', 'casa-blanca'],
  ['auto-clasico', 'faro-isla'],
  ['mujer-sonrisa', 'ciudad-atardecer'],
  ['montana-nieve', 'chico-gafas'],
  ['casa-blanca', 'auto-clasico'],
  ['faro-isla', 'mujer-sonrisa']
]
const EFFECT_SAMPLES = ['mujer-sonrisa', 'chico-gafas', 'ciudad-atardecer', 'retrato-nina']
export const THUMB_FRAMES = 16

let ctx: {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  trans: { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }
  effect: { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }
  tex: (name: string) => WebGLTexture
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
  const cache = new Map<string, WebGLTexture>()
  const fallback = [tex(sample('#1f6f86', '#0d2a36', '')), tex(sample('#d88a3c', '#6a2c4a', ''))]
  ctx = {
    gl,
    canvas,
    trans: compile(TRANSITION_FS, [...common, 'uA', 'uB', 'uP', 'uKind']),
    effect: compile(EFFECT_FS, [...common, 'uSrc', 'uEffect', 'uTime', 'uIntensity', 'uSpeed']),
    tex(name: string) {
      let t = cache.get(name)
      if (!t) {
        const img = images.get(name)
        if (!img) return fallback[name.length % 2]
        // Recorta la foto al centro, al formato de la miniatura (sin deformarla).
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const k = Math.max(W / img.naturalWidth, H / img.naturalHeight)
        const sw = W / k
        const sh = H / k
        c.getContext('2d')!.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H)
        t = tex(c)
        cache.set(name, t)
      }
      return t
    }
  }
  return ctx
}

function draw(kind: 'transition' | 'effect', index: number, value: number): HTMLCanvasElement {
  const pair = PAIRS[index % PAIRS.length]
  const single = EFFECT_SAMPLES[index % EFFECT_SAMPLES.length]
  const c = setup()
  const { gl } = c
  const p = kind === 'transition' ? c.trans : c.effect
  gl.viewport(0, 0, W, H)
  gl.useProgram(p.prog)
  gl.uniformMatrix3fv(p.loc.uMatrix, false, new Float32Array([W, 0, 0, 0, H, 0, 0, 0, 1]))
  gl.uniform2f(p.loc.uCanvas, W, H)
  gl.uniform2f(p.loc.uSize, W, H)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, c.tex(kind === 'transition' ? pair[0] : single))
  if (kind === 'transition') {
    gl.uniform1i(p.loc.uA, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, c.tex(pair[1]))
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
  return c.canvas
}

const indexOf = (kind: 'transition' | 'effect', id: string) =>
  kind === 'transition' ? TRANSITION_KINDS.indexOf(id as never) : EFFECTS.findIndex((e) => e.id === id)

/** Valor del shader para la imagen fija y para el cuadro `u` (0..1) de la animación. */
const STILL_VALUE = { transition: 0.3, effect: 0.6 }
const animValue = (kind: 'transition' | 'effect', u: number) => (kind === 'transition' ? 0.08 + 0.84 * u : u * 2)

/** Dibuja el cuadro `u` de la animación en un lienzo 2D (al pasar el mouse). */
export function drawThumbFrame(kind: 'transition' | 'effect', id: string, u: number, target: CanvasRenderingContext2D) {
  const src = draw(kind, indexOf(kind, id), animValue(kind, u))
  target.drawImage(src, 0, 0, target.canvas.width, target.canvas.height)
}

// --- Imágenes fijas: memoria + localStorage, generadas de a pocas en segundo plano ----------
const stills = new Map<string, string>()
const pending = new Map<string, ((url: string) => void)[]>()
const queue: { key: string; kind: 'transition' | 'effect'; id: string }[] = []
let pumping = false

const storageKey = (key: string) => `cancun.${CACHE_VERSION}.${key}`

/** La imagen fija si ya existe (memoria o guardada), sin generar nada. */
export function cachedStill(kind: 'transition' | 'effect', id: string): string | null {
  const key = `${kind}:${id}`
  let url = stills.get(key) ?? null
  if (!url) {
    try {
      url = localStorage.getItem(storageKey(key))
    } catch {
      url = null
    }
    if (url) stills.set(key, url)
  }
  return url
}

function pump() {
  if (pumping) return
  pumping = true
  const step = () => {
    // Unas pocas por cuadro: la interfaz sigue fluida mientras se llenan.
    const until = performance.now() + 8
    while (queue.length && performance.now() < until) {
      const { key, kind, id } = queue.shift()!
      const url = draw(kind, indexOf(kind, id), STILL_VALUE[kind]).toDataURL('image/jpeg', 0.82)
      stills.set(key, url)
      try {
        localStorage.setItem(storageKey(key), url)
      } catch {
        // Sin espacio: queda solo en memoria.
      }
      for (const cb of pending.get(key) ?? []) cb(url)
      pending.delete(key)
    }
    if (queue.length) requestAnimationFrame(step)
    else pumping = false
  }
  requestAnimationFrame(step)
}

/** Pide la imagen fija; llega enseguida si está guardada, si no en cuanto se genere. */
export function requestStill(kind: 'transition' | 'effect', id: string, cb: (url: string) => void): () => void {
  const hit = cachedStill(kind, id)
  if (hit) {
    cb(hit)
    return () => undefined
  }
  const key = `${kind}:${id}`
  const list = pending.get(key)
  if (list) list.push(cb)
  else {
    pending.set(key, [cb])
    // Las fotos de muestra tienen que estar cargadas para que la miniatura sea la buena.
    void loadSamples().then(() => {
      queue.push({ key, kind, id })
      pump()
    })
  }
  return () => {
    const l = pending.get(key)
    if (l) l.splice(l.indexOf(cb) >>> 0, 1)
  }
}

// --- Miniaturas de LUT: la foto de muestra con el LUT aplicado y una carta de color ---

const lutCache = new Map<string, Promise<string>>()
const CHIPS = ['#e23b3b', '#f08a24', '#f5d33b', '#4fbf4a', '#2fa3e0', '#5a4fd6', '#d24fb0', '#8a5a3c']

export function lutThumb(path: string, load: (p: string) => Promise<{ size: number; domainMin: [number, number, number]; domainMax: [number, number, number]; data: Float32Array }>): Promise<string> {
  let pr = lutCache.get(path)
  if (!pr) {
    pr = (async () => {
      await loadSamples()
      const raw = await load(path)
      const { sampleCube } = await import('@shared/cube')
      const lut = { title: '', size: raw.size, domainMin: raw.domainMin, domainMax: raw.domainMax, data: new Float32Array(raw.data) }
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d')!
      const img = images.get('retrato-nina')
      if (img) g.drawImage(img, 0, 0, W, H)
      // Carta de color a la izquierda y escala de grises a la derecha, como referencia.
      CHIPS.forEach((col, i) => {
        g.fillStyle = col
        g.fillRect(8, 10 + i * 15, 12, 12)
      })
      for (let i = 0; i < 9; i++) {
        const v = Math.round((i / 8) * 255)
        g.fillStyle = `rgb(${v},${v},${v})`
        g.fillRect(W - 20, 10 + i * 14, 12, 14)
      }
      const px = g.getImageData(0, 0, W, H)
      const d = px.data
      for (let i = 0; i < d.length; i += 4) {
        const [r, gg, b] = sampleCube(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255)
        d[i] = r * 255
        d[i + 1] = gg * 255
        d[i + 2] = b * 255
      }
      g.putImageData(px, 0, 0)
      return c.toDataURL('image/jpeg', 0.85)
    })()
    lutCache.set(path, pr)
    pr.catch(() => lutCache.delete(path))
  }
  return pr
}
