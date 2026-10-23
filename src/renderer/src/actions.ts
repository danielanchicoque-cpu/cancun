// Acciones de alto nivel que comparten la interfaz, los atajos y el puente del CLI.

import { type Clip, type Media, type MediaClip, type Project, type Transition, US, clipEnd, findClip } from '@shared/project'
import type { Op } from '@shared/ops'
import { api } from './api'
import { primarySelection, useEditor } from './store'

const ed = () => useEditor.getState()

function run(ops: Op | Op[]): Array<string | undefined> {
  try {
    return ed().dispatch(ops)
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true)
    return []
  }
}

/** Importa archivos al proyecto (sin duplicar rutas ya importadas). */
export async function importFiles(paths: string[]): Promise<Media[]> {
  const p = ed().project
  if (!p || !paths.length) return []
  const existing = new Map(Object.values(p.media).map((m) => [m.path.toLowerCase(), m]))
  const fresh = paths.filter((x) => !existing.has(x.toLowerCase()))
  const probed = fresh.length ? await api.probe(fresh) : []
  if (probed.length) ed().dispatch(probed.map((media) => ({ op: 'addMedia', media }) as Op))
  return paths.map((x) => existing.get(x.toLowerCase()) ?? probed.find((m) => m.path === x)!).filter(Boolean)
}

export async function pickAndImport(): Promise<Media[]> {
  return importFiles(await api.pickMedia())
}

/** Agrega un medio a la línea de tiempo: video/imagen al final de la principal, audio en el cursor. */
export function addToTimeline(media: Media, opts: { start?: number; trackId?: string } = {}): string | undefined {
  const start = opts.start ?? (media.kind === 'audio' ? ed().time : undefined)
  const [id] = run({ op: 'addClip', mediaId: media.id, start, trackId: opts.trackId })
  if (id) ed().select(id)
  return id
}

export function selectedClips(p: Project): Clip[] {
  const ids = new Set(ed().selection)
  return p.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)))
}

/** Clip a editar: el seleccionado o, si no hay, el de la principal bajo el cursor. */
export function targetClip(p: Project): MediaClip | null {
  const id = primarySelection(ed())
  if (id) {
    const f = findClip(p, id)
    return f && f.clip.type === 'media' ? f.clip : null
  }
  const t = ed().time
  const c = p.tracks[0]?.clips.find((c) => c.start <= t && t < clipEnd(c))
  return c && c.type === 'media' ? c : null
}

/** Clips sobre los que actúan las herramientas: la selección o lo que hay bajo el cursor. */
function toolTargets(p: Project, underPlayhead = true): Clip[] {
  const sel = selectedClips(p)
  if (sel.length || !underPlayhead) return sel
  const t = ed().time
  return p.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => c.start <= t && t < clipEnd(c)))
}

export function splitAtPlayhead() {
  const p = ed().project
  if (!p) return
  const t = ed().time
  const ops: Op[] = toolTargets(p)
    .filter((c) => c.start < t && t < clipEnd(c))
    .map((c) => ({ op: 'splitClip', clipId: c.id, at: t }))
  if (ops.length) run(ops)
}

/** "Eliminar izquierda/derecha" de CapCut (Q / W): recorta hasta el cursor. */
export function trimToPlayhead(side: 'left' | 'right') {
  const p = ed().project
  if (!p) return
  const t = ed().time
  const ops: Op[] = toolTargets(p)
    .filter((c) => c.start < t && t < clipEnd(c))
    .map((c) => ({ op: 'trimClip', clipId: c.id, side: side === 'left' ? 'start' : 'end', time: t }))
  if (ops.length) run(ops)
}

export function deleteSelection() {
  const ids = ed().selection
  if (!ids.length) return
  run({ op: 'deleteClips', clipIds: ids })
  ed().select(null)
}

export function duplicateSelection() {
  const p = ed().project
  if (!p) return
  const created = run(toolTargets(p, false).map((c) => ({ op: 'duplicateClip', clipId: c.id }) as Op))
  const ids = created.filter(Boolean) as string[]
  if (ids.length) ed().select(ids)
}

export function paste() {
  const s = ed()
  if (!s.clipboard.length) return
  const created = run({ op: 'pasteClips', clips: s.clipboard, at: s.time })
  if (created[0]) s.select(created[0])
}

export function freezeAtPlayhead() {
  const p = ed().project
  if (!p) return
  const t = ed().time
  const clip = toolTargets(p).find((c) => c.type === 'media' && c.start <= t && t < clipEnd(c))
  if (!clip) return toast('Pon el cursor sobre un clip de video para congelar el cuadro', true)
  const [id] = run({ op: 'freezeFrame', clipId: clip.id, at: t })
  if (id) ed().select(id)
}

export function separateAudio() {
  const p = ed().project
  if (!p) return
  const clips = toolTargets(p).filter((c) => c.type === 'media')
  if (!clips.length) return toast('Selecciona un clip de video con audio', true)
  run(clips.map((c) => ({ op: 'separateAudio', clipId: c.id }) as Op))
}

export function mirrorSelection() {
  const p = ed().project
  if (!p) return
  run(toolTargets(p).filter((c) => c.type !== 'effect').map((c) => ({ op: 'updateClip', clipId: c.id, patch: { transform: { flipX: !c.transform.flipX } } }) as Op))
}

export function rotateSelection() {
  const p = ed().project
  if (!p) return
  run(toolTargets(p).filter((c) => c.type !== 'effect').map((c) => ({ op: 'updateClip', clipId: c.id, patch: { transform: { rotation: ((c.transform.rotation + 90 + 180) % 360) - 180 } } }) as Op))
}

/** Invertir: crea una copia del video al revés (ffmpeg) y la usa en el clip. */
export async function reverseSelection() {
  const p = ed().project
  if (!p) return
  const clips = toolTargets(p).filter((c): c is MediaClip => c.type === 'media' && p.media[c.mediaId]?.kind === 'video')
  if (!clips.length) return toast('Selecciona un clip de video para invertir', true)
  toast('Invirtiendo… (puede tardar con clips largos)')
  for (const clip of clips) {
    const media = p.media[clip.mediaId]
    const reversed = await api.reverse(media.path).catch((e) => {
      toast(String(e), true)
      return null
    })
    if (!reversed) return
    const [m] = await importFiles([reversed])
    // El tramo invertido de la fuente: lo que terminaba al final ahora empieza al inicio.
    const srcEnd = clip.sourceIn + clip.duration * clip.speed
    run({ op: 'updateClip', clipId: clip.id, patch: { mediaId: m.id, sourceIn: Math.max(0, media.duration - srcEnd) } })
  }
  toast('Clip invertido')
}

export function applyTransition(clipId: string, transition: Transition | null) {
  run({ op: 'setTransition', clipId, transition })
}

export const DEFAULT_TRANSITION_US = 0.5 * US

// --- Avisos ---------------------------------------------------------------------------
type ToastListener = (msg: string | null, error: boolean) => void
const toastListeners = new Set<ToastListener>()
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function toast(msg: string, error = false) {
  for (const l of toastListeners) l(msg, error)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastListeners.forEach((l) => l(null, false)), error ? 6000 : 2500)
}

export function onToast(l: ToastListener): () => void {
  toastListeners.add(l)
  return () => toastListeners.delete(l)
}
