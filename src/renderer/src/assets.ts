// Miniaturas y formas de onda por medio, con caché en memoria.

import { useEffect, useState } from 'react'
import type { Media } from '@shared/project'
import { api, mediaUrl } from './api'

export interface Strip {
  image: HTMLImageElement
  url: string
  frames: number
}

const strips = new Map<string, Promise<Strip>>()
const waves = new Map<string, Promise<number[]>>()

function loadStrip(media: Media): Promise<Strip> {
  let p = strips.get(media.path)
  if (!p) {
    p = window.cancun.media.filmstrip(media).then(
      ({ path, frames }: { path: string; frames: number }) =>
        new Promise<Strip>((resolve, reject) => {
          const image = new Image()
          const url = mediaUrl(path)
          image.onload = () => resolve({ image, url, frames })
          image.onerror = reject
          image.src = url
        })
    )
    strips.set(media.path, p)
    p.catch(() => strips.delete(media.path))
  }
  return p
}

export function useStrip(media: Media | undefined): Strip | null {
  const [strip, setStrip] = useState<Strip | null>(null)
  useEffect(() => {
    if (!media || media.kind === 'audio') return
    let alive = true
    loadStrip(media).then((s) => alive && setStrip(s)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [media?.path])
  return strip
}

/** URL de la tira (para miniaturas de la biblioteca: se muestra el primer cuadro). */
export function useFilmstrip(media: Media | undefined): string | null {
  return useStrip(media)?.url ?? null
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
