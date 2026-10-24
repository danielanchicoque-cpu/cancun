// Segmentación local con MediaPipe (modelo selfie multiclase, Apache 2.0), en un Worker
// para no frenar la interfaz. La máscara (r = persona, g = piel) se usa para quitar el
// fondo, la iluminación y el retoque; el compositor la refina a resolución completa.

import { mediaUrl } from '../api'

const INPUT = 256

let shared: Promise<Segmenter> | null = null

export class Segmenter {
  private worker: Worker
  private nextId = 1
  private waiting = new Map<number, (img: ImageBitmap) => void>()
  private latest = new Map<string, ImageBitmap>()
  private busy = new Set<string>()
  /** Se llama cuando llega una máscara nueva (para repintar la vista previa). */
  onMask: (() => void) | null = null

  private constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (e: MessageEvent<{ type: string; id: number; key: string; bitmap: ImageBitmap; ms: number }>) => {
      const m = e.data
      if (m.type !== 'mask') return
      const waiter = this.waiting.get(m.id)
      if (waiter) {
        // Exportación: la máscara es de quien la pidió (la cierra después de usarla).
        waiter(m.bitmap)
        this.waiting.delete(m.id)
      } else {
        this.latest.get(m.key)?.close()
        this.latest.set(m.key, m.bitmap)
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
          model: mediaUrl(`${root}/resources/models/selfie_multiclass_256x256.tflite`)
        })
      })
      return new Segmenter(worker)
    })()
    shared.catch(() => (shared = null))
    return shared
  }

  private async send(key: string, src: TexImageSource | ImageBitmap, reset: boolean): Promise<ImageBitmap> {
    // Se reduce en la GPU antes de mandarlo: el modelo trabaja a 256×256.
    const frame = await createImageBitmap(src as ImageBitmapSource, { resizeWidth: INPUT, resizeHeight: INPUT, resizeQuality: 'medium' })
    const id = this.nextId++
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.worker.postMessage({ type: 'segment', id, key, frame, reset }, [frame])
    })
  }

  /**
   * Vista previa: pide una máscara nueva si el worker está libre para este clip y
   * devuelve la última disponible (puede ir un cuadro atrás, no se nota).
   */
  request(key: string, src: TexImageSource): ImageBitmap | undefined {
    if (!this.busy.has(key)) {
      this.busy.add(key)
      this.send(key, src, false)
        .then((bitmap) => {
          this.latest.get(key)?.close()
          this.latest.set(key, bitmap)
        })
        .catch(() => this.busy.delete(key))
    }
    return this.latest.get(key)
  }

  /**
   * Exportación en paralelo: copia el cuadro (ya se puede soltar la fuente) y devuelve
   * la promesa de su máscara, que el worker calcula mientras se dibuja lo demás.
   */
  async submit(key: string, src: TexImageSource | ImageBitmap): Promise<{ mask: Promise<ImageBitmap> }> {
    const frame = await createImageBitmap(src as ImageBitmapSource, { resizeWidth: INPUT, resizeHeight: INPUT, resizeQuality: 'medium' })
    const id = this.nextId++
    const mask = new Promise<ImageBitmap>((resolve) => this.waiting.set(id, resolve))
    this.worker.postMessage({ type: 'segment', id, key, frame, reset: false }, [frame])
    return { mask }
  }

  /** Exportación: la máscara exacta de este cuadro. */
  segmentNow(key: string, src: TexImageSource | ImageBitmap): Promise<ImageBitmap> {
    return this.send(key, src, false)
  }

  /** ¿Ya hay máscara para este clip? (la captura de cuadros del CLI la espera) */
  has(key: string): boolean {
    return this.latest.has(key)
  }

  forget(key: string) {
    this.latest.delete(key)
    this.busy.delete(key)
    this.worker.postMessage({ type: 'forget', key })
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
