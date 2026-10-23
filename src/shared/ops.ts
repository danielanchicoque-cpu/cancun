// Operaciones de edición. Son la única forma de cambiar un proyecto: las usa la
// interfaz, el CLI y el historial de deshacer, así que todas se comportan igual.

import { getPath, resolveClip } from './animate.ts'
import {
  type Clip,
  type EditorSettings,
  type EffectClip,
  type Easing,
  type ExportSettings,
  type Id,
  type KeyProp,
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
  defaultAnimations,
  defaultAudioFx,
  defaultBackground,
  defaultCrop,
  defaultLight,
  defaultMask,
  defaultRetouch,
  defaultTextStyle,
  defaultTransform,
  findClip,
  newId
} from './project.ts'

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object | null ? DeepPartial<T[K]> | null : T[K] }

/** `trackId: 'new'` crea una pista nueva encima de las demás de su tipo. */
type TrackTarget = Id | 'new'

export type ClipPatch =
  | DeepPartial<Omit<MediaClip, 'id' | 'type'>>
  | DeepPartial<Omit<TextClip, 'id' | 'type'>>
  | DeepPartial<Omit<EffectClip, 'id' | 'type'>>

export type Op =
  | { op: 'rename'; name: string }
  | { op: 'setCanvas'; width?: number; height?: number; fps?: number; background?: string }
  | { op: 'setExport'; patch: Partial<ExportSettings> }
  | { op: 'setSettings'; patch: Partial<EditorSettings> }
  | { op: 'addMedia'; media: Media }
  | { op: 'removeMedia'; mediaId: Id }
  | { op: 'addTrack'; kind: TrackKind; name?: string }
  | { op: 'updateTrack'; trackId: Id; patch: Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>> }
  | { op: 'removeTrack'; trackId: Id }
  | { op: 'addClip'; mediaId: Id; trackId?: TrackTarget; start?: number; sourceIn?: number; duration?: number }
  | { op: 'addText'; text: string; start: number; duration?: number; trackId?: TrackTarget; style?: Partial<TextStyle> }
  | { op: 'addEffect'; effect: string; start: number; duration?: number; params?: Record<string, number> }
  | { op: 'moveClip'; clipId: Id; start: number; trackId?: TrackTarget }
  | { op: 'moveClips'; clipIds: Id[]; delta: number }
  | { op: 'trimClip'; clipId: Id; side: 'start' | 'end'; time: number }
  | { op: 'splitClip'; clipId: Id; at: number }
  | { op: 'deleteClip'; clipId: Id }
  | { op: 'deleteClips'; clipIds: Id[] }
  | { op: 'duplicateClip'; clipId: Id }
  | { op: 'separateAudio'; clipId: Id }
  | { op: 'freezeFrame'; clipId: Id; at: number; duration?: number }
  | { op: 'updateClip'; clipId: Id; patch: ClipPatch }
  | { op: 'setLut'; clipId: Id; lut: LutRef | null }
  | { op: 'setTransition'; clipId: Id; transition: Transition | null }
  | { op: 'setKeyframe'; clipId: Id; prop: KeyProp; time: number; value?: number; ease?: Easing }
  | { op: 'removeKeyframe'; clipId: Id; prop: KeyProp; time: number }
  | { op: 'clearKeyframes'; clipId: Id; prop?: KeyProp }

export interface OpResult {
  project: Project
  /** Id del elemento creado (clip, pista, medio), si aplica. */
  createdId?: Id
}

export class OpError extends Error {}

const MIN_CLIP = Math.round(US / 30)
const IMAGE_DEFAULT = 5 * US
const TEXT_DEFAULT = 3 * US
const EFFECT_DEFAULT = 3 * US
const FREEZE_DEFAULT = 3 * US
/** Dos keyframes a menos de esto se consideran el mismo (medio cuadro a 60 fps). */
const KEY_EPS = Math.round(US / 120)

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

const isMainTrack = (p: Project, t: Track) => p.tracks[0] === t

function clipKind(track: Track, clip: Clip): TrackKind {
  return clip.type === 'text' ? 'text' : clip.type === 'effect' ? 'effect' : track.kind
}

function sortClips(t: Track) {
  t.clips.sort((a, b) => a.start - b.start)
}

