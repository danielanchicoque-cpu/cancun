// Operaciones de edición. Son la única forma de cambiar un proyecto: las usa la
// interfaz, el CLI y el historial de deshacer, así que todas se comportan igual.

import {
  type Clip,
  type ExportSettings,
  type Id,
  type LutRef,
  type Media,
  type MediaClip,
  type Project,
  type TextClip,
  type TextStyle,
  type Track,
  type TrackKind,
  type Transition,
  US,
  clipEnd,
  defaultAdjust,
  defaultAudioFx,
  defaultBackground,
  defaultRetouch,
  defaultTextStyle,
  defaultTransform,
  findClip,
  newId
} from './project.ts'

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object | null ? DeepPartial<T[K]> | null : T[K] }

export type Op =
  | { op: 'rename'; name: string }
  | { op: 'setCanvas'; width?: number; height?: number; fps?: number; background?: string }
  | { op: 'setExport'; patch: Partial<ExportSettings> }
  | { op: 'addMedia'; media: Media }
  | { op: 'removeMedia'; mediaId: Id }
  | { op: 'addTrack'; kind: TrackKind; name?: string }
  | { op: 'updateTrack'; trackId: Id; patch: Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>> }
  | { op: 'removeTrack'; trackId: Id }
  | {
      op: 'addClip'
      mediaId: Id
      trackId?: Id
      start?: number
      sourceIn?: number
      duration?: number
    }
  | { op: 'addText'; text: string; start: number; duration?: number; trackId?: Id; style?: Partial<TextStyle> }
  | { op: 'moveClip'; clipId: Id; start: number; trackId?: Id }
  | { op: 'trimClip'; clipId: Id; side: 'start' | 'end'; time: number }
  | { op: 'splitClip'; clipId: Id; at: number }
  | { op: 'deleteClip'; clipId: Id }
  | { op: 'updateClip'; clipId: Id; patch: DeepPartial<Omit<MediaClip, 'id' | 'type'>> | DeepPartial<Omit<TextClip, 'id' | 'type'>> }
  | { op: 'setLut'; clipId: Id; lut: LutRef | null }
  | { op: 'setTransition'; clipId: Id; transition: Transition | null }

export interface OpResult {
  project: Project
  /** Id del elemento creado (clip, pista, medio), si aplica. */
  createdId?: Id
}

export class OpError extends Error {}

const MIN_CLIP = Math.round(US / 30)
const IMAGE_DEFAULT = 5 * US
const TEXT_DEFAULT = 3 * US

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(target)) return patch as T
  const out: Record<string, unknown> = { ...target }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

function requireTrack(p: Project, trackId: Id): Track {
  const t = p.tracks.find((x) => x.id === trackId)
  if (!t) throw new OpError(`No existe la pista ${trackId}`)
  return t
}

function requireClip(p: Project, clipId: Id) {
  const found = findClip(p, clipId)
  if (!found) throw new OpError(`No existe el clip ${clipId}`)
  if (found.track.locked) throw new OpError(`La pista "${found.track.name}" está bloqueada`)
  return found
}

function trackKindFor(media: Media): TrackKind {
  return media.kind === 'audio' ? 'audio' : 'video'
}

const isMainTrack = (p: Project, t: Track) => p.tracks[0] === t

function sortClips(t: Track) {
  t.clips.sort((a, b) => a.start - b.start)
}

/** La pista principal es magnética, como en CapCut: los clips quedan pegados sin huecos. */
function compactMain(p: Project) {
  const main = p.tracks[0]
  if (!main) return
  sortClips(main)
  let cursor = 0
  for (const c of main.clips) {
    c.start = cursor
    cursor = clipEnd(c)
  }
  for (let i = 0; i < main.clips.length; i++) {
    const c = main.clips[i]
    if (c.type === 'media' && c.transition) {
      const next = main.clips[i + 1]
      if (!next) c.transition = null
      else c.transition.duration = Math.min(c.transition.duration, c.duration / 2, next.duration / 2)
    }
  }
}

function overlaps(t: Track, start: number, end: number, ignore?: Id): boolean {
  return t.clips.some((c) => c.id !== ignore && c.start < end && clipEnd(c) > start)
}

function addTrack(p: Project, kind: TrackKind, name?: string): Track {
  const count = p.tracks.filter((t) => t.kind === kind).length
  const label = { video: 'Video', audio: 'Audio', text: 'Texto' }[kind]
  const track: Track = {
    id: newId(),
    kind,
    name: name ?? `${label} ${count + 1}`,
    muted: false,
    hidden: false,
    locked: false,
    clips: []
  }
  p.tracks.push(track)
  return track
}

