// Comando de ffmpeg para exportar. El video ya llega renderizado por el compositor
// GPU (el mismo de la vista previa) como YUV 4:2:0 por stdin; aquí solo se mezcla el
// audio de los clips y se codifica. Es puro (no toca disco) para poder probarlo.

import { interpolate } from './animate.ts'
import { type Clip, type MediaClip, type Project, US, autoBitrate, clipEnd, projectDuration } from './project.ts'

export interface ExportPlan {
  args: string[]
  /** Grafo de audio; el proceso principal lo escribe en `filterPath` (la línea de comandos tiene límite). */
  filter: string | null
  duration: number
  width: number
  height: number
  fps: number
  frames: number
}

export interface ExportOptions {
  output: string
  /** Codificador de video que funciona en este equipo (lo detecta el proceso principal). */
  encoder: string
  filterPath: string
  /** De dónde lee ffmpeg el video crudo (por defecto stdin). */
  input?: string
  range?: { start: number; end: number }
}

const sec = (us: number) => (us / US).toFixed(6)
export const MIN_KBPS = 300
export const MAX_KBPS = 400_000

/** El compositor empaqueta 4 muestras por píxel: el ancho debe ser múltiplo de 8. */
export function exportSize(p: Project): { width: number; height: number } {
  return {
    width: Math.max(8, Math.round(p.export.width / 8) * 8),
    height: Math.max(2, Math.round(p.export.height / 2) * 2)
  }
}

/** Mapea una velocidad a una cadena de atempo (cada uno admite 0.5..2). */
function atempoChain(speed: number): string[] {
  const out: string[] = []
  let s = speed
  while (s > 2) {
    out.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    out.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`)
  return out
}

/**
 * Volumen con keyframes como expresión de ffmpeg (t relativo al clip). Las curvas se
 * muestrean en tramos lineales de 50 ms, suficiente para que no se note.
 */
export function volumeExpr(clip: MediaClip): string {
  const kfs = clip.keyframes.volume
  if (!kfs?.length) return clip.volume.toFixed(4)
  const step = US / 20
  const pts: [number, number][] = []
  for (let t = 0; t <= clip.duration; t += step) pts.push([t, interpolate(kfs, t)])
  pts.push([clip.duration, interpolate(kfs, clip.duration)])
  let expr = pts[pts.length - 1][1].toFixed(4)
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, v0] = pts[i]
    const [t1, v1] = pts[i + 1]
    const slope = t1 > t0 ? (v1 - v0) / ((t1 - t0) / US) : 0
    expr = `if(lt(t,${sec(t1)}),${v0.toFixed(4)}+${slope.toFixed(5)}*(t-${sec(t0)}),${expr})`
  }
  return expr
}

export function buildExport(project: Project, opts: ExportOptions): ExportPlan {
  const { width: W, height: H } = exportSize(project)
  const fps = project.export.fps
  const start = opts.range?.start ?? 0
  const total = (opts.range?.end ?? projectDuration(project)) - start
  if (total <= 0) throw new Error('El proyecto está vacío')
  const frames = Math.max(1, Math.round((total / US) * fps))

  const inputs: string[] = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', String(fps), '-i', opts.input ?? 'pipe:0']
  const graph: string[] = []
  const labels: string[] = []
  let inputCount = 1

  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips as Clip[]) {
      if (clip.type !== 'media' || clip.freeze) continue
      const media = project.media[clip.mediaId]
      if (!media?.hasAudio || media.kind === 'image') continue
      if (clip.volume <= 0 && !clip.keyframes.volume?.length) continue
      const from = Math.max(clip.start, start)
      const to = Math.min(clipEnd(clip), start + total)
      if (to <= from) continue
      const skip = (from - clip.start) * clip.speed
      inputs.push('-ss', sec(clip.sourceIn + skip), '-t', sec((to - from) * clip.speed + US / 10), '-i', media.path)
      const i = inputCount++
      const steps = [`atrim=duration=${sec((to - from) * clip.speed)}`, 'asetpts=PTS-STARTPTS', ...atempoChain(clip.speed)]
      const fx = clip.audioFx
      if (fx.denoise || fx.isolateVoice) steps.push(`afftdn=nr=${fx.isolateVoice ? 24 : 12}:nf=-40:tn=1`)
      if (fx.isolateVoice) steps.push('highpass=f=90', 'lowpass=f=8000')
      if (fx.enhanceVoice) {
        steps.push('highpass=f=70', 'equalizer=f=200:t=q:w=1:g=-2', 'equalizer=f=3500:t=q:w=1.2:g=3')
        steps.push('acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=3')
      }
      if (fx.normalize) steps.push('loudnorm=I=-14:TP=-1.5:LRA=11')
      // El tiempo del filtro empieza en `from`; se corre para que coincida con el del clip.
      const local = (from - clip.start) / US
      steps.push(`asetpts=PTS+${local.toFixed(6)}/TB`, `volume=eval=frame:volume='${volumeExpr(clip)}'`)
      if (clip.fadeIn > 0) steps.push(`afade=t=in:st=0:d=${sec(clip.fadeIn)}`)
      if (clip.fadeOut > 0) steps.push(`afade=t=out:st=${sec(clip.duration - clip.fadeOut)}:d=${sec(clip.fadeOut)}`)
      steps.push('asetpts=PTS-STARTPTS', `adelay=${Math.max(0, Math.round((from - start) / 1000))}:all=1`)
      const label = `a${i}`
      graph.push(`[${i}:a]${steps.join(',')}[${label}]`)
      labels.push(label)
    }
  }

  const ex = project.export
  // Tasa de bits en kbps, acotada a valores que aceptan los codificadores.
  const kbps = Math.round(Math.min(MAX_KBPS, Math.max(MIN_KBPS, ex.bitrate ?? autoBitrate(W, H, fps))))
  const enc = opts.encoder
  const cbr = ex.rateControl === 'cbr'
  const rate = cbr
    ? ['-b:v', `${kbps}k`, '-minrate:v', `${kbps}k`, '-maxrate:v', `${kbps}k`, '-bufsize:v', `${kbps}k`]
    : ['-b:v', `${kbps}k`, '-maxrate:v', `${Math.round(kbps * 1.5)}k`, '-bufsize:v', `${kbps * 2}k`]
  const encArgs = enc.endsWith('_nvenc')
    ? ['-preset', 'p5', '-tune', 'hq', '-rc', cbr ? 'cbr' : 'vbr', ...rate]
    : enc.endsWith('_qsv') || enc.endsWith('_amf')
      ? rate
      : ['-preset', 'veryfast', ...rate]

  const audio: string[] = []
  if (labels.length) {
    const mix = labels.length > 1 ? `amix=inputs=${labels.length}:normalize=0:dropout_transition=0,` : ''
    graph.push(`${labels.map((l) => `[${l}]`).join('')}${mix}apad,atrim=duration=${sec(total)}[aout]`)
    audio.push('-/filter_complex', opts.filterPath, '-map', '[aout]', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000')
  }

  const args = [
    '-y', '-hide_banner', '-nostats',
    ...(opts.input ? ['-nostdin'] : []),
    ...inputs,
    '-map', '0:v',
    ...audio,
    '-c:v', enc, ...encArgs,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(fps), '-t', sec(total),
    ...(ex.format === 'mov' ? [] : ['-movflags', '+faststart']),
    opts.output
  ]
  return { args, filter: labels.length ? graph.join(';\n') : null, duration: total, width: W, height: H, fps, frames }
}