/** Pista principal: con imán, los clips quedan pegados sin huecos (como CapCut). */
function settleMain(p: Project) {
  const main = p.tracks[0]
  if (!main) return
  sortClips(main)
  if (p.settings.mainMagnet) {
    let cursor = 0
    for (const c of main.clips) {
      c.start = cursor
      cursor = clipEnd(c)
    }
  } else {
    // Sin imán no se compacta, pero tampoco se permiten solapes: se empuja a la derecha.
    let cursor = 0
    for (const c of main.clips) {
      c.start = Math.max(c.start, cursor)
      cursor = clipEnd(c)
    }
  }
  for (let i = 0; i < main.clips.length; i++) {
    const c = main.clips[i]
    if (c.type === 'media' && c.transition) {
      const next = main.clips[i + 1]
      if (!next || next.start !== clipEnd(c)) c.transition = null
      else c.transition.duration = Math.min(c.transition.duration, c.duration / 2, next.duration / 2)
    }
  }
}

/**
 * Vinculación: los clips de otras pistas que empiezan sobre un clip principal se
 * mueven con él cuando la operación cambia la pista principal.
 */
function withLinkage(p: Project, mutate: () => void) {
  if (!p.settings.linkage) {
    mutate()
    return
  }
  const main = p.tracks[0]
  const anchors = new Map<Id, { anchor: Id; offset: number }>()
  const before = new Map(main.clips.map((c) => [c.id, c.start]))
  for (const t of p.tracks.slice(1)) {
    if (t.locked) continue
    for (const c of t.clips) {
      const under = main.clips.find((m) => c.start >= m.start && c.start < clipEnd(m))
      if (under) anchors.set(c.id, { anchor: under.id, offset: c.start - under.start })
    }
  }
  mutate()
  const after = new Map(main.clips.map((c) => [c.id, c.start]))
  for (const t of p.tracks.slice(1)) {
    for (const c of t.clips) {
      const a = anchors.get(c.id)
      if (!a || !after.has(a.anchor)) continue
      if (after.get(a.anchor) !== before.get(a.anchor)) c.start = Math.max(0, after.get(a.anchor)! + a.offset)
    }
    sortClips(t)
  }
}

function overlaps(t: Track, start: number, end: number, ignore?: Set<Id>): boolean {
  return t.clips.some((c) => !ignore?.has(c.id) && c.start < end && clipEnd(c) > start)
}

const TRACK_LABEL: Record<TrackKind, string> = { video: 'Video', audio: 'Audio', text: 'Texto', effect: 'Efecto' }

function addTrack(p: Project, kind: TrackKind, name?: string): Track {
  const count = p.tracks.filter((t) => t.kind === kind).length
  const track: Track = {
    id: newId(),
    kind,
    name: name ?? `${TRACK_LABEL[kind]} ${count + 1}`,
    muted: false,
    hidden: false,
    locked: false,
    clips: []
  }
  p.tracks.push(track)
  return track
}

/** Primera pista del tipo dado donde cabe el rango; si ninguna, crea una nueva encima. */
function freeTrack(p: Project, kind: TrackKind, start: number, end: number, preferred?: Track, ignore?: Set<Id>): Track {
  if (preferred && preferred.kind === kind && !preferred.locked) {
    if (isMainTrack(p, preferred) || !overlaps(preferred, start, end, ignore)) return preferred
  }
  for (const t of p.tracks) {
    if (t.kind !== kind || t.locked || isMainTrack(p, t)) continue
    if (!overlaps(t, start, end, ignore)) return t
  }
  return addTrack(p, kind)
}

function targetTrack(p: Project, target: TrackTarget | undefined, kind: TrackKind): Track | undefined {
  if (!target) return undefined
  if (target === 'new') return addTrack(p, kind)
  return requireTrack(p, target)
}

function clipBase() {
  return { transform: defaultTransform(), keyframes: {}, animations: defaultAnimations(), blend: 'normal' as const }
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
    freeze: false,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    ...clipBase(),
    color: { lut: null, adjust: defaultAdjust() },
    crop: defaultCrop(),
    mask: defaultMask(),
    light: defaultLight(),
    retouch: defaultRetouch(),
    background: defaultBackground(),
    audioFx: defaultAudioFx(),
    transition: null
  }
}

function mediaAvailable(media: Media, clip: MediaClip): number {
  return media.kind === 'image' || clip.freeze ? Infinity : (media.duration - clip.sourceIn) / clip.speed
}

