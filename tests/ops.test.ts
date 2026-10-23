import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOp, type Op } from '../src/shared/ops.ts'
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
