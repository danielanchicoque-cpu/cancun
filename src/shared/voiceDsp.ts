// Motor de voz propio de Cancun: reducción de ruido, aislamiento de voz y limpieza para
// "Mejorar voz". Corre en local sobre el audio ya decodificado (mono, 48 kHz) y es puro
// (sin Electron ni disco) para poder probarlo y afinarlo con pares antes/después.
//
// Cómo funciona: STFT con ventanas de 1024 muestras (21 ms) y 75 % de solapamiento.
// El ruido de cada banda se estima con "estadística de mínimos" (el piso de energía de
// los últimos ~1,5 s) combinado con un perfil global del clip (el audio completo está
// disponible, así que se aprovecha). La ganancia es un filtro de Wiener con SNR a priori
// "decision-directed" (Ephraim–Malah), suavizada en tiempo y frecuencia para que no
// quede ruido musical. Para aislar la voz se añade un detector de voz por cuadro que
// cierra los silencios entre frases y un filtro de banda de voz, como hace CapCut.

export interface VoiceOptions {
  /** Cuánto se baja el ruido, en dB (piso de la ganancia). 0 = nada. */
  reductionDb: number
  /** Cierra los tramos sin voz (aislar voz). 0..1. */
  gate: number
  /** Corte de graves en Hz (0 = sin corte). */
  highpassHz: number
  /** Atenuación de agudos sobre 5 kHz, en dB (positiva = baja). */
  trebleCutDb: number
  /** Pendiente del corte de graves (orden: 6 dB/oct por cada unidad). */
  highpassOrder?: number
}

export const VOICE_PRESETS = {
  /** Reducción de ruido: ~13 dB menos de fondo, la voz intacta (medido contra CapCut). */
  denoise: { reductionDb: 13, gate: 0, highpassHz: 95, highpassOrder: 6, trebleCutDb: 0 },
  /** Aislar voz: quita graves y música de fondo y deja en silencio los huecos. */
  isolate: { reductionDb: 34, gate: 1, highpassHz: 165, highpassOrder: 8, trebleCutDb: 4 },
  /** Limpieza suave previa a "Mejorar voz" cuando no se pidió reducir el ruido. */
  enhance: { reductionDb: 9, gate: 0, highpassHz: 75, highpassOrder: 4, trebleCutDb: 0 }
} satisfies Record<string, VoiceOptions>

export type VoicePreset = keyof typeof VOICE_PRESETS

const N = 1024
const HOP = 256
const BINS = N / 2 + 1