/** Parte el clip en `at` (tiempo de línea); devuelve la mitad derecha ya insertada. */
function split(track: Track, index: number, at: number): Clip {
  const clip = track.clips[index]
  if (at <= clip.start + MIN_CLIP || at >= clipEnd(clip) - MIN_CLIP) {
    throw new OpError('El punto de corte debe quedar dentro del clip')
  }
  const right = structuredClone(clip)
  right.id = newId()
  const leftDur = at - clip.start
  right.start = at
  right.duration = clip.duration - leftDur
  clip.duration = leftDur
  // Los keyframes se conservan en ambas mitades, corridos, para que nada salte.
  for (const kfs of Object.values(right.keyframes)) for (const k of kfs ?? []) k.t -= leftDur
  right.animations.in = null
  clip.animations.out = null
  if (right.type === 'media' && clip.type === 'media') {
    if (!clip.freeze) right.sourceIn = clip.sourceIn + leftDur * clip.speed
    right.fadeIn = 0
    clip.fadeOut = 0
    clip.transition = null
  }
  track.clips.splice(index + 1, 0, right)
  return right
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

    case 'setSettings':
      p.settings = { ...p.settings, ...op.patch }
      settleMain(p)
      break

    case 'addMedia':
      p.media[op.media.id] = op.media
      createdId = op.media.id
      break

    case 'removeMedia':
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !(c.type === 'media' && c.mediaId === op.mediaId))
      delete p.media[op.mediaId]
      settleMain(p)
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
      const kind: TrackKind = media.kind === 'audio' ? 'audio' : 'video'
      const preferred = targetTrack(p, op.trackId, kind) ?? (kind === 'video' ? p.tracks[0] : undefined)
      const toMain = preferred !== undefined && isMainTrack(p, preferred)
      const mainEnd = p.tracks[0].clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
      const start = op.start ?? (toMain ? mainEnd : 0)
      withLinkage(p, () => {
        const track = freeTrack(p, kind, start, start + duration, preferred)
        // En la principal con imán, se inserta en el corte más cercano al punto soltado.
        const clip = newMediaClip(media, toMain && op.start !== undefined && p.settings.mainMagnet ? start - 0.5 : start, sourceIn, duration)
        track.clips.push(clip)
        sortClips(track)
        createdId = clip.id
        if (isMainTrack(p, track)) settleMain(p)
      })
      break
    }

    case 'addText': {
      const duration = op.duration ?? TEXT_DEFAULT
      const preferred = targetTrack(p, op.trackId, 'text')
      const track = freeTrack(p, 'text', op.start, op.start + duration, preferred)
      const clip: TextClip = {
        id: newId(),
        type: 'text',
        start: op.start,
        duration,
        text: op.text,
        style: { ...defaultTextStyle(), ...op.style },
        ...clipBase(),
        transform: { ...defaultTransform(), y: 0.6 }
      }
      track.clips.push(clip)
      sortClips(track)
      createdId = clip.id
      break
    }

    case 'addEffect': {
      const duration = op.duration ?? EFFECT_DEFAULT
      const track = freeTrack(p, 'effect', op.start, op.start + duration)
      const clip: EffectClip = {
        id: newId(),
        type: 'effect',
        start: op.start,
        duration,
        effect: op.effect,
        params: { intensity: 0.6, speed: 0.5, ...op.params },
        ...clipBase()
      }
      track.clips.push(clip)
      sortClips(track)
      createdId = clip.id
      break
    }

    case 'moveClip': {
      const { track, clip, index } = requireClip(p, op.clipId)
      const kind = clipKind(track, clip)
      const target = targetTrack(p, op.trackId, kind) ?? track
      if (target.kind !== kind) throw new OpError(`Un clip de ${TRACK_LABEL[kind]} no puede ir en una pista de ${TRACK_LABEL[target.kind]}`)
      const start = Math.max(0, Math.round(op.start))
      const fromMain = isMainTrack(p, track)
      const toMainTrack = isMainTrack(p, target)
      const run = () => {
        track.clips.splice(index, 1)
        const dest = freeTrack(p, kind, start, start + clip.duration, target, new Set([clip.id]))
        // Con imán, el orden lo decide el punto soltado: entra antes del clip que empieza ahí.
        clip.start = isMainTrack(p, dest) && p.settings.mainMagnet ? start - 0.5 : start
        dest.clips.push(clip)
        sortClips(dest)
        if (isMainTrack(p, dest) || fromMain) settleMain(p)
      }
      // Mover un clip principal arrastra sus clips vinculados.
      if (fromMain || toMainTrack) withLinkage(p, run)
      else run()
      break
    }

    case 'moveClips': {
      const ids = new Set(op.clipIds)
      const moving: { track: Track; clip: Clip }[] = []
      for (const t of p.tracks) for (const c of t.clips) if (ids.has(c.id)) moving.push({ track: t, clip: c })
      if (!moving.length) break
      if (moving.some((m) => m.track.locked)) throw new OpError('Hay clips en una pista bloqueada')
      const minStart = Math.min(...moving.map((m) => m.clip.start))
      const delta = Math.max(-minStart, Math.round(op.delta))
      for (const { track, clip } of moving) {
        const start = clip.start + delta
        if (!isMainTrack(p, track) && overlaps(track, start, start + clip.duration, ids)) {
          // Si choca, ese clip sube a otra pista libre.
          track.clips = track.clips.filter((c) => c !== clip)
          clip.start = start
          freeTrack(p, clipKind(track, clip), start, start + clip.duration, undefined, ids).clips.push(clip)
        } else clip.start = start
      }
      for (const t of p.tracks) sortClips(t)
      settleMain(p)
      break
    }

    case 'trimClip': {
      const { track, clip } = requireClip(p, op.clipId)
      const t = Math.round(op.time)
      const run = () => {
        if (op.side === 'start') {
          const delta = Math.min(t - clip.start, clip.duration - MIN_CLIP)
          if (clip.type === 'media') {
            const media = p.media[clip.mediaId]
            const minDelta = media.kind === 'image' || clip.freeze ? -clip.start : -clip.sourceIn / clip.speed
            const d = Math.max(delta, minDelta, -clip.start)
            if (!clip.freeze) clip.sourceIn += d * clip.speed
            clip.start += d
            clip.duration -= d
            for (const kfs of Object.values(clip.keyframes)) for (const k of kfs ?? []) k.t -= d
          } else {
            const d = Math.max(delta, -clip.start)
            clip.start += d
            clip.duration -= d
            for (const kfs of Object.values(clip.keyframes)) for (const k of kfs ?? []) k.t -= d
          }
        } else {
          let duration = Math.max(MIN_CLIP, t - clip.start)
          if (clip.type === 'media') duration = Math.min(duration, mediaAvailable(p.media[clip.mediaId], clip))
          clip.duration = duration
        }
        if (isMainTrack(p, track)) settleMain(p)
      }
      if (isMainTrack(p, track)) withLinkage(p, run)
      else run()
      break
    }

    case 'splitClip': {
      const { track, index } = requireClip(p, op.clipId)
      createdId = split(track, index, Math.round(op.at)).id
      break
    }

    case 'deleteClip':
    case 'deleteClips': {
      const ids = op.op === 'deleteClip' ? [op.clipId] : op.clipIds
      for (const id of ids) requireClip(p, id)
      const touchesMain = ids.some((id) => p.tracks[0].clips.some((c) => c.id === id))
      const run = () => {
        for (const t of p.tracks) t.clips = t.clips.filter((c) => !ids.includes(c.id))
        settleMain(p)
      }
      if (touchesMain) withLinkage(p, run)
      else run()
      break
    }

    case 'duplicateClip': {
      const { track, clip } = requireClip(p, op.clipId)
      const copy = structuredClone(clip)
      copy.id = newId()
      copy.start = clipEnd(clip)
      if (copy.type === 'media') copy.transition = null
      if (isMainTrack(p, track)) {
        withLinkage(p, () => {
          track.clips.splice(track.clips.indexOf(clip) + 1, 0, copy)
          if (p.settings.mainMagnet) {
            // Empuja lo de después para dejar el hueco.
            for (const c of track.clips) if (c !== copy && c.start >= copy.start && c !== clip) c.start += copy.duration
          }
          settleMain(p)
        })
      } else {
        freeTrack(p, track.kind, copy.start, clipEnd(copy), track).clips.push(copy)
        for (const t of p.tracks) sortClips(t)
      }
      createdId = copy.id
      break
    }

    case 'separateAudio': {
      const { clip } = requireClip(p, op.clipId)
      if (clip.type !== 'media') throw new OpError('Solo los clips de video tienen audio')
      const media = p.media[clip.mediaId]
      if (media.kind !== 'video' || !media.hasAudio) throw new OpError('Este clip no tiene audio')
      if (clip.volume === 0) throw new OpError('El audio de este clip ya está separado o silenciado')
      const audio = structuredClone(clip)
      audio.id = newId()
      audio.transition = null
      audio.animations = defaultAnimations()
      audio.keyframes = clip.keyframes.volume ? { volume: clip.keyframes.volume } : {}
      freeTrack(p, 'audio', audio.start, clipEnd(audio)).clips.push(audio)
      clip.volume = 0
      delete clip.keyframes.volume
      for (const t of p.tracks) sortClips(t)
      createdId = audio.id
      break
    }

    case 'freezeFrame': {
      const { track, clip, index } = requireClip(p, op.clipId)
      if (clip.type !== 'media') throw new OpError('Solo se congelan clips de video')
      const at = Math.round(op.at)
      const dur = op.duration ?? FREEZE_DEFAULT
      const run = () => {
        let insertAt = index + 1
        if (at > clip.start + MIN_CLIP && at < clipEnd(clip) - MIN_CLIP) split(track, index, at)
        else if (at <= clip.start + MIN_CLIP) insertAt = index
        const frozen = structuredClone(clip)
        frozen.id = newId()
        frozen.freeze = true
        frozen.sourceIn = Math.max(0, clip.sourceIn + (Math.min(at, clipEnd(clip) - 1) - clip.start) * clip.speed)
        frozen.start = at
        frozen.duration = dur
        frozen.volume = 0
        frozen.transition = null
        frozen.keyframes = {}
        frozen.animations = defaultAnimations()
        // Corre a la derecha lo que viene después en la misma pista.
        for (const c of track.clips) if (c.start >= at) c.start += dur
        track.clips.splice(insertAt, 0, frozen)
        sortClips(track)
        createdId = frozen.id
        if (isMainTrack(p, track)) settleMain(p)
      }
      if (isMainTrack(p, track)) withLinkage(p, run)
      else run()
      break
    }

    case 'updateClip': {
      const { track, clip, index } = requireClip(p, op.clipId)
      const merged = deepMerge(clip, op.patch) as Clip
      merged.id = clip.id
      merged.type = clip.type
      const run = () => {
        if (merged.type === 'media' && clip.type === 'media' && merged.speed !== clip.speed) {
          if (merged.speed <= 0) throw new OpError('La velocidad debe ser mayor que 0')
          // Cambiar la velocidad conserva el mismo tramo de la fuente, como en CapCut.
          merged.duration = Math.max(MIN_CLIP, Math.round((clip.duration * clip.speed) / merged.speed))
        }
        track.clips[index] = merged
        if (isMainTrack(p, track)) settleMain(p)
      }
      if (isMainTrack(p, track) && op.patch && ('speed' in op.patch || 'duration' in op.patch)) withLinkage(p, run)
      else run()
      break
    }

    case 'setLut': {
      const { clip } = requireClip(p, op.clipId)
      if (clip.type !== 'media') throw new OpError('Los LUT solo se aplican a clips de video o imagen')
      clip.color.lut = op.lut ? { ...op.lut, intensity: Math.min(1, Math.max(0, op.lut.intensity)) } : null
      if (!op.lut) delete clip.keyframes['color.lut.intensity']
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
      if (isMainTrack(p, track)) settleMain(p)
      break
    }

    case 'setKeyframe': {
      const { clip } = requireClip(p, op.clipId)
      const t = Math.max(0, Math.min(clip.duration, Math.round(op.time - clip.start)))
      const current = op.value ?? getPath(resolveClip(clip, op.time), op.prop)
      if (current === undefined) throw new OpError(`El clip no tiene la propiedad ${op.prop}`)
      const list = [...(clip.keyframes[op.prop] ?? [])]
      const existing = list.findIndex((k) => Math.abs(k.t - t) <= KEY_EPS)
      const key = { t, v: current, ease: op.ease ?? (existing >= 0 ? list[existing].ease : 'easeInOut') }
      if (existing >= 0) list[existing] = key
      else list.push(key)
      list.sort((a, b) => a.t - b.t)
      clip.keyframes[op.prop] = list
      break
    }

    case 'removeKeyframe': {
      const { clip } = requireClip(p, op.clipId)
      const t = Math.round(op.time - clip.start)
      const list = (clip.keyframes[op.prop] ?? []).filter((k) => Math.abs(k.t - t) > KEY_EPS)
      if (list.length) clip.keyframes[op.prop] = list
      else {
        // Al quitar el último keyframe, el valor queda fijo en el que tenía.
        const v = getPath(resolveClip(clip, op.time), op.prop)
        delete clip.keyframes[op.prop]
        if (v !== undefined) setStatic(clip, op.prop, v)
      }
      break
    }

    case 'clearKeyframes': {
      const { clip } = requireClip(p, op.clipId)
      if (op.prop) delete clip.keyframes[op.prop]
      else clip.keyframes = {}
      break
    }
  }

  p.updatedAt = new Date().toISOString()
  return { project: p, createdId }
}

function setStatic(clip: Clip, prop: KeyProp, v: number) {
  const keys = prop.split('.')
  let cur = clip as unknown as Record<string, unknown>
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null) return
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = v
}
