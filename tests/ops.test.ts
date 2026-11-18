import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOp, type Op } from '../src/shared/ops.ts'
import { subtitleJobs, toTimeline } from '../src/shared/subtitles.ts'
import { type Media, type Project, US, newProject, projectDuration } from '../src/shared/project.ts'

const video = (id: string, seconds: number): Media => ({
  id,
  kind: 'video',
  path: `C:/v/${id}.mp4`,
  name: id,
  duration: seconds * US,
  width: 1920,
  height: 1080,
  hasAudio: true
})

function run(p: Project, ...ops: Op[]): Project {
  for (const op of ops) p = applyOp(p, op).project
  return p
}

function base(): Project {
  return run(newProject('t'), { op: 'addMedia', media: video('a', 10) }, { op: 'addMedia', media: video('b', 4) })
}

test('la pista principal pega los clips uno tras otro', () => {
  const p = run(base(), { op: 'addClip', mediaId: 'a' }, { op: 'addClip', mediaId: 'b' })
  const [c1, c2] = p.tracks[0].clips
  assert.equal(c1.start, 0)
  assert.equal(c2.start, 10 * US)
  assert.equal(projectDuration(p), 14 * US)
})

test('cortar y borrar cierra el hueco en la principal', () => {
  let p = run(base(), { op: 'addClip', mediaId: 'a' }, { op: 'addClip', mediaId: 'b' })
  const first = p.tracks[0].clips[0].id
  p = applyOp(p, { op: 'splitClip', clipId: first, at: 4 * US }).project
  assert.equal(p.tracks[0].clips.length, 3)
  const mid = p.tracks[0].clips[1]
  assert.equal(mid.type === 'media' && mid.sourceIn, 4 * US)
  p = applyOp(p, { op: 'deleteClip', clipId: mid.id }).project
  assert.equal(projectDuration(p), 8 * US)
})

test('un clip superpuesto fuera de la principal crea otra pista', () => {
  const p = run(base(), { op: 'addClip', mediaId: 'a', trackId: undefined, start: 0 })
  const q = applyOp(p, { op: 'addTrack', kind: 'video' })
  const overlay = q.createdId!
  let r = applyOp(q.project, { op: 'addClip', mediaId: 'b', trackId: overlay, start: 1 * US }).project
  r = applyOp(r, { op: 'addClip', mediaId: 'b', trackId: overlay, start: 2 * US }).project
  assert.equal(r.tracks.filter((t) => t.kind === 'video').length, 3)
})

test('recortar el inicio mueve el punto de entrada de la fuente', () => {
  let p = run(base(), { op: 'addClip', mediaId: 'b' }, { op: 'addTrack', kind: 'video' })
  const r = applyOp(p, { op: 'addClip', mediaId: 'a', trackId: p.tracks[1].id, start: 2 * US })
  p = applyOp(r.project, { op: 'trimClip', clipId: r.createdId!, side: 'start', time: 3 * US }).project
  const c = p.tracks[1].clips[0]
  assert.equal(c.start, 3 * US)
  assert.equal(c.type === 'media' && c.sourceIn, 1 * US)
  assert.equal(c.duration, 9 * US)
})

test('no se puede alargar más allá del medio', () => {
  const r = applyOp(base(), { op: 'addClip', mediaId: 'b' })
  const p = applyOp(r.project, { op: 'trimClip', clipId: r.createdId!, side: 'end', time: 60 * US }).project
  assert.equal(p.tracks[0].clips[0].duration, 4 * US)
})

test('la velocidad cambia la duración y conserva el tramo de fuente', () => {
  const r = applyOp(base(), { op: 'addClip', mediaId: 'a' })
  const p = applyOp(r.project, { op: 'updateClip', clipId: r.createdId!, patch: { speed: 2 } }).project
  assert.equal(p.tracks[0].clips[0].duration, 5 * US)
})

