// Atiende las peticiones del CLI (llegan del proceso principal por IPC) y las
// aplica sobre el proyecto abierto, así el usuario ve cada cambio en vivo.

import { useEffect } from 'react'
import type { Op } from '@shared/ops'
import { type Project, US, clipEnd, newProject, projectDuration } from '@shared/project'
import { useEditor } from './store'
import { api } from './api'
import { addToTimeline, autoSubtitles, importFiles, toast } from './actions'
import { getPlayer } from './components/Preview'

function requireProject(): Project {
  const p = useEditor.getState().project
  if (!p) throw new Error('No hay ningún proyecto abierto en Cancun (usa "cancun open <id>" o "cancun new")')
  return p
}

/** Resumen compacto del proyecto, pensado para que el agente lo lea rápido. */
export function summarize(p: Project) {
  const s = (us: number) => Math.round((us / US) * 1000) / 1000
  return {
    id: p.id,
    name: p.name,
    canvas: p.canvas,
    duration: s(projectDuration(p)),
    media: Object.values(p.media).map((m) => ({ id: m.id, kind: m.kind, name: m.name, path: m.path, duration: s(m.duration), size: m.width ? `${m.width}x${m.height}` : undefined })),
    tracks: p.tracks.map((t, i) => ({
      id: t.id,
      index: i,
      kind: t.kind,
      name: t.name,
      main: i === 0,
      muted: t.muted || undefined,
      hidden: t.hidden || undefined,
      clips: t.clips.map((c) =>
        c.type === 'text'
          ? { id: c.id, type: 'text', text: c.text, start: s(c.start), end: s(clipEnd(c)) }
          : c.type === 'effect'
            ? { id: c.id, type: 'effect', effect: c.effect, start: s(c.start), end: s(clipEnd(c)) }
            : c.type === 'adjust'
              ? { id: c.id, type: 'adjust', name: c.name, start: s(c.start), end: s(clipEnd(c)), lut: c.color.lut ? `${c.color.lut.name} ${Math.round(c.color.lut.intensity * 100)}%` : undefined }
              : {
              id: c.id,
              type: 'media',
              media: p.media[c.mediaId]?.name,
              mediaId: c.mediaId,
              start: s(c.start),
              end: s(clipEnd(c)),
              sourceIn: s(c.sourceIn),
              speed: c.speed !== 1 ? c.speed : undefined,
              volume: c.volume !== 1 ? c.volume : undefined,
              lut: c.color.lut ? `${c.color.lut.name} ${Math.round(c.color.lut.intensity * 100)}%` : undefined,
              transition: c.transition ? `${c.transition.kind} ${s(c.transition.duration)}s` : undefined,
              chroma: c.background.mode === 'chroma' || undefined
            }
      )
    }))
  }
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  const st = useEditor.getState()
  switch (method) {
    case 'current':
      return st.project ? { id: st.project.id, name: st.project.name } : null
    case 'state':
      return { project: requireProject(), time: st.time / US, selection: st.selection, playing: st.playing }
    case 'summary':
      return summarize(requireProject())
    case 'apply': {
      requireProject()
      const ops = params.ops as Op[]
      const created = st.dispatch(ops)
      toast(`Claude aplicó ${ops.length} cambio${ops.length === 1 ? '' : 's'}`)
      return { created, duration: projectDuration(useEditor.getState().project!) / US }
    }
    case 'import': {
      requireProject()
      const media = await importFiles(params.paths as string[])
      const clips: (string | undefined)[] = []
      if (params.add) for (const m of media) clips.push(addToTimeline(m))
      return { media: media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration / US })), clips }
    }
    case 'seek':
      st.seek(Number(params.time) * US)
      return { time: useEditor.getState().time / US }
    case 'play':
      st.setPlaying(true)
      return true
    case 'pause':
      st.setPlaying(false)
      return true
    case 'select':
      st.select((params.clipId as string) ?? null)
      return true
    case 'undo':
      st.undo()
      return true
    case 'redo':
      st.redo()
      return true
    case 'frame': {
      requireProject()
      const player = getPlayer()
      if (!player) throw new Error('El reproductor no está listo')
      st.setPlaying(false)
      const t = params.time !== undefined ? Number(params.time) * US : st.time
      st.seek(t)
      return { png: await player.frameAt(useEditor.getState().time) }
    }
    case 'open': {
      st.open(await api.loadProject(String(params.id)))
      return summarize(useEditor.getState().project!)
    }
    case 'new': {
      const p = newProject(String(params.name ?? 'Proyecto'), Number(params.width ?? 1920), Number(params.height ?? 1080), Number(params.fps ?? 30))
      await api.saveProject(p)
      st.open(p)
      return { id: p.id, name: p.name }
    }
    case 'subtitles': {
      requireProject()
      const count = await autoSubtitles(String(params.lang ?? 'es'))
      toast(`Claude generó ${count} subtítulos`)
      return { count, track: 'Subtítulos' }
    }
    case 'export': {
      const p = requireProject()
      return api.startExport(p, String(params.output))
    }
    default:
      throw new Error(`Método desconocido: ${method}`)
  }
}

export function useBridge() {
  useEffect(() => {
    window.cancun.bridge.onRequest(async (req) => {
      try {
        window.cancun.bridge.reply({ id: req.id, result: await handle(req.method, req.params ?? {}) })
      } catch (err) {
        window.cancun.bridge.reply({ id: req.id, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }, [])
}
