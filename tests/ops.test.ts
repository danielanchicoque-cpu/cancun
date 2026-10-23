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
