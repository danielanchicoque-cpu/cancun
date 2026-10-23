import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyOp } from '../src/shared/ops.ts'
import { type Media, type Project, US, newProject } from '../src/shared/project.ts'
import { buildExport } from '../src/shared/exportGraph.ts'
import { parseCube, type CubeLut } from '../src/shared/cube.ts'

const fx = (f: string) => resolve('tests/fixtures', f).split('\\').join('/')
const her = 'C:/Users/USUARIO 1/AppData/Local/CapCut/User Data/Resources/Lut/Her/Her.cube'

// Clips de prueba generados con ffmpeg (no se versionan).
function ensureFixtures() {
  mkdirSync(resolve('tests/fixtures'), { recursive: true })
  const make = (file: string, video: string, freq: number, d: number) => {
    if (existsSync(fx(file))) return
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `${video}:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=f=${freq}:d=${d}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fx(file)])
  }
  make('a.mp4', 'testsrc2=s=1280x720', 440, 6)
  make('b.mp4', 'smptebars=s=720x1280', 660, 4)
}

function media(id: string, path: string, seconds: number, w: number, h: number): Media {
  return { id, kind: 'video', path, name: id, duration: seconds * US, width: w, height: h, hasAudio: true }
}

function sample(): { p: Project; luts: Map<string, CubeLut> } {
  ensureFixtures()
  let p = newProject('prueba', 1280, 720, 30)
  p = applyOp(p, { op: 'addMedia', media: media('a', fx('a.mp4'), 6, 1280, 720) }).project
  p = applyOp(p, { op: 'addMedia', media: media('b', fx('b.mp4'), 4, 720, 1280) }).project
  const a = applyOp(p, { op: 'addClip', mediaId: 'a', sourceIn: 1 * US, duration: 3 * US })
  p = applyOp(a.project, { op: 'addClip', mediaId: 'b' }).project
  p = applyOp(p, { op: 'setTransition', clipId: a.createdId!, transition: { kind: 'slideleft', duration: 1 * US } }).project
  const luts = new Map<string, CubeLut>()
  if (existsSync(her)) {
    luts.set(her, parseCube(readFileSync(her, 'utf8')))
    p = applyOp(p, { op: 'setLut', clipId: a.createdId!, lut: { path: her, name: 'Her', intensity: 0.8 } }).project
  }
  p = applyOp(p, { op: 'updateClip', clipId: a.createdId!, patch: { color: { adjust: { contrast: 0.2, saturation: -0.3 } } } }).project
  const ov = applyOp(p, { op: 'addTrack', kind: 'video' })
  const o = applyOp(ov.project, { op: 'addClip', mediaId: 'a', trackId: ov.createdId!, start: 2 * US, duration: 2 * US })
  p = applyOp(o.project, { op: 'updateClip', clipId: o.createdId!, patch: { transform: { scale: 0.3, x: 0.6, y: -0.6, rotation: 15 }, volume: 0 } }).project
  p = applyOp(p, { op: 'addText', text: 'Hola Cancún', start: 0.5 * US, duration: 3 * US, style: { strokeWidth: 1 } }).project
  return { p, luts }
}

test('el grafo exporta un MP4 válido con la duración del proyecto', () => {
  const { p, luts } = sample()
  const tmp = mkdtempSync(join(tmpdir(), 'cancun-'))
  const out = join(tmp, 'out.mp4')
  const plan = buildExport(p, { output: out, tmpDir: tmp, luts, fontDir: 'C:/Windows/Fonts', encoder: 'libx264' })
  for (const f of plan.files) writeFileSync(f.path, f.content)
  const run = spawnSync('ffmpeg', plan.args, { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr.slice(-3000))
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
  assert.ok(Math.abs(dur - 7) < 0.15, `duración ${dur}`)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2.6', '-i', out, '-frames:v', '1', join(resolve('tests/fixtures'), 'frame-transition.jpg')])
})
