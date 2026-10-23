// Miniaturas y formas de onda por medio, con caché en memoria.

import { useEffect, useState } from 'react'
import type { Media } from '@shared/project'
import { api, mediaUrl } from './api'

const strips = new Map<string, Promise<string>>()
const waves = new Map<string, Promise<number[]>>()

export function useFilmstrip(media: Media | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!media || media.kind === 'audio') return
    let p = strips.get(media.path)
    if (!p) {
      p = api.filmstrip(media).then(mediaUrl)
      strips.set(media.path, p)
    }
    let alive = true
    p.then((u) => alive && setUrl(u)).catch(() => strips.delete(media.path))
    return () => {
      alive = false
    }
  }, [media?.path])
  return url
}

export function useWaveform(media: Media | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    if (!media || !media.hasAudio || media.kind === 'image') return
    let p = waves.get(media.path)
    if (!p) {
      p = api.waveform(media)
      waves.set(media.path, p)
    }
    let alive = true
    p.then((w) => alive && setPeaks(w)).catch(() => waves.delete(media.path))
    return () => {
      alive = false
    }
  }, [media?.path])
  return peaks
}
