// Acciones de alto nivel que comparten la interfaz, los atajos y el puente del CLI.

import { type Media, type MediaClip, type Project, type Transition, US, clipEnd, findClip } from '@shared/project'
import type { Op } from '@shared/ops'
import { api } from './api'
import { useEditor } from './store'

const ed = () => useEditor.getState()

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
  const s = ed()
  const start = opts.start ?? (media.kind === 'audio' ? s.time : undefined)
  const [id] = s.dispatch({ op: 'addClip', mediaId: media.id, start, trackId: opts.trackId })
  if (id) s.select(id)
  return id
}

/** Clip a editar: el seleccionado o, si no hay, el de la principal bajo el cursor. */
export function targetClip(p: Project): MediaClip | null {
  const s = ed()
  if (s.selection) {
    const f = findClip(p, s.selection)
    return f && f.clip.type === 'media' ? f.clip : null
  }
  const c = p.tracks[0]?.clips.find((c) => c.start <= s.time && s.time < clipEnd(c))
  return c && c.type === 'media' ? c : null
}

export function splitAtPlayhead() {
  const s = ed()
  const p = s.project
  if (!p) return
  const t = s.time
  // Como CapCut: corta el seleccionado, o todo lo que haya bajo el cursor.
  const ids = s.selection
    ? [s.selection]
    : p.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => c.start < t && t < clipEnd(c)).map((c) => c.id))
  const ops: Op[] = ids
    .map((id) => findClip(p, id)?.clip)
    .filter((c) => c && c.start < t && t < clipEnd(c))
    .map((c) => ({ op: 'splitClip', clipId: c!.id, at: t }))
  if (ops.length) {
    try {
      s.dispatch(ops)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true)
    }
  }
}

export function deleteSelection() {
  const s = ed()
  if (!s.selection) return
  s.dispatch({ op: 'deleteClip', clipId: s.selection })
  s.select(null)
}

export function applyTransition(clipId: string, transition: Transition | null) {
  try {
    ed().dispatch({ op: 'setTransition', clipId, transition })
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true)
  }
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
