// Modelo de proyecto de Cancun. Los tiempos van en microsegundos (igual que los
// borradores de CapCut) para que convertir entre ambos formatos sea directo.

export const US = 1_000_000

export type Id = string

export type MediaKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio' | 'text'

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
  scale: number
  rotation: number
  opacity: number
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
}

export type BackgroundMode = 'none' | 'auto' | 'chroma'

export interface Background {
  mode: BackgroundMode
  chroma: { color: string; intensity: number; shadow: number }
  /** Ruta del video con canal alfa generado por la eliminación automática. */
  mattePath: string | null
}

export interface AudioFx {
  normalize: boolean
  denoise: boolean
  isolateVoice: boolean
  enhanceVoice: boolean
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

export interface Transition {
  kind: TransitionKind
  duration: number
}

interface ClipBase {
  id: Id
  start: number
  duration: number
  transform: Transform
}

export interface MediaClip extends ClipBase {
  type: 'media'
  mediaId: Id
  sourceIn: number
  speed: number
  /** Ganancia lineal: 1 = 0 dB. */
  volume: number
  fadeIn: number
  fadeOut: number
  color: Color
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

export type Clip = MediaClip | TextClip

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
  fps: number
  width: number
  height: number
  hardware: boolean
}

export interface Canvas {
  width: number
  height: number
  fps: number
  background: string
}

export interface Project {
  format: 'cancun'
  version: 1
  id: Id
  name: string
  createdAt: string
  updatedAt: string
  canvas: Canvas
  media: Record<Id, Media>
  /** Orden de dibujo: la pista 0 es la principal (abajo); las siguientes se superponen. */
  tracks: Track[]
  export: ExportSettings
}

export const defaultTransform = (): Transform => ({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 })

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

export const defaultRetouch = (): Retouch => ({ smooth: 0, whiten: 0, removeBlemishes: 0, evenTone: 0 })

export const defaultBackground = (): Background => ({
  mode: 'none',
  chroma: { color: '#00ff00', intensity: 0.4, shadow: 0.1 },
  mattePath: null
})

export const defaultAudioFx = (): AudioFx => ({
  normalize: false,
  denoise: false,
  isolateVoice: false,
  enhanceVoice: false
})

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

export function newId(): Id {
  return crypto.randomUUID()
}

export function newProject(name: string, width = 1920, height = 1080, fps = 30): Project {
  const now = new Date().toISOString()
  return {
    format: 'cancun',
    version: 1,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { width, height, fps, background: '#000000' },
    media: {},
    tracks: [
      { id: newId(), kind: 'video', name: 'Principal', muted: false, hidden: false, locked: false, clips: [] }
    ],
    export: { codec: 'h264', bitrate: null, fps, width, height, hardware: true }
  }
}

export const clipEnd = (c: Clip): number => c.start + c.duration

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

/** Tiempo de la fuente (µs) que corresponde al instante `t` de la línea de tiempo. */
export function sourceTime(c: MediaClip, t: number): number {
  return c.sourceIn + (t - c.start) * c.speed
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
