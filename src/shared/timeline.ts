// Qué se ve y qué suena en un instante dado. Lo usan la vista previa y el motor de
// reproducción; sigue el mismo modelo de tiempo que la exportación (exportGraph.ts).

import { type Clip, type MediaClip, type Project, type TextClip, type Transition, clipEnd, sourceTime } from './project.ts'

export interface ClipFrame {
  clip: MediaClip
  /** Tiempo de la fuente en µs, ya limitado a la duración del medio. */
  source: number
}

export type Layer =
  | { kind: 'clip'; frame: ClipFrame }
  | { kind: 'transition'; a: ClipFrame; b: ClipFrame; transition: Transition; progress: number }
  | { kind: 'text'; clip: TextClip }

function frameOf(p: Project, clip: MediaClip, t: number): ClipFrame {
  const media = p.media[clip.mediaId]
  const max = media.kind === 'image' ? 0 : Math.max(0, media.duration - 1)
  return { clip, source: Math.min(max, Math.max(0, sourceTime(clip, t))) }
}

/** Capas visibles en `t`, de abajo hacia arriba. */
export function layersAt(p: Project, t: number): Layer[] {
  const layers: Layer[] = []
  const main = p.tracks[0]
  if (main && !main.hidden) {
    const clips = main.clips as MediaClip[]
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      const next = clips[i + 1]
      const prev = clips[i - 1]
      if (c.transition && next) {
        const half = c.transition.duration / 2
        const cut = clipEnd(c)
        if (t >= cut - half && t < cut + half) {
          layers.push({
            kind: 'transition',
            a: frameOf(p, c, t),
            b: frameOf(p, next, t),
            transition: c.transition,
            progress: (t - (cut - half)) / c.transition.duration
          })
          break
        }
      }
      const inPrevTransition = prev?.transition && t < c.start + prev.transition.duration / 2
      if (t >= c.start && t < clipEnd(c) && !inPrevTransition) {
        layers.push({ kind: 'clip', frame: frameOf(p, c, t) })
        break
      }
    }
  }
  for (const track of p.tracks.slice(1)) {
    if (track.hidden || track.kind === 'audio') continue
    for (const c of track.clips) {
      if (t < c.start || t >= clipEnd(c)) continue
      if (c.type === 'text') layers.push({ kind: 'text', clip: c })
      else if (p.media[c.mediaId]?.kind !== 'audio') layers.push({ kind: 'clip', frame: frameOf(p, c, t) })
    }
  }
  return layers
}

export interface AudibleClip {
  clip: MediaClip
  source: number
  gain: number
}

/** Clips que suenan en `t` con su ganancia (volumen × fundidos), igual que en la exportación. */
export function audibleAt(p: Project, t: number): AudibleClip[] {
  const out: AudibleClip[] = []
  for (const track of p.tracks) {
    if (track.muted) continue
    for (const c of track.clips as Clip[]) {
      if (c.type !== 'media' || t < c.start || t >= clipEnd(c)) continue
      const media = p.media[c.mediaId]
      if (!media?.hasAudio || media.kind === 'image') continue
      let gain = c.volume
      if (c.fadeIn > 0) gain *= Math.min(1, (t - c.start) / c.fadeIn)
      if (c.fadeOut > 0) gain *= Math.min(1, (clipEnd(c) - t) / c.fadeOut)
      out.push({ clip: c, source: sourceTime(c, t), gain })
    }
  }
  return out
}

/** Clips que conviene tener cargados alrededor de `t` (para que no haya tirones). */
export function clipsNear(p: Project, t: number, before: number, after: number): MediaClip[] {
  const out: MediaClip[] = []
  for (const track of p.tracks)
    for (const c of track.clips) {
      if (c.type !== 'media') continue
      if (clipEnd(c) + before >= t && c.start - after <= t) out.push(c)
    }
  return out
}
