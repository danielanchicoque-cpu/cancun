// Segmentación y puntos de cara/cuerpo con MediaPipe (Apache 2.0), en un Worker para no
// frenar la interfaz. La máscara (r = persona, g = piel) se usa para quitar el fondo, la
// iluminación y el retoque de piel; los puntos, para retocar rostro, rasgos y cuerpo.

import type { Retouch } from '@shared/project'
import { type Landmarks, needsFace, needsPose, needsSkin } from '@shared/retouch'
import { mediaUrl } from '../api'

const INPUT = 256
/** Ancho del cuadro (en su proporción) que se usa para detectar cara y cuerpo. */
const FULL_W = 448
/** Más de esto entre dos cuadros pedidos = salto (no reproducción continua). */
const JUMP_S = 0.25
/** Una máscara sirve para un cuadro si es de menos de esta distancia en el tiempo. */
const FRESH_S = 0.06
/** Suavizado de los puntos entre cuadros seguidos (peso del nuevo): evita que tiemblen. */
const LANDMARK_SMOOTH = 0.55

export interface SegResult {
  mask: ImageBitmap
  marks: Landmarks
}

/** Qué hay que detectar para un clip. */
export interface SegNeeds {
  face: boolean
  pose: boolean
}

let shared: Promise<Segmenter> | null = null

export class Segmenter {
  private worker: Worker
  private nextId = 1
  private waiting = new Map<number, (r: SegResult) => void>()
  private latest = new Map<string, SegResult>()
  /** Tiempo (s, de la fuente) del cuadro de la última máscara y del último pedido, por clip. */
  private latestT = new Map<string, number>()
  private sentT = new Map<string, number>()
  private busy = new Set<string>()
  /** Últimos puntos de cada clip, para suavizar los siguientes. */
  private prevMarks = new Map<string, Landmarks>()
  /** Se llama cuando llega una máscara nueva (para repintar la vista previa). */
  onMask: (() => void) | null = null

