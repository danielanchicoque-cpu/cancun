// Qué partes del proyecto se transcriben para los subtítulos y cómo se pasan los
// tiempos del audio a la línea de tiempo. Puro: lo usan la interfaz y el CLI.

import { type Id, type MediaClip, type Project, clipEnd } from './project.ts'

/** Un tramo de audio a transcribir: `sourceIn`/`sourceDur` en tiempo del archivo (µs). */
export interface SubtitleJob {
  clipId: Id
  path: string
  sourceIn: number
  sourceDur: number
  /** Inicio del clip en la línea de tiempo y su velocidad, para volver a mapear. */
  start: number
  end: number
  speed: number
}

export interface TimedText {
  start: number
  end: number
  text: string
}

/**
 * Clips con voz: los elegidos (si hay alguno con audio) o, si no, los de la pista principal.
 * Se saltan los congelados, los silenciados y los de pistas silenciadas.
 */
export function subtitleJobs(p: Project, selection: Id[] = []): SubtitleJob[] {
  const usable = (c: MediaClip, muted: boolean) => {
    const m = p.media[c.mediaId]
    return !!m && m.kind !== 'image' && m.hasAudio !== false && !c.freeze && c.volume > 0 && !muted
  }
  const all = p.tracks.flatMap((t) => t.clips.filter((c): c is MediaClip => c.type === 'media' && usable(c, t.muted)))
  const chosen = all.filter((c) => selection.includes(c.id))
  const main = p.tracks[0]?.clips.filter((c): c is MediaClip => c.type === 'media' && usable(c, p.tracks[0].muted)) ?? []
  const clips = chosen.length ? chosen : main
  return clips
    .map((c) => ({
      clipId: c.id,
      path: p.media[c.mediaId].path,
      sourceIn: c.sourceIn,
      sourceDur: c.duration * c.speed,
      start: c.start,
      end: clipEnd(c),
      speed: c.speed
    }))
    .sort((a, b) => a.start - b.start)
}

/** Pasa los segmentos (tiempo dentro del tramo transcrito) a tiempo de la línea de tiempo. */
export function toTimeline(job: SubtitleJob, segments: TimedText[]): TimedText[] {
  return segments
    .map((s) => ({
      text: s.text,
      start: Math.round(job.start + s.start / job.speed),
      end: Math.min(job.end, Math.round(job.start + s.end / job.speed))
    }))
    .filter((s) => s.end > s.start && s.start < job.end)
}
