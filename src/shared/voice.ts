// Efectos de voz de un clip (reducir ruido, aislar voz, mejorar voz): qué hay que
// procesar, con qué ajustes y cómo se nombra el resultado en caché. Lo comparten la
// vista previa (que reproduce el audio ya procesado), la exportación y el CLI.

import { type AudioFx, type Media, type MediaClip, US } from './project.ts'
import { VOICE_PRESETS, type VoiceOptions, processVoice } from './voiceDsp.ts'

export interface VoiceJob {
  /** Archivo de origen del audio. */
  path: string
  /** Desde dónde y cuánto del origen se procesa (µs del archivo). */
  start: number
  duration: number
  denoise: boolean
  isolate: boolean
  enhance: boolean
  /** Intensidad de "Mejorar voz", 0..1. */
  amount: number
}

export interface VoiceResult {
  /** WAV procesado (48 kHz). Empieza en `start` del archivo de origen. */
  path: string
  start: number
  duration: number
}

/** ¿El clip tiene algún efecto de voz que requiera procesar el audio? */
export function needsVoice(fx: AudioFx): boolean {
  return fx.denoise || fx.isolateVoice || fx.enhanceVoice
}

/** Trabajo de voz de un clip (o null si no tiene efectos o no tiene audio). */
export function voiceJob(clip: MediaClip, media: Media | undefined): VoiceJob | null {
  if (!media?.hasAudio || media.kind === 'image' || !needsVoice(clip.audioFx)) return null
  // Se procesa el archivo completo: así recortar, dividir o duplicar clips del mismo
  // archivo reutiliza el resultado en caché en lugar de rehacerlo.
  const end = Math.max(media.duration || 0, clip.sourceIn + clip.duration * clip.speed)
  return {
    path: media.path,
    start: 0,
    duration: Math.max(US / 10, Math.ceil(end / 1000) * 1000),
    denoise: clip.audioFx.denoise,
    isolate: clip.audioFx.isolateVoice,
    enhance: clip.audioFx.enhanceVoice,
    amount: clip.audioFx.enhanceVoice ? Math.round((clip.audioFx.enhanceAmount ?? 1) * 4) / 4 : 0
  }
}

/** Identificador estable del resultado (para la caché en disco). */
export function voiceKey(j: VoiceJob): string {
  return JSON.stringify([VOICE_ENGINE_VERSION, j.path, j.start, j.duration, j.denoise, j.isolate, j.enhance, j.amount])
}

/** Sube cuando cambie el motor, para no reutilizar resultados viejos de la caché. */
export const VOICE_ENGINE_VERSION = 4

/** Ajustes del motor espectral para un trabajo. Aislar manda sobre reducir ruido. */
export function voiceOptions(j: VoiceJob): VoiceOptions | null {
  if (j.isolate) return VOICE_PRESETS.isolate
  if (j.denoise) return VOICE_PRESETS.denoise
  if (j.enhance && j.amount > 0) return { ...VOICE_PRESETS.enhance, reductionDb: VOICE_PRESETS.enhance.reductionDb * j.amount }
  return null
}

/**
 * Plan con el motor neuronal (DeepFilterNet), medido contra CapCut con SI-SDR:
 * aislar = DeepFilterNet al máximo (9,2 dB frente a 3,8 del motor espectral solo);
 * reducir = DeepFilterNet + el corte de graves del motor espectral (10,9 frente a 8,7);
 * solo mejorar = DeepFilterNet limitado a 12 dB × intensidad.
 * `atten` = límite de atenuación en dB (100 = sin límite); `shape` = pase espectral
 * posterior sin reducción propia (solo forma de graves y agudos), o null.
 */
export function neuralPlan(j: VoiceJob): { atten: number; shape: VoiceOptions | null } | null {
  if (j.isolate) return { atten: 100, shape: null }
  if (j.denoise) return { atten: 100, shape: { ...VOICE_PRESETS.denoise, reductionDb: 0 } }
  if (j.enhance && j.amount > 0) return { atten: Math.round(12 * j.amount), shape: { ...VOICE_PRESETS.enhance, reductionDb: 0 } }
  return null
}

/**
 * Cadena de ffmpeg que va después del motor espectral. "Mejorar voz": quita barro,
 * da presencia y aire, controla las eses y empareja el volumen (como una voz de estudio).
 */
export function voicePostFilter(j: VoiceJob): string {
  const steps: string[] = []
  const a = j.amount
  if (j.enhance && a > 0) {
    const f = (v: number) => (v * a).toFixed(2)
    steps.push(
      'highpass=f=80',
      `equalizer=f=250:t=q:w=1.1:g=${f(-2.5)}`,
      `equalizer=f=3200:t=q:w=1.0:g=${f(3)}`,
      `highshelf=f=10000:g=${f(2)}`,
      `deesser=i=${f(0.4)}`,
      // Expansor suave antes del compresor: sin él, la ganancia de compensación volvía a
      // subir el fondo en las pausas (medido: +6 a +10 dB en agudos).
      'agate=threshold=0.03:ratio=4:range=0.12:attack=4:release=200:knee=3',
      `acompressor=threshold=-20dB:ratio=${(1 + 1.5 * a).toFixed(2)}:attack=6:release=140:makeup=${f(2)}`,
      'alimiter=limit=0.95:level=disabled'
    )
  }
  return steps.length ? steps.join(',') : 'anull'
}

const CHUNK_S = 30
const OVERLAP_S = 1

/**
 * Procesa audio largo por tramos de 30 s (con 1 s de fundido cruzado) para que la
 * memoria no crezca con la duración del clip.
 */
export function processVoiceLong(
  input: Float32Array,
  sampleRate: number,
  opts: VoiceOptions,
  onProgress?: (fraction: number) => void
): Float32Array {
  const chunk = CHUNK_S * sampleRate
  const overlap = OVERLAP_S * sampleRate
  if (input.length <= chunk + overlap) {
    const out = processVoice(input, sampleRate, opts)
    onProgress?.(1)
    return out
  }
  const out = new Float32Array(input.length)
  for (let start = 0; start < input.length; start += chunk) {
    const from = Math.max(0, start - overlap)
    const to = Math.min(input.length, start + chunk + overlap)
    const part = processVoice(input.subarray(from, to), sampleRate, opts)
    for (let i = from; i < to; i++) {
      const v = part[i - from]
      // Antes de `start` el tramo anterior ya escribió: fundido lineal entre los dos.
      // Lo que pasa de `start + chunk` lo reescribe (con fundido) el tramo siguiente.
      const w = i < start ? (i - from) / Math.max(1, start - from) : 1
      out[i] = out[i] * (1 - w) + v * w
    }
    onProgress?.(Math.min(1, to / input.length))
  }
  return out
}
