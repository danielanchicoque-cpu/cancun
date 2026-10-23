// Modelo de proyecto de Cancun. Los tiempos van en microsegundos (igual que los
// borradores de CapCut) para que convertir entre ambos formatos sea directo.

export const US = 1_000_000

export type Id = string

export type MediaKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio' | 'text' | 'effect'

export interface Media {
  id: Id
  kind: MediaKind
  path: string
  name: string
  duration: number
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  /** Matriz de color declarada en el archivo (bt709, bt470bg…); ausente = sin etiquetar. */
  colorSpace?: string
}

export interface Transform {
  /** Desplazamiento en fracción del lienzo: 0 = centro, ±1 = borde. */
  x: number
  y: number
  /** Escala (o escala X si `scaleY` no es null). */
  scale: number
  /** null = escala uniforme. */
  scaleY: number | null
  rotation: number
  opacity: number
  flipX: boolean
  flipY: boolean
}

/** Recorte en fracción del cuadro original (0..1 desde cada borde). */
export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export interface LutRef {
  path: string
  name: string
  /** 0..1, mezcla con la imagen original (el "Intensidad" de CapCut). */
  intensity: number
}

/** Todos los valores van de -1 a 1 (0 = sin cambio), como en el panel Ajustar de CapCut. */
export interface Adjust {
  brightness: number
  contrast: number
  saturation: number
  exposure: number
  temperature: number
  tint: number
  highlights: number
  shadows: number
  vignette: number
  sharpen: number
}

export interface Color {
  lut: LutRef | null
  adjust: Adjust
}

/** Retoque de piel/rostro, 0..1. */
export interface Retouch {
  smooth: number
  whiten: number
  removeBlemishes: number
  evenTone: number
  teeth: number
}

export type BackgroundMode = 'none' | 'auto' | 'chroma'

export interface Background {
  mode: BackgroundMode
  chroma: { color: string; intensity: number; shadow: number }
  /** Suavizado del borde del recorte automático, 0..1. */
  feather: number
  /** Desplaza el borde hacia dentro (+) o fuera (−), -1..1. */
  shrink: number
}

export interface AudioFx {
  normalize: boolean
  denoise: boolean
  isolateVoice: boolean
  enhanceVoice: boolean
}

export type BlendMode =
  | 'normal'
  | 'lighten'
  | 'screen'
  | 'colorDodge'
  | 'linearDodge'
  | 'darken'
  | 'multiply'
  | 'colorBurn'
  | 'linearBurn'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'difference'
  | 'exclusion'

export type MaskShape = 'none' | 'linear' | 'mirror' | 'circle' | 'rectangle' | 'heart' | 'star'

export interface Mask {
  shape: MaskShape
  /** Centro en fracción del clip (-1..1). */
  x: number
  y: number
  /** Tamaño en fracción del clip. */
  width: number
  height: number
  rotation: number
  feather: number
  roundness: number
  invert: boolean
}

/** "Adición de iluminación": una luz que se suma sobre el clip. */
export interface Light {
  enabled: boolean
  color: string
  intensity: number
  /** Posición de la luz en fracción del clip (-1..1). */
  x: number
  y: number
  radius: number
  /** Solo ilumina a la persona (usa la segmentación). */
  subjectOnly: boolean
}

export type TransitionKind =
  | 'fade'
  | 'dissolve'
  | 'fadeblack'
  | 'fadewhite'
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  | 'wipeleft'
  | 'wiperight'
  | 'circleopen'
  | 'circleclose'
  | 'zoomin'
  | 'radial'
  | 'pixelize'
  | 'smoothleft'
  | 'blur'
  | 'zoomblur'
  | 'spin'
  | 'glitch'
  | 'flash'
  | 'swirl'
  | 'cube'
  | 'pagecurl'
  | 'doorway'
  | 'ripple'
  | 'luma'
  | 'directionalwarp'
  | 'crosswarp'
  | 'squeeze'
  | 'morph'
  | 'burn'
  | 'colorphase'
  | 'windowslice'
  | 'mosaic'
  | 'heart'