test('LUT e intensidad acotada', () => {
  const r = applyOp(base(), { op: 'addClip', mediaId: 'a' })
  const p = applyOp(r.project, {
    op: 'setLut',
    clipId: r.createdId!,
    lut: { path: 'C:/l/Her.cube', name: 'Her', intensity: 3 }
  }).project
  const c = p.tracks[0].clips[0]
  assert.equal(c.type === 'media' && c.color.lut?.intensity, 1)
})

test('la transición necesita un clip siguiente y se acota a la mitad de los clips', () => {
  const p = run(base(), { op: 'addClip', mediaId: 'a' }, { op: 'addClip', mediaId: 'b' })
  const [a, b] = p.tracks[0].clips
  assert.throws(() => applyOp(p, { op: 'setTransition', clipId: b.id, transition: { kind: 'fade', duration: US } }))
  const q = applyOp(p, { op: 'setTransition', clipId: a.id, transition: { kind: 'fade', duration: 10 * US } }).project
  const t = q.tracks[0].clips[0]
  assert.equal(t.type === 'media' && t.transition?.duration, 2 * US)
})

test('las operaciones no mutan el proyecto original', () => {
  const p = base()
  const before = JSON.stringify(p)
  applyOp(p, { op: 'addClip', mediaId: 'a' })
  assert.equal(JSON.stringify(p), before)
})

test('sin imán de la pista principal, el clip se queda donde se suelta', () => {
  let p = run(base(), { op: 'setSettings', patch: { mainMagnet: false } }, { op: 'addClip', mediaId: 'a' }, { op: 'addClip', mediaId: 'b' })
  const b = p.tracks[0].clips[1]
  p = applyOp(p, { op: 'moveClip', clipId: b.id, start: 15 * US }).project
  assert.equal(p.tracks[0].clips[1].start, 15 * US)
  // Con imán vuelve a pegarse.
  p = applyOp(p, { op: 'setSettings', patch: { mainMagnet: true } }).project
  assert.equal(p.tracks[0].clips[1].start, 10 * US)
})

test('la vinculación mueve los clips de arriba con su clip principal', () => {
  let p = run(base(), { op: 'addClip', mediaId: 'a' }, { op: 'addClip', mediaId: 'b' })
  const [a, b] = p.tracks[0].clips
  const r = applyOp(p, { op: 'addText', text: 'hola', start: 11 * US })
  p = applyOp(r.project, { op: 'moveClip', clipId: b.id, start: 0 }).project
  // b pasó al inicio (0..4s): el texto que estaba 1s dentro de b va a 1s.
  const text = p.tracks.find((t) => t.kind === 'text')!.clips[0]
  assert.equal(text.start, 1 * US)
  assert.equal(p.tracks[0].clips[1].id, a.id)
})

test('keyframes: se interpolan y quitar el último fija el valor', async () => {
  const { resolveClip } = await import('../src/shared/animate.ts')
  const r = applyOp(base(), { op: 'addClip', mediaId: 'a' })
  let p = applyOp(r.project, { op: 'setKeyframe', clipId: r.createdId!, prop: 'transform.scale', time: 0, value: 1, ease: 'linear' }).project
  p = applyOp(p, { op: 'setKeyframe', clipId: r.createdId!, prop: 'transform.scale', time: 2 * US, value: 2, ease: 'linear' }).project
  const clip = p.tracks[0].clips[0]
  assert.equal(resolveClip(clip, 1 * US).transform.scale, 1.5)
  p = applyOp(p, { op: 'removeKeyframe', clipId: clip.id, prop: 'transform.scale', time: 0 }).project
  p = applyOp(p, { op: 'removeKeyframe', clipId: clip.id, prop: 'transform.scale', time: 2 * US }).project
  assert.equal(p.tracks[0].clips[0].transform.scale, 2)
})

test('congelar cuadro inserta 3s y corre lo demás', () => {
  const r = applyOp(base(), { op: 'addClip', mediaId: 'a' })
  const p = applyOp(r.project, { op: 'freezeFrame', clipId: r.createdId!, at: 4 * US }).project
  const clips = p.tracks[0].clips
  assert.equal(clips.length, 3)
  assert.ok(clips[1].type === 'media' && clips[1].freeze)
  assert.equal(clips[2].start, 7 * US)
})