// --- FFT radix-2 compleja, en sitio --------------------------------------------------
const REV = new Uint16Array(N)
const COS = new Float64Array(N / 2)
const SIN = new Float64Array(N / 2)
{
  const bits = Math.log2(N)
  for (let i = 0; i < N; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    REV[i] = r
  }
  for (let i = 0; i < N / 2; i++) {
    COS[i] = Math.cos((2 * Math.PI * i) / N)
    SIN[i] = Math.sin((2 * Math.PI * i) / N)
  }
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  for (let i = 0; i < N; i++) {
    const j = REV[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  const sign = inverse ? 1 : -1
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1
    const step = N / size
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step]
        const wi = sign * SIN[k * step]
        const a = start + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

// Ventana raíz de Hann (análisis y síntesis): con 75 % de solapamiento la suma es constante.
const WIN = new Float64Array(N)
for (let i = 0; i < N; i++) WIN[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
// Suma de las ventanas solapadas (raíz de Hann al cuadrado = Hann; con hop N/4 vale 2).
let OLA_NORM = 0
for (let k = 0; k < N; k += HOP) OLA_NORM += WIN[k] * WIN[k]

/** Percentil por columna (banda) de una matriz frames×bins. */
function percentileByBin(power: Float32Array[], q: number): Float64Array {
  const out = new Float64Array(BINS)
  const col = new Float64Array(power.length)
  for (let k = 0; k < BINS; k++) {
    for (let t = 0; t < power.length; t++) col[t] = power[t][k]
    const sorted = Array.from(col).sort((a, b) => a - b)
    out[k] = sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  }
  return out
}

/**
 * Procesa audio mono. Devuelve un arreglo del mismo largo. `sampleRate` se usa para
 * ubicar las bandas (graves, voz, agudos); el motor está afinado para 48 kHz.
 */
export function processVoice(input: Float32Array, sampleRate: number, opts: VoiceOptions): Float32Array {
  const len = input.length
  if (!len) return new Float32Array(0)
  const frames = Math.ceil((len + N) / HOP)
  const hz = sampleRate / N
  const re = new Float64Array(N)
  const im = new Float64Array(N)

  // 1) Análisis: espectro de cada cuadro (se guarda para el segundo paso).
  const specRe: Float32Array[] = []
  const specIm: Float32Array[] = []
  const power: Float32Array[] = []
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - N
    for (let i = 0; i < N; i++) {
      const s = start + i
      re[i] = s >= 0 && s < len ? input[s] * WIN[i] : 0
      im[i] = 0
    }
    fft(re, im, false)
    const r = new Float32Array(BINS)
    const m = new Float32Array(BINS)
    const p = new Float32Array(BINS)
    for (let k = 0; k < BINS; k++) {
      r[k] = re[k]
      m[k] = im[k]
      p[k] = re[k] * re[k] + im[k] * im[k]
    }
    specRe.push(r)
    specIm.push(m)
    power.push(p)
  }

  // 2) Ruido: perfil global (percentil bajo del clip) + mínimos locales, ambos sobre el
  // espectro suavizado (3 bandas y en el tiempo). El percentil y el mínimo de algo que
  // fluctúa quedan por debajo de la media: se corrigen con los sesgos medidos con ruido
  // blanco (×1,38 y ×1,87); sin eso el ruido constante (ventilador, siseo) apenas bajaba.
  const smoothed: Float32Array[] = []
  {
    const prev = new Float64Array(BINS)
    for (let f = 0; f < frames; f++) {
      const p = power[f]
      const o = new Float32Array(BINS)
      for (let k = 0; k < BINS; k++) {
        const v = 0.25 * p[Math.max(0, k - 1)] + 0.5 * p[k] + 0.25 * p[Math.min(BINS - 1, k + 1)]
        prev[k] = f === 0 ? v : 0.9 * prev[k] + 0.1 * v
        o[k] = prev[k]
      }
      smoothed.push(o)
    }
  }
  const globalNoise = percentileByBin(smoothed, 0.12).map((v) => v * 1.38)
  const minWin = Math.max(8, Math.round((1.5 * sampleRate) / HOP))
  const sub = Math.max(2, Math.round(minWin / 6))
  const subMins: Float64Array[] = []
  let curMin = new Float64Array(BINS).fill(Infinity)
  const noise = new Float64Array(BINS)
  const prevClean = new Float64Array(BINS)
  const gains: Float32Array[] = []
  const voiceLo = Math.max(1, Math.floor(250 / hz))
  const voiceHi = Math.min(BINS - 1, Math.ceil(3800 / hz))
  const bassHi = Math.max(1, Math.ceil(200 / hz))
  const voiceDb = new Float32Array(frames)
  const bassDb = new Float32Array(frames)
  /** SNR estimado de la voz ya limpia en su banda (dB), para la compuerta. */
  const voiceSnr = new Float32Array(frames)
  const floor = Math.pow(10, -opts.reductionDb / 20)

  for (let f = 0; f < frames; f++) {
    const p = power[f]
    const sm = smoothed[f]
    for (let k = 0; k < BINS; k++) if (sm[k] < curMin[k]) curMin[k] = sm[k]
    if (f % sub === sub - 1) {
      subMins.push(curMin)
      if (subMins.length > 6) subMins.shift()
      curMin = new Float64Array(BINS).fill(Infinity)
    }
    let ev = 0
    let eb = 0
    for (let k = 1; k <= bassHi; k++) eb += p[k]
    for (let k = voiceLo; k <= voiceHi; k++) ev += p[k]
    voiceDb[f] = 10 * Math.log10(ev + 1e-12)
    bassDb[f] = 10 * Math.log10(eb + 1e-12)
    for (let k = 0; k < BINS; k++) {
      let m = curMin[k]
      for (const s of subMins) if (s[k] < m) m = s[k]
      // El ruido local sigue los cambios del fondo; el perfil global le pone piso y techo
      // para que una voz sostenida no se confunda con ruido.
      const local = Number.isFinite(m) ? m * 1.87 : globalNoise[k]
      noise[k] = Math.min(Math.max(local, globalNoise[k] * 0.8), globalNoise[k] * 3) + 1e-12
    }

    // Ganancia de Wiener con SNR a priori decision-directed.
    const g = new Float32Array(BINS)
    for (let k = 0; k < BINS; k++) {
      const post = p[k] / noise[k]
      const prio = 0.97 * (prevClean[k] / noise[k]) + 0.03 * Math.max(post - 1, 0)
      // Wiener suavizado (exponente 0,7): baja el fondo sin apagar las partes débiles de la voz.
      const wiener = prio / (1 + prio)
      const gain = Math.max(Math.pow(wiener, 0.7), floor)
      g[k] = gain
      prevClean[k] = wiener * wiener * p[k]
    }
    let clean = 0
    let nv = 0
    for (let k = voiceLo; k <= voiceHi; k++) {
      clean += prevClean[k]
      nv += noise[k]
    }
    voiceSnr[f] = 10 * Math.log10((clean + 1e-12) / (nv + 1e-12))
    gains.push(g)
  }

  // 3) Detector de voz (para aislar). Medido contra los resultados de CapCut, lo que mejor
  // separa "hay voz" de "solo fondo" es el nivel de la banda de voz relativo al clip y
  // cuánto sobresale esa banda sobre los graves (la música vive en los graves).
  const gateGain = new Float32Array(frames).fill(1)
  if (opts.gate > 0) {
    const sorted = Array.from(voiceDb).sort((a, b) => a - b)
    const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0
    const score = (f: number) => voiceDb[f] - (loud - 14) + 0.5 * (voiceDb[f] - bassDb[f] + 3)
    const hold = Math.round((0.22 * sampleRate) / HOP)
    const attack = 1 - Math.exp(-HOP / (0.004 * sampleRate))
    const release = 1 - Math.exp(-HOP / (0.12 * sampleRate))
    const closed = Math.pow(10, -(opts.reductionDb + 25) / 20)
    let on = false
    let held = 0
    let level = closed
    for (let f = 0; f < frames; f++) {
      // Abre con voz que sobresale del clip Y del ruido estimado (si no, un fondo constante
      // fuerte mantendría abierta la compuerta).
      const a = Math.min(score(f), voiceSnr[f] - 1)
      if (a > 2) {
        on = true
        held = hold
      } else if (a < -2) {
        if (held > 0) held--
        else on = false
      }
      const target = on ? 1 : closed
      level += (target - level) * (target > level ? attack : release)
      gateGain[f] = 1 - opts.gate + opts.gate * level
    }
    // Abre un poco antes de cada frase para no comerse el ataque de la primera sílaba.
    const pre = Math.round((0.03 * sampleRate) / HOP)
    for (let f = 0; f < frames; f++) {
      for (let d = 1; d <= pre && f + d < frames; d++) if (gateGain[f + d] > gateGain[f]) gateGain[f] = Math.max(gateGain[f], gateGain[f + d] * (1 - d / (pre + 1)))
    }
  }

  // 4) Forma fija: corte de graves (pendiente de 24 dB/oct) y agudos.
  const shape = new Float32Array(BINS)
  const treble = Math.pow(10, -opts.trebleCutDb / 20)
  for (let k = 0; k < BINS; k++) {
    const f = k * hz
    let s = 1
    if (opts.highpassHz > 0) {
      const x = f / opts.highpassHz
      const xn = Math.pow(x, opts.highpassOrder ?? 4)
      s = xn / (1 + xn)
    }
    if (opts.trebleCutDb > 0 && f > 5000) s *= treble + (1 - treble) * Math.exp(-(f - 5000) / 1500)
    shape[k] = s
  }

  // 5) Síntesis: ganancias suavizadas en frecuencia (3 bandas) y en tiempo.
  const out = new Float64Array(len + N)
  const prevG = new Float64Array(BINS).fill(1)
  for (let f = 0; f < frames; f++) {
    const g = gains[f]
    const gg = gateGain[f]
    for (let k = 0; k < BINS; k++) {
      const a = g[Math.max(0, k - 1)]
      const b = g[k]
      const c = g[Math.min(BINS - 1, k + 1)]
      let v = 0.25 * a + 0.5 * b + 0.25 * c
      // Sube rápido (no recorta consonantes) y baja más lento (sin "agua" en las colas).
      v = v > prevG[k] ? v : 0.6 * prevG[k] + 0.4 * v
      prevG[k] = v
      const total = v * gg * shape[k]
      re[k] = specRe[f][k] * total
      im[k] = specIm[f][k] * total
    }
    for (let k = 1; k < N / 2; k++) {
      re[N - k] = re[k]
      im[N - k] = -im[k]
    }
    fft(re, im, true)
    const start = f * HOP - N
    for (let i = 0; i < N; i++) {
      const s = start + i + N
      if (s >= 0 && s < out.length) out[s] += (re[i] / N) * WIN[i]
    }
  }
  const result = new Float32Array(len)
  for (let i = 0; i < len; i++) result[i] = out[i + N] / OLA_NORM
  return result
}
