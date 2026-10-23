// Estado de la ventana: proyecto abierto, historial, reproducción y selección.
// Todo cambio al proyecto pasa por `dispatch`, que usa las mismas operaciones que el CLI.

import { create } from 'zustand'
import { applyOp, type Op } from '@shared/ops'
import { type Id, type Project, US, projectDuration } from '@shared/project'
import { api } from './api'

const HISTORY_LIMIT = 300
const AUTOSAVE_MS = 700

export type SaveState = 'saved' | 'pending' | 'saving' | 'error'

interface EditorState {
  project: Project | null
  past: Project[]
  future: Project[]
  selection: Id | null
  time: number
  playing: boolean
  /** Píxeles por segundo en la línea de tiempo. */
  zoom: number
  save: SaveState
  saveError: string | null

  open(p: Project): void
  close(): void
  dispatch(ops: Op | Op[]): Array<Id | undefined>
  undo(): void
  redo(): void
  select(id: Id | null): void
  seek(t: number): void
  setPlaying(v: boolean): void
  setZoom(z: number): void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useEditor = create<EditorState>((set, get) => {
  async function flush() {
    const p = get().project
    if (!p) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    set({ save: 'saving' })
    try {
      await api.saveProject(p)
      if (get().project === p) set({ save: 'saved', saveError: null })
    } catch (err) {
      set({ save: 'error', saveError: err instanceof Error ? err.message : String(err) })
    }
  }

  function scheduleSave() {
    set({ save: 'pending' })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, AUTOSAVE_MS)
  }

  // Guardar de inmediato si se cierra o se pierde el foco: nunca se pierde trabajo.
  window.addEventListener('beforeunload', () => void flush())
  window.addEventListener('blur', () => {
    if (get().save === 'pending') void flush()
  })

  return {
    project: null,
    past: [],
    future: [],
    selection: null,
    time: 0,
    playing: false,
    zoom: 60,
    save: 'saved',
    saveError: null,

    open(p) {
      set({ project: p, past: [], future: [], selection: null, time: 0, playing: false, save: 'saved' })
    },

    close() {
      void flush()
      set({ project: null, past: [], future: [], selection: null, playing: false })
    },

    dispatch(ops) {
      const list = Array.isArray(ops) ? ops : [ops]
      const before = get().project
      if (!before || !list.length) return []
      let p = before
      const created: Array<Id | undefined> = []
      for (const op of list) {
        const r = applyOp(p, op)
        p = r.project
        created.push(r.createdId)
      }
      const past = [...get().past, before].slice(-HISTORY_LIMIT)
      const sel = get().selection
      const stillThere = !sel || p.tracks.some((t) => t.clips.some((c) => c.id === sel))
      set({ project: p, past, future: [], selection: stillThere ? sel : null })
      scheduleSave()
      return created
    },

    undo() {
      const { past, project, future } = get()
      if (!past.length || !project) return
      set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] })
      scheduleSave()
    },

    redo() {
      const { past, project, future } = get()
      if (!future.length || !project) return
      set({ project: future[0], past: [...past, project], future: future.slice(1) })
      scheduleSave()
    },

    select: (id) => set({ selection: id }),

    seek(t) {
      const p = get().project
      const end = p ? projectDuration(p) : 0
      set({ time: Math.max(0, Math.min(Math.round(t), Math.max(end, 0))) })
    },

    setPlaying(v) {
      const p = get().project
      if (v && p && get().time >= projectDuration(p) - US / 60) set({ time: 0 })
      set({ playing: v })
    },

    setZoom: (z) => set({ zoom: Math.max(4, Math.min(1200, z)) })
  }
})

export const flushSave = (): void => {
  const s = useEditor.getState()
  if (s.project && s.save !== 'saved') void api.saveProject(s.project)
}