test('separar audio crea un clip de audio y silencia el video', () => {
  const r = applyOp(base(), { op: 'addClip', mediaId: 'a' })
  const q = applyOp(r.project, { op: 'separateAudio', clipId: r.createdId! })
  const audioTrack = q.project.tracks.find((t) => t.kind === 'audio')!
  assert.equal(audioTrack.clips[0].id, q.createdId)
  const v = q.project.tracks[0].clips[0]
  assert.equal(v.type === 'media' && v.volume, 0)
})

test('mover varios clips a la vez', () => {
  let p = run(base(), { op: 'addTrack', kind: 'video' })
  const t = p.tracks[1].id
  const a = applyOp(p, { op: 'addClip', mediaId: 'b', trackId: t, start: 0 })
  const b = applyOp(a.project, { op: 'addText', text: 'x', start: 1 * US })
  p = applyOp(b.project, { op: 'moveClips', clipIds: [a.createdId!, b.createdId!], delta: 2 * US }).project
  assert.equal(p.tracks[1].clips[0].start, 2 * US)
  assert.equal(p.tracks.find((x) => x.kind === 'text')!.clips[0].start, 3 * US)
})

test('subtítulos: tramos de la pista principal y tiempos con velocidad', () => {
  let p = run(base(), { op: 'addClip', mediaId: 'a', sourceIn: 2 * US, duration: 4 * US }, { op: 'addClip', mediaId: 'b' })
  const second = p.tracks[0].clips[1]
  p = run(p, { op: 'updateClip', clipId: second.id, patch: { speed: 2 } })
  const jobs = subtitleJobs(p)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].sourceIn, 2 * US)
  assert.equal(jobs[0].sourceDur, 4 * US)
  // A velocidad 2, el segundo 1 de la fuente cae medio segundo después del inicio del clip.
  const [seg] = toTimeline(jobs[1], [{ start: 1 * US, end: 2 * US, text: 'hola' }])
  assert.equal(seg.start, jobs[1].start + 0.5 * US)
  assert.equal(seg.end, jobs[1].start + 1 * US)
})

test('addSubtitles crea la pista "Subtítulos" y la reemplaza al regenerar', () => {
  let p = run(base(), { op: 'addClip', mediaId: 'a' })
  const segs = [
    { start: 0, end: 1 * US, text: 'uno' },
    { start: 1 * US, end: 2 * US, text: 'dos' }
  ]
  p = run(p, { op: 'addSubtitles', segments: segs })
  p = run(p, { op: 'addSubtitles', segments: segs.slice(0, 1) })
  const tracks = p.tracks.filter((t) => t.name === 'Subtítulos')
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].clips.length, 1)
  assert.equal(tracks[0].clips[0].type === 'text' && tracks[0].clips[0].text, 'uno')
})

test('retoque: sin puntos no hay deformación; con cara, los ojos más grandes generan escalas', async () => {
  const { retouchOps, FACE_POINTS, WARP_SCALE } = await import('../src/shared/retouch.ts')
  const { defaultRetouch } = await import('../src/shared/project.ts')
  const r = { ...defaultRetouch(), eyeSize: 1 }
  assert.equal(retouchOps(r, null, 16 / 9).warpN, 0)
  const face = new Float32Array(FACE_POINTS.length * 2)
  FACE_POINTS.forEach((_, i) => {
    face[i * 2] = 0.4 + (i % 7) * 0.03
    face[i * 2 + 1] = 0.3 + Math.floor(i / 7) * 0.05
  })
  const ops = retouchOps(r, { face, pose: null }, 16 / 9)
  assert.equal(ops.warpN, 2)
  assert.equal(ops.warpB[0], WARP_SCALE)
  assert.ok(ops.warpB[1] > 0)
  // Con la sección apagada no se deforma nada.
  assert.equal(retouchOps({ ...r, features: false }, { face, pose: null }, 16 / 9).warpN, 0)
})

