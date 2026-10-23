import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyOp } from '../src/shared/ops.ts'
import { type Media, type Project, US, newProject } from '../src/shared/project.ts'
import { buildExport, exportSize, volumeExpr } from '../src/shared/exportGraph.ts'

const FFMPEG = existsSync('vendor/ffmpeg/ffmpeg.exe') ? resolve('vendor/ffmpeg/ffmpeg.exe') : 'ffmpeg'
const fx = (f: string) => resolve('tests/fixtures', f).split('\\').join('/')

// Clips de prueba generados con ffmpeg (no se versionan).
function ensureFixtures() {
  mkdirSync(resolve('tests/fixtures'), { recursive: true })
  const make = (file: string, video: string, freq: number, d: number) => {
    if (existsSync(fx(file))) return
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `${video}:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=f=${freq}:d=${d}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fx(file)])
  }
  make('a.mp4', 'testsrc2=s=1280x720', 440, 6)
  make('b.mp4', 'smptebars=s=720x1280', 660, 4)
}

function media(id: string, path: string, seconds: number, w: number, h: number): Media {
  return { id, kind: 'video', path, name: id, duration: seconds * US, width: w, height: h, hasAudio: true }
}

function sample(): Project {
  ensureFixtures()
  let p = newProject('prueba', 1280, 720, 30)
  p = applyOp(p, { op: 'addMedia', media: media('a', fx('a.mp4'), 6, 1280, 720) }).project
  p = applyOp(p, { op: 'addMedia', media: media('b', fx('b.mp4'), 4, 720, 1280) }).project
  const a = applyOp(p, { op: 'addClip', mediaId: 'a', sourceIn: 1 * US, duration: 3 * US })
  p = applyOp(a.project, { op: 'addClip', mediaId: 'b' }).project
  p = applyOp(p, { op: 'setKeyframe', clipId: a.createdId!, prop: 'volume', time: 0, value: 0, ease: 'linear' }).project
  p = applyOp(p, { op: 'setKeyframe', clipId: a.createdId!, prop: 'volume', time: 2 * US, value: 1, ease: 'linear' }).project
  return applyOp(p, { op: 'updateClip', clipId: a.createdId!, patch: { audioFx: { normalize: true } } }).project
}

test('el volumen con keyframes se convierte en una expresión por tramos', () => {
  const p = sample()
  const clip = p.tracks[0].clips[0]
  assert.ok(clip.type === 'media')
  const expr = volumeExpr(clip)
  assert.match(expr, /^if\(lt\(t,/)
  assert.ok(expr.length < 20000)
})

test('el ancho de exportación es múltiplo de 8 (lo exige el empaquetado YUV)', () => {
  const p = sample()
  p.export.width = 1083
  p.export.height = 1921
  const s = exportSize(p)
  assert.equal(s.width % 8, 0)
  assert.equal(s.height % 2, 0)
})

test('ffmpeg recibe el video por stdin y mezcla el audio de los clips', async () => {
  const p = sample()
  const tmp = mkdtempSync(join(tmpdir(), 'cancun-'))
  const out = join(tmp, 'out.mp4')
  const filterPath = join(tmp, 'audio.txt').split('\\').join('/')
  const plan = buildExport(p, { output: out, encoder: 'libx264', filterPath })
  if (plan.filter) writeFileSync(filterPath, plan.filter)
  // Cuadros sintéticos en lugar del compositor GPU.
  const src = spawn(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${plan.width}x${plan.height}:r=${plan.fps}`, '-frames:v', String(plan.frames), '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'])
  const enc = spawn(FFMPEG, plan.args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let err = ''
  enc.stderr.on('data', (d) => (err = (err + d).slice(-3000)))
  src.stdout.pipe(enc.stdin)
  const code = await new Promise((r) => enc.on('close', r))
  assert.equal(code, 0, err)
  const info = execFileSync(FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'csv=p=0', out]).toString()
  assert.match(info, /audio/)
  const dur = Number(info.trim().split(/\s+/).pop())
  assert.ok(Math.abs(dur - 7) < 0.15, `duración ${dur}`)
})
