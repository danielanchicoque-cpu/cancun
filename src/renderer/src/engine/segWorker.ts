// Worker de segmentación: MediaPipe corre aquí para no frenar la reproducción.
// Recibe cuadros ya reducidos a 256×256 y devuelve la máscara (r = persona, g = piel).

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

const BACKGROUND = 0
const BODY_SKIN = 2
const FACE_SKIN = 3
/** Suavizado temporal: cuánto pesa el cuadro nuevo (evita parpadeo en los bordes). */
const TEMPORAL = 0.65

let segmenter: ImageSegmenter | null = null
let lastTs = 0
const history = new Map<string, Float32Array>()

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
      const fileset = await FilesetResolver.forVisionTasks(msg.wasm)
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.model, delegate: 'GPU' },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })
      postMessage({ type: 'ready' })
    } catch (err) {
      postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.type === 'forget') {
    history.delete(msg.key)
    return
  }
  if (!segmenter) return
  lastTs = Math.max(lastTs + 1, Math.floor(performance.now()))
  const result = segmenter.segmentForVideo(msg.frame, lastTs)
  msg.frame.close()
  const masks = result.confidenceMasks ?? []
  const bg = masks[BACKGROUND]?.getAsFloat32Array()
  const body = masks[BODY_SKIN]?.getAsFloat32Array()
  const face = masks[FACE_SKIN]?.getAsFloat32Array()
  const w = masks[0]?.width ?? 256
  const h = masks[0]?.height ?? 256
  const n = w * h
  const prev = msg.reset ? undefined : history.get(msg.key)
  const cur = new Float32Array(n * 2)
  const rgba = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    let person = bg ? 1 - bg[i] : 1
    let skin = (body?.[i] ?? 0) + (face?.[i] ?? 0)
    if (prev && prev.length === n * 2) {
      person = prev[i * 2] + (person - prev[i * 2]) * TEMPORAL
      skin = prev[i * 2 + 1] + (skin - prev[i * 2 + 1]) * TEMPORAL
    }
    cur[i * 2] = person
    cur[i * 2 + 1] = skin
    rgba[i * 4] = Math.min(1, person) * 255
    rgba[i * 4 + 1] = Math.min(1, skin) * 255
    rgba[i * 4 + 3] = 255
  }
  for (const m of masks) m.close()
  history.set(msg.key, cur)
  postMessage({ type: 'mask', id: msg.id, key: msg.key, w, h, data: rgba }, { transfer: [rgba.buffer] })
}