test('retoque: el suavizado pide la cara y protege ojos, cejas y labios; nariz estereoscópica da luz y sombra', async () => {
  const { FACE_POINTS, needsFace, needsSkin, retouchOps, skinZones, ZONE_PROTECT, ZONE_WRINKLE, TONE_HIGHLIGHT, TONE_SHADOW } = await import('../src/shared/retouch.ts')
  const { defaultRetouch } = await import('../src/shared/project.ts')
  const { SKIN_TONES, skinToneXform, applyXform } = await import('../src/shared/skinTones.ts')
  const r = { ...defaultRetouch(), smooth: 0.4, wrinkles: 0.3 }
  assert.ok(needsFace(r) && needsSkin(r))
  // Cara sintética centrada.
  const pos: Record<number, [number, number]> = {
    10: [0.5, 0.2], 152: [0.5, 0.8], 234: [0.3, 0.5], 454: [0.7, 0.5], 468: [0.42, 0.42], 473: [0.58, 0.42],
    33: [0.37, 0.42], 133: [0.46, 0.42], 362: [0.54, 0.42], 263: [0.63, 0.42], 1: [0.5, 0.55], 129: [0.46, 0.57], 358: [0.54, 0.57],
    6: [0.5, 0.45], 168: [0.5, 0.42], 4: [0.5, 0.53], 61: [0.44, 0.66], 291: [0.56, 0.66], 0: [0.5, 0.63], 17: [0.5, 0.7],
    13: [0.5, 0.65], 14: [0.5, 0.67], 105: [0.41, 0.36], 334: [0.59, 0.36], 172: [0.36, 0.7], 397: [0.64, 0.7], 132: [0.32, 0.62], 361: [0.68, 0.62],
    159: [0.42, 0.41], 145: [0.42, 0.43], 386: [0.58, 0.41], 374: [0.58, 0.43]
  }
  const face = new Float32Array(FACE_POINTS.length * 2)
  FACE_POINTS.forEach((p, i) => face.set(pos[p] ?? [0.5, 0.5], i * 2))
  const z = skinZones({ face, pose: null }, 1)
  const kinds = Array.from({ length: z.zoneN }, (_, i) => z.zoneB[i * 4])
  assert.equal(kinds.filter((k) => k === ZONE_PROTECT).length, 6)
  assert.ok(kinds.filter((k) => k === ZONE_WRINKLE).length >= 7)
  // La zona protegida del ojo izquierdo está centrada en el ojo (uv con y hacia abajo,
  // igual que la textura: antes se volteaba y el retoque caía en el pecho).
  assert.ok(Math.abs(z.zoneA[0] - 0.42) < 1e-6 && Math.abs(z.zoneA[1] - 0.42) < 1e-6)
  assert.equal(skinZones(null, 1).zoneN, 0)

  const ops = retouchOps({ ...defaultRetouch(), noseStereo: 0.5 }, { face, pose: null }, 1)
  const tones = Array.from({ length: ops.toneN }, (_, i) => ops.toneB[i * 4])
  assert.equal(tones.filter((k) => k === TONE_HIGHLIGHT).length, 2)
  assert.equal(tones.filter((k) => k === TONE_SHADOW).length, 2)

  // Tonos de piel: nueve muestras de claro a oscuro; los colores viejos van al más parecido.
  assert.equal(SKIN_TONES.length, 9)
  assert.equal(skinToneXform('#d2a687'), SKIN_TONES[2])
  assert.ok(SKIN_TONES.includes(skinToneXform('#d9a47f') as never))
  const lighter = applyXform(SKIN_TONES[0], [0.62, 0.45, 0.36])
  const darker = applyXform(SKIN_TONES[8], [0.62, 0.45, 0.36])
  assert.ok(lighter[0] + lighter[1] > darker[0] + darker[1])
})
