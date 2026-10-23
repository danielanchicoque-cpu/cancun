// Renderiza la exportación cuadro a cuadro con el mismo compositor de la vista previa
// y entrega cada cuadro en YUV 4:2:0 al proceso principal (que lo pasa a ffmpeg).

import type { CubeLut } from '@shared/cube'
import { type MediaClip, type Project, US, clipEnd } from '@shared/project'
import { layersAt } from '@shared/timeline'
import { api } from '../api'
import { Compositor, type FrameSource, type SegSource } from '../gl/Compositor'
import { Segmenter, needsSegmentation } from './Segmenter'
import { type FrameProvider, openProvider } from './sources'
import { decodeStats } from './ClipDecoder'

export interface RenderJob {
  jobId: number
  project: Project
  width: number
  height: number
  fps: number
  frames: number
  start: number
}

let cancelled = new Set<number>()

export function cancelRender(jobId: number) {
  cancelled.add(jobId)
}

export async function renderJob(job: RenderJob, send: (data: Uint8Array, index: number) => Promise<void>) {
  const { project: p, width, height, fps, frames, start } = job
  const canvas = document.createElement('canvas')
  const comp = new Compositor(canvas)
  comp.resize(width, height, p.canvas.width)

  const luts = new Map<string, CubeLut>()
  for (const t of p.tracks)
    for (const c of t.clips)
      if (c.type === 'media' && c.color.lut && !luts.has(c.color.lut.path)) {
        const l = await api.loadLut(c.color.lut.path)
        luts.set(c.color.lut.path, { ...l, data: new Float32Array(l.data) })
      }

  const providers = new Map<string, Promise<FrameProvider>>()
  const segmenter = p.tracks.some((t) => t.clips.some((c) => c.type === 'media' && needsSegmentation(c))) ? await Segmenter.get() : null
  const providerFor = (clip: MediaClip) => {
    let pr = providers.get(clip.id)
    if (!pr) {
      pr = openProvider(p.media[clip.mediaId], clip, fps)
      providers.set(clip.id, pr)
    }
    return pr
  }
  const original = new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)))

  console.log(`render ${width}x${height} ${fps}fps ${frames} cuadros`)
  const timing = { decode: 0, render: 0, read: 0, send: 0 }
  let mark = performance.now()
  const lap = (k: keyof typeof timing) => {
    const now = performance.now()
    timing[k] += now - mark
    mark = now
  }
  // Hasta 3 cuadros viajando hacia ffmpeg mientras se dibuja el siguiente.
  const inFlight: Promise<void>[] = []
  try {
    for (let n = 0; n < frames; n++) {
      if (cancelled.has(job.jobId)) throw new Error('Exportación cancelada')
      const t = start + Math.round((n * US) / fps)
      const layers = layersAt(p, t)
      const sources = new Map<string, FrameSource>()
      const segs = new Map<string, SegSource>()
      const visible: { clip: MediaClip; source: number }[] = []
      for (const l of layers) {
        if (l.kind === 'clip') visible.push({ clip: l.frame.clip, source: l.frame.source })
        else if (l.kind === 'transition') visible.push({ clip: l.a.clip, source: l.a.source }, { clip: l.b.clip, source: l.b.source })
      }
      mark = performance.now()
      for (const f of visible) {
        const provider = await providerFor(original.get(f.clip.id) as MediaClip)
        const src = await provider.frameAt(f.source)
        if (!src) continue
        sources.set(f.clip.id, src)
        if (segmenter && needsSegmentation(f.clip)) segs.set(f.clip.id, await segmenter.segmentNow(f.clip.id, src as TexImageSource))
      }
      lap('decode')
      comp.render(p, layers, sources, luts, segs)
      lap('render')
      const yuv = comp.readYUV()
      lap('read')
      inFlight.push(send(yuv, n))
      if (inFlight.length >= 3) await inFlight.shift()
      lap('send')
      if (n % 30 === 29) {
        console.log(`cuadro ${n + 1}/${frames} ms por cuadro: ` + Object.entries(timing).map(([k, v]) => `${k}=${(v / 30).toFixed(1)}`).join(' '))
        for (const k of Object.keys(decodeStats) as (keyof typeof decodeStats)[]) decodeStats[k] = 0
        for (const k of Object.keys(timing) as (keyof typeof timing)[]) timing[k] = 0
      }
      // Libera los decodificadores de clips que ya terminaron.
      for (const [id, pr] of providers) {
        const c = original.get(id)
        if (c && clipEnd(c) + US < t) {
          providers.delete(id)
          void pr.then((x) => x.close())
        }
      }
    }
    await Promise.all(inFlight)
  } finally {
    for (const pr of providers.values()) void pr.then((x) => x.close())
    cancelled = new Set([...cancelled].filter((id) => id !== job.jobId))
  }
}
