// Qué se ve y qué suena en un instante dado. Lo usan la vista previa y el motor de
// exportación (el mismo compositor), así que ambos muestran exactamente lo mismo.

import { resolveClip } from './animate.ts'
import {
  type AdjustClip,
  type Clip,
  type EffectClip,
  type MediaClip,
  type Project,
  type TextClip,
  type Transition,
  clipEnd,
  sourceTime
} from './project.ts'

export interface ClipFrame {
  /** Clip con keyframes y animaciones ya aplicados para este instante. */
  clip: MediaClip
  /** Tiempo de la fuente en µs, ya limitado a la duración del medio. */
  source: number
}

export type Layer =
  | { kind: 'clip'; frame: ClipFrame }
  | { kind: 'transition'; a: ClipFrame; b: ClipFrame; transition: Transition; progress: number }
  | { kind: 'text'; clip: TextClip }
  | { kind: 'effect'; clip: EffectClip; local: number }
  | { kind: 'adjust'; clip: AdjustClip }

function frameOf(p: Project, clip: MediaClip, t: number): ClipFrame {
  const media = p.media[clip.mediaId]
  const max = media.kind === 'image' ? 0 : Math.max(0, media.duration - 1)
  const at = Math.min(clipEnd(clip) - 1, Math.max(clip.start, t))
  return { clip: resolveClip(clip, at), source: Math.min(max, Math.max(0, sourceTime(clip, t))) }
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
    for (const c of track.clips as Clip[]) {
      if (t < c.start || t >= clipEnd(c)) continue
      if (c.type === 'text') layers.push({ kind: 'text', clip: resolveClip(c, t) })
      else if (c.type === 'effect') layers.push({ kind: 'effect', clip: c, local: t - c.start })
      else if (c.type === 'adjust') layers.push({ kind: 'adjust', clip: resolveClip(c, t) })
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

/** Ganancia de un clip en `t`: volumen (con keyframes) × fundidos. */
export function clipGain(c: MediaClip, t: number): number {
  let gain = c.keyframes.volume?.length ? resolveClip(c, t).volume : c.volume
  if (c.fadeIn > 0) gain *= Math.min(1, (t - c.start) / c.fadeIn)
  if (c.fadeOut > 0) gain *= Math.min(1, (clipEnd(c) - t) / c.fadeOut)
  return Math.max(0, gain)
}

/** Clips que suenan en `t` con su ganancia, igual que en la exportación. */
export function audibleAt(p: Project, t: number): AudibleClip[] {
  const out: AudibleClip[] = []
  for (const track of p.tracks) {
    if (track.muted) continue
    for (const c of track.clips as Clip[]) {
      if (c.type !== 'media' || c.freeze || t < c.start || t >= clipEnd(c)) continue
      const media = p.media[c.mediaId]
      if (!media?.hasAudio || media.kind === 'image') continue
      out.push({ clip: c, source: sourceTime(c, t), gain: clipGain(c, t) })
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
