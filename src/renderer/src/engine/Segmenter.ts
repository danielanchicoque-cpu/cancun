// Segmentación local con MediaPipe (modelo selfie multiclase, Apache 2.0). Corre en la
// GPU del equipo, sin nube. Devuelve una máscara pequeña por cuadro:
//   r = persona (para quitar el fondo y la luz), g = piel de cara y cuerpo (retoque).
// El compositor la refina a resolución completa guiándose por la imagen.

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import { mediaUrl } from '../api'

const SIZE = 256
// Clases del modelo multiclase.
const BACKGROUND = 0
const BODY_SKIN = 2
const FACE_SKIN = 3
/** Suavizado temporal: cuánto pesa el cuadro nuevo (evita parpadeo en los bordes). */
const TEMPORAL = 0.65

let shared: Promise<Segmenter> | null = null

export class Segmenter {
  private last = new Map<string, Float32Array>()
  private lastTs = 0

  private constructor(private seg: ImageSegmenter) {}

  static get(): Promise<Segmenter> {
    shared ??= (async () => {
      const root = (await window.cancun.paths.app()).replace(/\\/g, '/')
      const fileset = await FilesetResolver.forVisionTasks(mediaUrl(`${root}/node_modules/@mediapipe/tasks-vision/wasm`))
      const seg = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: mediaUrl(`${root}/resources/models/selfie_multiclass_256x256.tflite`), delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })
      return new Segmenter(seg)
    })()
    shared.catch(() => (shared = null))
    return shared
  }

  /**
   * Máscara RGBA de 256×256 para la fuente. `key` identifica el clip para suavizar en el
   * tiempo; `reset` descarta el historial (al saltar a otro punto).
   */
  segment(key: string, src: TexImageSource, reset = false): ImageData {
    // MediaPipe exige marcas de tiempo crecientes.
    this.lastTs = Math.max(this.lastTs + 1, Math.floor(performance.now()))
    const result = this.seg.segmentForVideo(src, this.lastTs)
    const masks = result.confidenceMasks ?? []
    const bg = masks[BACKGROUND]?.getAsFloat32Array()
    const body = masks[BODY_SKIN]?.getAsFloat32Array()
    const face = masks[FACE_SKIN]?.getAsFloat32Array()
    const w = masks[0]?.width ?? SIZE
    const h = masks[0]?.height ?? SIZE
    const n = w * h
    const prev = reset ? undefined : this.last.get(key)
    const cur = new Float32Array(n * 2)
    const img = new ImageData(w, h)
    for (let i = 0; i < n; i++) {
      let person = bg ? 1 - bg[i] : 1
      let skin = (body?.[i] ?? 0) + (face?.[i] ?? 0)
      if (prev && prev.length === n * 2) {
        person = prev[i * 2] + (person - prev[i * 2]) * TEMPORAL
        skin = prev[i * 2 + 1] + (skin - prev[i * 2 + 1]) * TEMPORAL
      }
      cur[i * 2] = person
      cur[i * 2 + 1] = skin
      img.data[i * 4] = Math.round(Math.min(1, person) * 255)
      img.data[i * 4 + 1] = Math.round(Math.min(1, skin) * 255)
      img.data[i * 4 + 3] = 255
    }
    for (const m of masks) m.close()
    this.last.set(key, cur)
    return img
  }

  forget(key: string) {
    this.last.delete(key)
  }
}

/** ¿Este clip necesita segmentación en este cuadro? */
export function needsSegmentation(clip: {
  background: { mode: string }
  retouch: { smooth: number; whiten: number; removeBlemishes: number; evenTone: number }
  light: { enabled: boolean; subjectOnly: boolean }
}): boolean {
  const r = clip.retouch
  return (
    clip.background.mode === 'auto' ||
    r.smooth > 0 ||
    r.whiten > 0 ||
    r.removeBlemishes > 0 ||
    r.evenTone > 0 ||
    (clip.light.enabled && clip.light.subjectOnly)
  )
}
