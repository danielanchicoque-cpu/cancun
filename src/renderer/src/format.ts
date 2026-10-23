import { US } from '@shared/project'

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0')

/** HH:MM:SS:FF, como el reproductor de CapCut. */
export function timecode(us: number, fps: number): string {
  const total = Math.max(0, us) / US
  const frames = Math.floor((total % 1) * fps + 1e-6)
  return `${pad(total / 3600)}:${pad((total / 60) % 60)}:${pad(total % 60)}:${pad(frames)}`
}

export function shortTime(us: number): string {
  const s = Math.max(0, us) / US
  return s >= 3600 ? `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}` : `${pad(s / 60)}:${pad(s % 60)}`
}

export function seconds(us: number): string {
  return `${(us / US).toFixed(1)}s`
}

export const gainToDb = (g: number): number => (g <= 0 ? -60 : 20 * Math.log10(g))
export const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20))
