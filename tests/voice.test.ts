import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processVoice, VOICE_PRESETS } from '../src/shared/voiceDsp.ts'
import { needsVoice, processVoiceLong, voiceJob, voiceKey, voiceOptions } from '../src/shared/voice.ts'
import { buildExport } from '../src/shared/exportGraph.ts'
import { applyOp } from '../src/shared/ops.ts'
import { type Media, US, newProject } from '../src/shared/project.ts'

const RATE = 48000

/** Ruido blanco reproducible. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s / 2 ** 32) * 2 - 1) * amp
  }
  return out
}

/** "Voz" sintética: armónicos de 180 Hz que se prenden y apagan como frases. */
function speech(n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const on = Math.sin(2 * Math.PI * 0.7 * t) > -0.2 ? 1 : 0
    let v = 0
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 180 * h * t) / h
    out[i] = on * v * 0.15 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t))
  }
  return out
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}
const db = (v: number) => 20 * Math.log10(v + 1e-12)

/** Inicio de un tramo de 0,15 s sin voz, con `before` s de silencio antes (para que la compuerta cierre). */
function gapIn(v: Float32Array, n: number, before = 0.25): number {
  for (let i = RATE; i < n - RATE / 2; i += RATE / 50) if (rms(v, i - Math.round(RATE * before), i + RATE / 5) === 0) return i
  throw new Error('no se encontró un hueco sin voz')
}

test('voz: sin reducción el audio sale idéntico', () => {
  const x = speech(RATE)
  const y = processVoice(x, RATE, { reductionDb: 0, gate: 0, highpassHz: 0, trebleCutDb: 0 })
  let err = 0
  for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i]))
  assert.ok(err < 1e-4, `error ${err}`)
})

test('voz: reducir ruido baja el fondo más de 10 dB y casi no toca la voz', () => {
  const n = RATE * 6
  const v = speech(n)
  const bg = noise(n, 0.02)
  const mix = v.map((s, i) => s + bg[i])
  const out = processVoice(mix, RATE, VOICE_PRESETS.denoise)
  // Lo que queda del ruido se mide en un tramo sin voz (después del primer segundo).
  const s0 = gapIn(v, n)
  const before = db(rms(mix, s0, s0 + RATE / 10))
  const after = db(rms(out, s0, s0 + RATE / 10))
  assert.ok(before - after > 10, `solo bajó ${(before - after).toFixed(1)} dB`)
  // La voz conserva su nivel (±2,5 dB).
  const voiced = db(rms(v)) - db(rms(out))
  assert.ok(Math.abs(voiced) < 2.5, `la voz cambió ${voiced.toFixed(1)} dB`)
})

test('voz: aislar deja casi en silencio los huecos entre frases', () => {
  const n = RATE * 6
  const v = speech(n)
  const bg = noise(n, 0.03, 7)
  const mix = v.map((s, i) => s + bg[i])
  const out = processVoice(mix, RATE, VOICE_PRESETS.isolate)
  const gap = gapIn(v, n, 0.4)
  const drop = db(rms(mix, gap, gap + RATE / 7)) - db(rms(out, gap, gap + RATE / 7))
  assert.ok(drop > 30, `el hueco solo bajó ${drop.toFixed(1)} dB`)
})

test('voz: el proceso por tramos no deja saltos en las uniones', () => {
  const n = RATE * 65
  const x = speech(n).map((s, i) => s + noise(1, 0.01, i + 3)[0])
  const y = processVoiceLong(x, RATE, VOICE_PRESETS.denoise)
  assert.equal(y.length, x.length)
  for (const join of [RATE * 30, RATE * 60]) {
    const jump = Math.abs(y[join] - y[join - 1])
    assert.ok(jump < 0.2, `salto ${jump} en ${join}`)
  }
})

const media: Media = { id: 'm', kind: 'video', path: 'C:/v.mp4', name: 'v', duration: 20 * US, hasAudio: true, width: 1920, height: 1080 }

test('voz: trabajo por archivo completo y opciones por efecto', () => {
  let p = newProject('voz', 1920, 1080, 30)
  p = applyOp(p, { op: 'addMedia', media }).project
  const r = applyOp(p, { op: 'addClip', mediaId: 'm', sourceIn: 2 * US, duration: 5 * US })
  p = r.project
  const id = r.createdId!
  const clip = () => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as never
  assert.equal(voiceJob(clip(), media), null)
  p = applyOp(p, { op: 'updateClip', clipId: id, patch: { audioFx: { denoise: true } } }).project
  const job = voiceJob(clip(), media)!
  assert.ok(needsVoice((clip() as { audioFx: never }).audioFx))
  assert.equal(job.start, 0)
  assert.equal(job.duration, 20 * US)
  assert.deepEqual(voiceOptions(job), VOICE_PRESETS.denoise)
  // Recortar el clip no cambia el trabajo (se reutiliza la caché).
  const trimmed = applyOp(p, { op: 'updateClip', clipId: id, patch: { duration: 3 * US } }).project
  const clip2 = trimmed.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as never
  assert.equal(voiceKey(voiceJob(clip2, media)!), voiceKey(job))
  // Aislar manda sobre reducir ruido.
  assert.deepEqual(voiceOptions({ ...job, isolate: true }), VOICE_PRESETS.isolate)

  // La exportación lee el WAV limpio, desde el punto correcto.
  const plan = buildExport(p, { output: 'out.mp4', encoder: 'libx264', filterPath: 'a.txt', voice: { [id]: { path: 'C:/cache/v.wav', start: 0, duration: 20 * US } } })
  const i = plan.args.indexOf('C:/cache/v.wav')
  assert.ok(i > 0, 'no usa el audio procesado')
  assert.equal(plan.args[i - 5], '-ss')
  assert.equal(Number(plan.args[i - 4]), 2)
  assert.ok(!plan.filter!.includes('afftdn'))
})
