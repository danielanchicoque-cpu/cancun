// Hilo aparte para el motor de voz: un clip largo tarda varios segundos y no debe
// congelar el proceso principal (que atiende la interfaz y el CLI).

import { parentPort } from 'node:worker_threads'
import { processVoiceLong } from '@shared/voice'
import type { VoiceOptions } from '@shared/voiceDsp'

interface Msg {
  id: number
  samples: Float32Array
  sampleRate: number
  opts: VoiceOptions
}

parentPort!.on('message', (m: Msg) => {
  try {
    const out = processVoiceLong(m.samples, m.sampleRate, m.opts, (f) => parentPort!.postMessage({ id: m.id, progress: f }))
    parentPort!.postMessage({ id: m.id, samples: out }, [out.buffer as ArrayBuffer])
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) })
  }
})