/** Primera pista del tipo dado donde cabe el rango; si ninguna, crea una nueva encima. */
function freeTrack(p: Project, kind: TrackKind, start: number, end: number, preferred?: Track, ignore?: Id): Track {
  if (preferred && preferred.kind === kind && !preferred.locked) {
    if (isMainTrack(p, preferred) || !overlaps(preferred, start, end, ignore)) return preferred
  }
  for (const t of p.tracks) {
    if (t.kind !== kind || t.locked || isMainTrack(p, t)) continue
    if (!overlaps(t, start, end, ignore)) return t
  }
  return addTrack(p, kind)
}

function newMediaClip(media: Media, start: number, sourceIn: number, duration: number): MediaClip {
  return {
    id: newId(),
    type: 'media',
    mediaId: media.id,
    start,
    duration,
    sourceIn,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: defaultTransform(),
    color: { lut: null, adjust: defaultAdjust() },
    retouch: defaultRetouch(),
    background: defaultBackground(),
    audioFx: defaultAudioFx(),
    transition: null
  }
}

function mediaAvailable(media: Media, clip: MediaClip): number {
  return media.kind === 'image' ? Infinity : (media.duration - clip.sourceIn) / clip.speed
}

export function applyOp(project: Project, op: Op): OpResult {
  const p = structuredClone(project)
  let createdId: Id | undefined

  switch (op.op) {
    case 'rename':
      p.name = op.name
      break

    case 'setCanvas':
      if (op.width !== undefined) p.canvas.width = op.width
      if (op.height !== undefined) p.canvas.height = op.height
      if (op.fps !== undefined) p.canvas.fps = op.fps
      if (op.background !== undefined) p.canvas.background = op.background
      p.export.width = p.canvas.width
      p.export.height = p.canvas.height
      p.export.fps = p.canvas.fps
      break

    case 'setExport':
      p.export = { ...p.export, ...op.patch }
      break

    case 'addMedia':
      p.media[op.media.id] = op.media
      createdId = op.media.id
      break

    case 'removeMedia':
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !(c.type === 'media' && c.mediaId === op.mediaId))
      delete p.media[op.mediaId]
      compactMain(p)
      break

    case 'addTrack':
      createdId = addTrack(p, op.kind, op.name).id
      break

    case 'updateTrack':
      Object.assign(requireTrack(p, op.trackId), op.patch)
      break

    case 'removeTrack': {
      const t = requireTrack(p, op.trackId)
      if (isMainTrack(p, t)) throw new OpError('La pista principal no se puede eliminar')
      p.tracks = p.tracks.filter((x) => x !== t)
      break
    }

    case 'addClip': {
      const media = p.media[op.mediaId]
      if (!media) throw new OpError(`No existe el medio ${op.mediaId}`)
      const sourceIn = op.sourceIn ?? 0
      const maxLen = media.kind === 'image' ? Infinity : media.duration - sourceIn
      if (maxLen <= 0) throw new OpError('El punto de entrada está después del final del medio')
      const duration = Math.max(MIN_CLIP, Math.min(op.duration ?? (media.kind === 'image' ? IMAGE_DEFAULT : maxLen), maxLen))
      const kind = trackKindFor(media)
      const preferred = op.trackId ? requireTrack(p, op.trackId) : kind === 'video' ? p.tracks[0] : undefined
      const start = op.start ?? (preferred && isMainTrack(p, preferred) ? Infinity : 0)
      const track = freeTrack(p, kind, start === Infinity ? 0 : start, (start === Infinity ? 0 : start) + duration, preferred)
      const clip = newMediaClip(media, start === Infinity ? Number.MAX_SAFE_INTEGER : start, sourceIn, duration)
      track.clips.push(clip)
      sortClips(track)
      if (isMainTrack(p, track)) compactMain(p)
      createdId = clip.id
      break
    }

    case 'addText': {
      const duration = op.duration ?? TEXT_DEFAULT
      const preferred = op.trackId ? requireTrack(p, op.trackId) : undefined
      const track = freeTrack(p, 'text', op.start, op.start + duration, preferred)
      const clip: TextClip = {
        id: newId(),
        type: 'text',
        start: op.start,
        duration,
        text: op.text,
        style: { ...defaultTextStyle(), ...op.style },
        transform: { ...defaultTransform(), y: 0.6 }
      }
      track.clips.push(clip)
      sortClips(track)
      createdId = clip.id
      break
    }

    case 'moveClip': {
      const { track, clip, index } = requireClip(p, op.clipId)
      const target = op.trackId ? requireTrack(p, op.trackId) : track
      const kind = clip.type === 'text' ? 'text' : track.kind
      if (target.kind !== kind) throw new OpError(`Un clip de ${kind} no puede ir en una pista de ${target.kind}`)
      track.clips.splice(index, 1)
      const start = Math.max(0, Math.round(op.start))
      const dest = freeTrack(p, kind, start, start + clip.duration, target, clip.id)
      clip.start = start
      if (isMainTrack(p, dest) && !isMainTrack(p, track)) {
        // Insertar en la principal: entra en el hueco más cercano al punto soltado.
        clip.start = start - 0.5
      }
      dest.clips.push(clip)
      sortClips(dest)
      if (isMainTrack(p, dest) || isMainTrack(p, track)) compactMain(p)
      break
    }

    case 'trimClip': {
      const { track, clip } = requireClip(p, op.clipId)
      const t = Math.round(op.time)
      if (op.side === 'start') {
        const delta = Math.min(t - clip.start, clip.duration - MIN_CLIP)
        if (clip.type === 'media') {
          const media = p.media[clip.mediaId]
          const minDelta = media.kind === 'image' ? -clip.start : -clip.sourceIn / clip.speed
          const d = Math.max(delta, minDelta, -clip.start)
          clip.sourceIn += d * clip.speed
          clip.start += d
          clip.duration -= d
        } else {
          const d = Math.max(delta, -clip.start)
          clip.start += d
          clip.duration -= d
        }
      } else {
        let duration = Math.max(MIN_CLIP, t - clip.start)
        if (clip.type === 'media') duration = Math.min(duration, mediaAvailable(p.media[clip.mediaId], clip))
        clip.duration = duration
      }
      if (isMainTrack(p, track)) compactMain(p)
      break
    }

    case 'splitClip': {
      const { track, clip, index } = requireClip(p, op.clipId)
      const at = Math.round(op.at)
      if (at <= clip.start + MIN_CLIP || at >= clipEnd(clip) - MIN_CLIP) {
        throw new OpError('El punto de corte debe quedar dentro del clip')
      }
      const right = structuredClone(clip)
      right.id = newId()
      const leftDur = at - clip.start
      right.start = at
      right.duration = clip.duration - leftDur
      clip.duration = leftDur
      if (right.type === 'media' && clip.type === 'media') {
        right.sourceIn = clip.sourceIn + leftDur * clip.speed
        right.fadeIn = 0
        clip.fadeOut = 0
        clip.transition = null
      }
      track.clips.splice(index + 1, 0, right)
      createdId = right.id
      break
    }

    case 'deleteClip': {
      const { track, index } = requireClip(p, op.clipId)
      track.clips.splice(index, 1)
      if (isMainTrack(p, track)) compactMain(p)
      break
    }

    case 'updateClip': {
      const { track, clip, index } = requireClip(p, op.clipId)
      const merged = deepMerge(clip, op.patch) as Clip
      merged.id = clip.id
      merged.type = clip.type
      if (merged.type === 'media' && clip.type === 'media' && merged.speed !== clip.speed) {
        if (merged.speed <= 0) throw new OpError('La velocidad debe ser mayor que 0')
        // Cambiar la velocidad conserva el mismo tramo de la fuente, como en CapCut.
        merged.duration = Math.max(MIN_CLIP, Math.round((clip.duration * clip.speed) / merged.speed))
      }
      track.clips[index] = merged
      if (isMainTrack(p, track)) compactMain(p)
      break
    }

    case 'setLut': {
      const { clip } = requireClip(p, op.clipId)
      if (clip.type !== 'media') throw new OpError('Los LUT solo se aplican a clips de video o imagen')
      clip.color.lut = op.lut ? { ...op.lut, intensity: Math.min(1, Math.max(0, op.lut.intensity)) } : null
      break
    }

    case 'setTransition': {
      const { track, clip, index } = requireClip(p, op.clipId)
      if (clip.type !== 'media') throw new OpError('Las transiciones van entre clips de video')
      const next = track.clips[index + 1]
      if (op.transition && (!next || next.start !== clipEnd(clip))) {
        throw new OpError('La transición necesita un clip pegado a continuación')
      }
      clip.transition = op.transition
      if (isMainTrack(p, track)) compactMain(p)
      break
    }
  }

  p.updatedAt = new Date().toISOString()
  return { project: p, createdId }
}