  private constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (
      e: MessageEvent<{ type: string; id: number; key: string; bitmap: ImageBitmap; face: Float32Array | null; pose: Float32Array | null }>
    ) => {
      const m = e.data
      if (m.type !== 'mask') return
      const waiter = this.waiting.get(m.id)
      const result: SegResult = { mask: m.bitmap, marks: { face: m.face, pose: m.pose } }
      if (waiter) {
        waiter(result)
        this.waiting.delete(m.id)
      }
      this.busy.delete(m.key)
      this.onMask?.()
    }
  }

  static get(): Promise<Segmenter> {
    shared ??= (async () => {
      const root = (await window.cancun.paths.app()).replace(/\\/g, '/')
      const worker = new Worker(new URL('./segWorker.ts', import.meta.url), { type: 'classic' })
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ type: string; error?: string }>) => {
          if (e.data.type === 'ready') resolve()
          else if (e.data.type === 'error') reject(new Error(e.data.error))
        }
        worker.postMessage({
          type: 'init',
          wasm: mediaUrl(`${root}/node_modules/@mediapipe/tasks-vision/wasm`),
          model: mediaUrl(`${root}/resources/models/selfie_multiclass_256x256.tflite`),
          faceModel: mediaUrl(`${root}/resources/models/face_landmarker.task`),
          poseModel: mediaUrl(`${root}/resources/models/pose_landmarker_lite.task`)
        })
      })
      return new Segmenter(worker)
    })()
    shared.catch(() => (shared = null))
    return shared
  }

  private async send(key: string, src: TexImageSource | ImageBitmap, reset: boolean, needs: SegNeeds): Promise<SegResult> {
    // Se reduce en la GPU antes de mandarlo: el modelo de máscara trabaja a 256×256.
    const frame = await createImageBitmap(src as ImageBitmapSource, { resizeWidth: INPUT, resizeHeight: INPUT, resizeQuality: 'medium' })
    let full: ImageBitmap | null = null
    if (needs.face || needs.pose) {
      const [w, h] = sizeOf(src)
      full = await createImageBitmap(src as ImageBitmapSource, { resizeWidth: FULL_W, resizeHeight: Math.max(1, Math.round((FULL_W * h) / Math.max(1, w))), resizeQuality: 'medium' })
    }
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      const transfer: Transferable[] = full ? [frame, full] : [frame]
      this.worker.postMessage({ type: 'segment', id, key, frame, full, reset, wantFace: needs.face, wantPose: needs.pose }, transfer)
    })
  }

  /** Mezcla los puntos nuevos con los anteriores (si el cuadro es seguido). */
  private smooth(key: string, next: Landmarks, jump: boolean): Landmarks {
    const prev = this.prevMarks.get(key)
    const out = jump || !prev ? next : null
    if (out) {
      this.prevMarks.set(key, out)
      return out
    }
    const mix = (a: Float32Array | null, b: Float32Array | null) => {
      if (!a || !b || a.length !== b.length) return b
      const out = new Float32Array(b.length)
      for (let i = 0; i < b.length; i++) out[i] = a[i] + (b[i] - a[i]) * LANDMARK_SMOOTH
      return out
    }
    const smoothed = { face: mix(prev!.face, next.face), pose: mix(prev!.pose, next.pose) }
    this.prevMarks.set(key, smoothed)
    return smoothed
  }

  private store(key: string, r: SegResult, t: number, jump: boolean) {
    const marks = this.smooth(key, r.marks, jump)
    this.latest.get(key)?.mask.close()
    this.latest.set(key, { mask: r.mask, marks })
    this.latestT.set(key, t)
  }

  /**
   * Vista previa: pide una máscara nueva si el worker está libre para este clip y
   * devuelve la última disponible (puede ir un cuadro atrás, no se nota).
   */
  request(key: string, src: TexImageSource, t: number, needs: SegNeeds): SegResult | undefined {
    if (!this.busy.has(key)) {
      this.busy.add(key)
      // Un salto en el tiempo (buscar, otro punto del clip) no debe mezclarse con la
      // máscara anterior: se reinicia el suavizado temporal.
      const prev = this.sentT.get(key)
      const jump = prev === undefined || Math.abs(t - prev) > JUMP_S
      this.sentT.set(key, t)
      this.send(key, src, jump, needs)
        .then((r) => this.store(key, r, t, jump))
        .catch(() => this.busy.delete(key))
    }
    return this.latest.get(key)
  }

  /**
   * Exportación en paralelo: copia el cuadro (ya se puede soltar la fuente) y devuelve
   * la promesa de su resultado, que el worker calcula mientras se dibuja lo demás.
   */
  async submit(key: string, src: TexImageSource | ImageBitmap, needs: SegNeeds): Promise<{ result: Promise<SegResult> }> {
    const result = this.send(key, src, false, needs).then((r) => ({ mask: r.mask, marks: this.smooth(key, r.marks, false) }))
    return { result }
  }

  /** ¿Ya hay máscara para este clip? */
  has(key: string): boolean {
    return this.latest.has(key)
  }

  /** La última máscara del clip, sin pedir otra. */
  latestFor(key: string): SegResult | undefined {
    return this.latest.get(key)
  }

  /** ¿La máscara disponible es de este cuadro (y no de otro momento del clip)? */
  hasFresh(key: string, t: number): boolean {
    const lt = this.latestT.get(key)
    return this.latest.has(key) && lt !== undefined && Math.abs(lt - t) < FRESH_S
  }

  forget(key: string) {
    this.latest.get(key)?.mask.close()
    this.latest.delete(key)
    this.latestT.delete(key)
    this.sentT.delete(key)
    this.prevMarks.delete(key)
    this.busy.delete(key)
    this.worker.postMessage({ type: 'forget', key })
  }
}

function sizeOf(src: TexImageSource | ImageBitmap): [number, number] {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight]
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight]
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return [src.displayWidth, src.displayHeight]
  const s = src as { width: number; height: number }
  return [s.width, s.height]
}

/** Qué hay que detectar para este clip. */
export function segNeeds(clip: { retouch: Retouch }): SegNeeds {
  return { face: needsFace(clip.retouch), pose: needsPose(clip.retouch) }
}

/** ¿Este clip necesita pasar por el worker en este cuadro? */
export function needsSegmentation(clip: { background: { mode: string }; retouch: Retouch; light: { enabled: boolean; subjectOnly: boolean } }): boolean {
  const r = clip.retouch
  return clip.background.mode === 'auto' || needsSkin(r) || needsFace(r) || needsPose(r) || (clip.light.enabled && clip.light.subjectOnly)
}
