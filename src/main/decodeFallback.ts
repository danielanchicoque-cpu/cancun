// Plan B de decodificación para formatos que WebCodecs no abre (MKV, AVI, WebM con
// códecs raros…): ffmpeg entrega cuadros RGBA en orden y la ventana los pide uno a uno.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { US } from '@shared/project'
import { FFMPEG } from './media'

interface Stream {
  child: ChildProcessWithoutNullStreams
  frameSize: number
  buffer: Buffer[]
  buffered: number
  ended: boolean
  waiters: (() => void)[]
}

const streams = new Map<number, Stream>()
let nextId = 1
const MAX_BUFFERED_FRAMES = 8

export function openDecode(path: string, startUs: number, rate: number, w: number, h: number): number {
  const child = spawn(
    FFMPEG,
    ['-v', 'error', '-ss', (startUs / US).toFixed(6), '-i', path, '-an', '-vf', `fps=${rate.toFixed(6)},scale=${w}:${h}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { windowsHide: true }
  )
  const s: Stream = { child, frameSize: w * h * 4, buffer: [], buffered: 0, ended: false, waiters: [] }
  const wake = () => s.waiters.splice(0).forEach((f) => f())
  child.stdout.on('data', (d: Buffer) => {
    s.buffer.push(d)
    s.buffered += d.length
    if (s.buffered > s.frameSize * MAX_BUFFERED_FRAMES) child.stdout.pause()
    wake()
  })
  child.on('close', () => {
    s.ended = true
    wake()
  })
  const id = nextId++
  streams.set(id, s)
  return id
}

export async function nextFrame(id: number): Promise<Uint8Array | null> {
  const s = streams.get(id)
  if (!s) return null
  while (s.buffered < s.frameSize && !s.ended) {
    s.child.stdout.resume()
    await new Promise<void>((r) => s.waiters.push(r))
  }
  if (s.buffered < s.frameSize) return null
  const all = Buffer.concat(s.buffer)
  const frame = all.subarray(0, s.frameSize)
  const rest = all.subarray(s.frameSize)
  s.buffer = rest.length ? [rest] : []
  s.buffered = rest.length
  if (s.buffered < s.frameSize * MAX_BUFFERED_FRAMES) s.child.stdout.resume()
  return new Uint8Array(frame)
}

export function closeDecode(id: number) {
  const s = streams.get(id)
  if (!s) return
  s.child.kill()
  streams.delete(id)
}