export interface Transition {
  kind: TransitionKind
  duration: number
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe {
  /** Tiempo relativo al inicio del clip (µs). */
  t: number
  v: number
  ease: Easing
}

/** Propiedades animables con keyframes (ruta dentro del clip). */
export type KeyProp =
  | 'transform.x'
  | 'transform.y'
  | 'transform.scale'
  | 'transform.scaleY'
  | 'transform.rotation'
  | 'transform.opacity'
  | 'volume'
  | 'color.lut.intensity'
  | `color.adjust.${keyof Adjust}`
  | 'mask.x'
  | 'mask.y'
  | 'mask.width'
  | 'mask.height'
  | 'mask.rotation'
  | 'mask.feather'
  | 'light.intensity'
  | 'light.x'
  | 'light.y'

export type Keyframes = Partial<Record<KeyProp, Keyframe[]>>

export interface Animation {
  name: string
  duration: number
}

export interface Animations {
  in: Animation | null
  out: Animation | null
  /** Se repite durante todo el clip. */
  combo: Animation | null
}

interface ClipBase {
  id: Id
  start: number
  duration: number
  transform: Transform
  keyframes: Keyframes
  animations: Animations
  blend: BlendMode
}

export interface MediaClip extends ClipBase {
  type: 'media'
  mediaId: Id
  sourceIn: number
  speed: number
  /** Muestra un solo cuadro (el de `sourceIn`) durante todo el clip. */
  freeze: boolean
  /** Ganancia lineal: 1 = 0 dB. */
  volume: number
  fadeIn: number
  fadeOut: number
  color: Color
  crop: Crop
  mask: Mask
  light: Light
  retouch: Retouch
  background: Background
  audioFx: AudioFx
  /** Transición hacia el siguiente clip contiguo de la misma pista. */
  transition: Transition | null
}

export interface TextStyle {
  font: string
  size: number
  color: string
  strokeColor: string
  strokeWidth: number
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  background: string | null
}

export interface TextClip extends ClipBase {
  type: 'text'
  text: string
  style: TextStyle
}

/** Efecto visual de la pestaña Efectos: se aplica a todo lo que queda debajo. */
export interface EffectClip extends ClipBase {
  type: 'effect'
  effect: string
  /** Parámetros del efecto, 0..1. */
  params: Record<string, number>
}

export type Clip = MediaClip | TextClip | EffectClip

export interface Track {
  id: Id
  kind: TrackKind
  name: string
  muted: boolean
  hidden: boolean
  locked: boolean
  clips: Clip[]
}

export type VideoCodec = 'h264' | 'hevc'

export interface ExportSettings {
  codec: VideoCodec
  /** kbps; null = automático según resolución. */
  bitrate: number | null
  rateControl: 'vbr' | 'cbr'
  fps: number
  width: number
  height: number
  hardware: boolean
  format: 'mp4' | 'mov'
}

export interface Canvas {
  width: number
  height: number
  fps: number
  background: string
}

export interface EditorSettings {
  /** Imán de la pista principal: los clips quedan pegados sin huecos. */
  mainMagnet: boolean
  /** Ajuste automático a bordes y al cursor al arrastrar. */
  snap: boolean
  /** Vinculación: los clips de arriba se mueven con el clip principal que tienen debajo. */
  linkage: boolean
}

export interface Project {
  format: 'cancun'
  version: 2
  id: Id
  name: string
  createdAt: string
  updatedAt: string
  canvas: Canvas
  settings: EditorSettings
  media: Record<Id, Media>
  /** Orden de dibujo: la pista 0 es la principal (abajo); las siguientes se superponen. */
  tracks: Track[]
  export: ExportSettings
}

export const defaultTransform = (): Transform => ({
  x: 0,
  y: 0,
  scale: 1,
  scaleY: null,
  rotation: 0,
  opacity: 1,
  flipX: false,
  flipY: false
})

export const defaultAdjust = (): Adjust => ({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  vignette: 0,
  sharpen: 0
})

export const defaultCrop = (): Crop => ({ left: 0, top: 0, right: 0, bottom: 0 })

export const defaultMask = (): Mask => ({
  shape: 'none',
  x: 0,
  y: 0,
  width: 0.6,
  height: 0.6,
  rotation: 0,
  feather: 0.05,
  roundness: 0,
  invert: false
})

export const defaultLight = (): Light => ({
  enabled: false,
  color: '#ffd9a8',
  intensity: 0.5,
  x: -0.4,
  y: -0.4,
  radius: 0.8,
  subjectOnly: true
})

export const defaultRetouch = (): Retouch => ({ smooth: 0, whiten: 0, removeBlemishes: 0, evenTone: 0, teeth: 0 })

export const defaultBackground = (): Background => ({
  mode: 'none',
  chroma: { color: '#00ff00', intensity: 0.4, shadow: 0.1 },
  feather: 0.3,
  shrink: 0
})

export const defaultAudioFx = (): AudioFx => ({
  normalize: false,
  denoise: false,
  isolateVoice: false,
  enhanceVoice: false
})

export const defaultAnimations = (): Animations => ({ in: null, out: null, combo: null })

export const defaultTextStyle = (): TextStyle => ({
  font: 'Arial',
  size: 72,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0,
  bold: true,
  italic: false,
  align: 'center',
  background: null
})

export const defaultSettings = (): EditorSettings => ({ mainMagnet: true, snap: true, linkage: true })

export function newId(): Id {
  return crypto.randomUUID()
}

export function newProject(name: string, width = 1920, height = 1080, fps = 30): Project {
  const now = new Date().toISOString()
  return {
    format: 'cancun',
    version: 2,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { width, height, fps, background: '#000000' },
    settings: defaultSettings(),
    media: {},
    tracks: [
      { id: newId(), kind: 'video', name: 'Principal', muted: false, hidden: false, locked: false, clips: [] }
    ],
    export: { codec: 'h264', bitrate: null, rateControl: 'vbr', fps, width, height, hardware: true, format: 'mp4' }
  }
}

/** Completa campos que faltan en proyectos guardados con versiones anteriores. */
export function normalizeProject(raw: Project): Project {
  const p = raw as Project & { version: number }
  p.version = 2
  p.settings = { ...defaultSettings(), ...p.settings }
  p.export = Object.assign({ rateControl: 'vbr', format: 'mp4' }, p.export)
  for (const t of p.tracks) {
    for (const c of t.clips as Clip[]) {
      c.transform = { ...defaultTransform(), ...c.transform }
      c.keyframes ??= {}
      c.animations = { ...defaultAnimations(), ...c.animations }
      c.blend ??= 'normal'
      if (c.type === 'media') {
        c.freeze ??= false
        c.crop = { ...defaultCrop(), ...c.crop }
        c.mask = { ...defaultMask(), ...c.mask }
        c.light = { ...defaultLight(), ...c.light }
        c.retouch = { ...defaultRetouch(), ...c.retouch }
        c.background = { ...defaultBackground(), ...c.background }
      }
    }
  }
  return p
}

export const clipEnd = (c: Clip): number => c.start + c.duration

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

/** Tiempo de la fuente (µs) que corresponde al instante `t` de la línea de tiempo. */
export function sourceTime(c: MediaClip, t: number): number {
  return c.freeze ? c.sourceIn : c.sourceIn + (t - c.start) * c.speed
}

/** Bitrate automático en kbps, parecido al "Recomendado" de CapCut. */
export function autoBitrate(width: number, height: number, fps: number): number {
  const pixels = width * height
  const base = pixels >= 3840 * 2160 ? 40000 : pixels >= 2560 * 1440 ? 24000 : pixels >= 1920 * 1080 ? 12000 : 6000
  return Math.round(base * (fps > 30 ? 1.5 : 1))
}

export function findClip(p: Project, clipId: Id): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return null
}
