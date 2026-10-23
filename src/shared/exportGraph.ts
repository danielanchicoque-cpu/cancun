// Traduce un proyecto a un comando de ffmpeg. Es puro (no toca disco) para poder
// probarlo; el proceso principal escribe los archivos que pide y ejecuta ffmpeg.
//
// Modelo de tiempo (igual que la vista previa):
//  - La pista principal se encadena clip a clip; una transición de duración d entre
//    A y B ocupa [T - d/2, T + d/2] alrededor del corte T. A se alarga d/2 y B
//    empieza d/2 antes (si la fuente no alcanza, se congela el cuadro).
//  - Las demás pistas se superponen en su instante de inicio.

import { BAKE_SIZE, bakeGrade, isNeutral, toCubeText } from './color.ts'
import type { CubeLut } from './cube.ts'
import {
  type MediaClip,
  type Project,
  type TextClip,
  US,
  autoBitrate,
  clipEnd,
  projectDuration
} from './project.ts'

export interface ExportFile {
  path: string
  content: string
}

export interface ExportPlan {
  args: string[]
  files: ExportFile[]
  duration: number
}

export interface ExportOptions {
  output: string
  tmpDir: string
  luts: Map<string, CubeLut>
  fontDir: string
  /** Codificador de video que funciona en este equipo (lo detecta el proceso principal). */
  encoder: string
  /** Para la vista previa rápida de una sola parte. */
  range?: { start: number; end: number }
}

const sec = (us: number) => (us / US).toFixed(6)
const q = (path: string) => `'${path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\''")}'`

export function fontFile(fontDir: string, family: string, bold: boolean, italic: boolean): string {
  const base: Record<string, string> = {
    arial: 'arial',
    impact: 'impact',
    verdana: 'verdana',
    georgia: 'georgia',
    tahoma: 'tahoma',
    'times new roman': 'times',
    'segoe ui': 'segoeui',
    'comic sans ms': 'comic'
  }
  const name = base[family.toLowerCase()] ?? 'arial'
  const suffix = bold && italic ? 'bi' : bold ? 'bd' : italic ? 'i' : ''
  const special: Record<string, string> = { segoeuibd: 'segoeuib', impactbd: 'impact', comicbd: 'comicbd' }
  const file = special[name + suffix] ?? name + suffix
  return `${fontDir.replace(/\\/g, '/')}/${file}.ttf`
}

/** Mapea un rango de velocidad a una cadena de atempo (cada uno admite 0.5..2). */
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

function hexColor(c: string): string {
  return c.startsWith('#') ? `0x${c.slice(1)}` : c
}

interface ClipWindow {
  /** Tiempo de línea en que empieza a verse (incluye la parte previa de la transición). */
  from: number
  to: number
  preRoll: number
  postRoll: number
}

function mainWindows(clips: MediaClip[]): ClipWindow[] {
  return clips.map((c, i) => {
    const prev = clips[i - 1]
    const pre = prev?.transition ? prev.transition.duration / 2 : 0
    const post = c.transition ? c.transition.duration / 2 : 0
    return { from: c.start - pre, to: clipEnd(c) + post, preRoll: pre, postRoll: post }
  })
}

export function buildExport(project: Project, opts: ExportOptions): ExportPlan {
  const { canvas } = project
  const W = project.export.width
  const H = project.export.height
  const fps = project.export.fps
  const total = opts.range ? opts.range.end - opts.range.start : projectDuration(project)
  if (total <= 0) throw new Error('El proyecto está vacío')
  const offset = opts.range?.start ?? 0

  const inputs: string[] = []
  const graph: string[] = []
  const files: ExportFile[] = []
  const audioLabels: string[] = []
  let inputCount = 0
  let label = 0
  const next = (p: string) => `${p}${label++}`

  const visible = (from: number, to: number) => to > offset && from < offset + total

  /** Abre el medio de un clip para el tramo [from, to) de la línea de tiempo. */
  function openInput(clip: MediaClip, w: ClipWindow): { index: number; lead: number; tail: number } {
    const media = project.media[clip.mediaId]
    const wantIn = clip.sourceIn - w.preRoll * clip.speed
    const srcIn = Math.max(0, wantIn)
    const lead = (srcIn - wantIn) / clip.speed // tiempo a congelar al inicio
    const wantLen = (w.to - w.from) * clip.speed - (srcIn - wantIn)
    if (media.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(w.to - w.from), '-i', media.path)
      return { index: inputCount++, lead: 0, tail: 0 }
    }
    const avail = media.duration - srcIn
    const len = Math.min(wantLen, avail)
    const tail = Math.max(0, (wantLen - len) / clip.speed)
    inputs.push('-ss', sec(srcIn), '-t', sec(len), '-i', media.path)
    return { index: inputCount++, lead, tail }
  }

  /** Cadena de video de un clip, ya transformada sobre un lienzo transparente W×H. */
  function videoChain(clip: MediaClip, w: ClipWindow, input: { index: number; lead: number; tail: number }): string {
    const media = project.media[clip.mediaId]
    const steps: string[] = []
    steps.push(`setpts=(PTS-STARTPTS)/${clip.speed}`, `fps=${fps}`)
    if (input.lead > 0 || input.tail > 0) {
      steps.push(`tpad=start_mode=clone:start_duration=${sec(input.lead)}:stop_mode=clone:stop_duration=${sec(input.tail)}`)
    }
    // Encaje "contener" en el lienzo, como CapCut, multiplicado por la escala del clip.
    const mw = media.width ?? W
    const mh = media.height ?? H
    const fit = Math.min(W / mw, H / mh) * clip.transform.scale
    const sw = Math.max(2, Math.round((mw * fit) / 2) * 2)
    const sh = Math.max(2, Math.round((mh * fit) / 2) * 2)
    // Sin etiqueta se interpreta como BT.709, igual que Chromium en la vista previa.
    const matrix = media.colorSpace === 'bt470bg' || media.colorSpace === 'smpte170m' ? 'bt601' : 'bt709'
    steps.push(`scale=${sw}:${sh}:flags=bicubic:in_color_matrix=${matrix}`, 'format=gbrp')

    const lut = clip.color.lut
    const lutData = lut ? opts.luts.get(lut.path) ?? null : null
    if (lut && !lutData) throw new Error(`No se cargó el LUT ${lut.path}`)
    if (lutData || !isNeutral(clip.color.adjust)) {
      const cubePath = `${opts.tmpDir.replace(/\\/g, '/')}/grade-${clip.id}.cube`
      files.push({ path: cubePath, content: toCubeText(bakeGrade(clip.color.adjust, lutData, lut?.intensity ?? 0), BAKE_SIZE) })
      steps.push(`lut3d=file=${q(cubePath)}:interp=trilinear`)
    }
    if (clip.color.adjust.sharpen > 0) steps.push(`unsharp=5:5:${(clip.color.adjust.sharpen * 1.5).toFixed(3)}`)
    if (clip.color.adjust.vignette > 0) steps.push(`vignette=angle=${(clip.color.adjust.vignette * 0.9).toFixed(3)}`)

    steps.push('format=rgba')
    if (clip.background.mode === 'chroma') {
      const c = clip.background.chroma
      steps.push(`colorkey=${hexColor(c.color)}:${(0.05 + c.intensity * 0.5).toFixed(3)}:${(c.shadow * 0.5).toFixed(3)}`)
    }
    if (clip.transform.rotation) {
      const a = ((clip.transform.rotation * Math.PI) / 180).toFixed(6)
      steps.push(`rotate=${a}:c=none:ow=rotw(${a}):oh=roth(${a})`)
    }
    if (clip.transform.opacity < 1) steps.push(`colorchannelmixer=aa=${clip.transform.opacity.toFixed(4)}`)

    const src = next('v')
    graph.push(`[${input.index}:v]${steps.join(',')}[${src}]`)
    const dur = sec(w.to - w.from)
    const bg = next('bg')
    graph.push(`color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${dur},format=rgba[${bg}]`)
    const out = next('c')
    const x = `(W-w)/2+${((clip.transform.x * W) / 2).toFixed(2)}`
    const y = `(H-h)/2+${((clip.transform.y * H) / 2).toFixed(2)}`
    graph.push(`[${bg}][${src}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[${out}]`)
    return out
  }

  function audioChain(clip: MediaClip, input: { index: number }, w: ClipWindow, trackMuted: boolean) {
    const media = project.media[clip.mediaId]
    if (trackMuted || !media.hasAudio || media.kind === 'image' || clip.volume <= 0) return
    const steps: string[] = []
    // Solo suena el tramo propio del clip (sin las colas de la transición).
    const skip = Math.max(0, w.preRoll * clip.speed - Math.max(0, w.preRoll * clip.speed - clip.sourceIn))
    steps.push(`atrim=start=${sec(skip)}:duration=${sec(clip.duration * clip.speed)}`, 'asetpts=PTS-STARTPTS')
    steps.push(...atempoChain(clip.speed))
    const fx = clip.audioFx
    if (fx.denoise || fx.isolateVoice) steps.push(`afftdn=nr=${fx.isolateVoice ? 24 : 12}:nf=-40:tn=1`)
    if (fx.isolateVoice) steps.push('highpass=f=90', 'lowpass=f=8000')
    if (fx.enhanceVoice) {
      steps.push('highpass=f=70', 'equalizer=f=200:t=q:w=1:g=-2', 'equalizer=f=3500:t=q:w=1.2:g=3')
      steps.push('acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=3')
    }
    if (fx.normalize) steps.push('loudnorm=I=-14:TP=-1.5:LRA=11')
    steps.push(`volume=${clip.volume.toFixed(4)}`)
    if (clip.fadeIn > 0) steps.push(`afade=t=in:st=0:d=${sec(clip.fadeIn)}`)
    if (clip.fadeOut > 0) steps.push(`afade=t=out:st=${sec(clip.duration - clip.fadeOut)}:d=${sec(clip.fadeOut)}`)
    const delay = Math.max(0, Math.round((clip.start - offset) / 1000))
    steps.push(`adelay=${delay}:all=1`)
    const out = next('a')
    graph.push(`[${input.index}:a]${steps.join(',')}[${out}]`)
    audioLabels.push(out)
  }

  // Base negra del tamaño de exportación.
  let comp = next('base')
  graph.push(`color=c=${hexColor(canvas.background)}:s=${W}x${H}:r=${fps}:d=${sec(total)},format=rgba[${comp}]`)

  // Pista principal encadenada, con transiciones.
  const main = project.tracks[0]
  const mainClips = main.clips.filter((c): c is MediaClip => c.type === 'media')
  const windows = mainWindows(mainClips)
  if (!main.hidden || !main.muted) {
    let chain: string | null = null
    let chainEnd = 0
    for (let i = 0; i < mainClips.length; i++) {
      const clip = mainClips[i]
      const w = windows[i]
      const input = openInput(clip, w)
      audioChain(clip, input, w, main.muted)
      if (main.hidden) continue
      const v = videoChain(clip, w, input)
      if (!chain) {
        chain = v
      } else {
        const prev = mainClips[i - 1]
        const out = next('m')
        if (prev.transition) {
          const d = prev.transition.duration
          graph.push(`[${chain}][${v}]xfade=transition=${prev.transition.kind}:duration=${sec(d)}:offset=${sec(clip.start - d / 2)}[${out}]`)
        } else {
          graph.push(`[${chain}][${v}]concat=n=2:v=1:a=0[${out}]`)
        }
        chain = out
      }
      chainEnd = w.to
    }
    if (chain) {
      const shifted = next('ms')
      graph.push(`[${chain}]trim=start=${sec(offset)}:duration=${sec(Math.min(total, chainEnd - offset))},setpts=PTS-STARTPTS[${shifted}]`)
      const out = next('o')
      graph.push(`[${comp}][${shifted}]overlay=eof_action=pass:format=auto[${out}]`)
      comp = out
    }
  }

  // Pistas superpuestas (de abajo hacia arriba).
  const texts: { clip: TextClip }[] = []
  for (const track of project.tracks.slice(1)) {
    for (const clip of track.clips) {
      if (!visible(clip.start, clipEnd(clip))) continue
      if (clip.type === 'text') {
        if (!track.hidden) texts.push({ clip })
        continue
      }
      const w: ClipWindow = { from: clip.start, to: clipEnd(clip), preRoll: 0, postRoll: 0 }
      const input = openInput(clip, w)
      audioChain(clip, input, w, track.muted)
      if (track.hidden || track.kind === 'audio' || project.media[clip.mediaId].kind === 'audio') continue
      const v = videoChain(clip, w, input)
      const timed = next('t')
      graph.push(`[${v}]setpts=PTS-STARTPTS+${sec(clip.start - offset)}/TB[${timed}]`)
      const out = next('o')
      graph.push(`[${comp}][${timed}]overlay=eof_action=pass:format=auto[${out}]`)
      comp = out
    }
  }

  // Textos con drawtext; el contenido va en archivos para no pelear con el escapado.
  for (const { clip } of texts) {
    const s = clip.style
    const textPath = `${opts.tmpDir.replace(/\\/g, '/')}/text-${clip.id}.txt`
    files.push({ path: textPath, content: clip.text })
    const size = Math.round(s.size * (H / 1080) * clip.transform.scale)
    const parts = [
      `fontfile=${q(fontFile(opts.fontDir, s.font, s.bold, s.italic))}`,
      `textfile=${q(textPath)}`,
      `fontsize=${size}`,
      `fontcolor=${hexColor(s.color)}@${clip.transform.opacity.toFixed(3)}`,
      `x=(w-text_w)/2+${((clip.transform.x * W) / 2).toFixed(2)}`,
      `y=(h-text_h)/2+${((clip.transform.y * H) / 2).toFixed(2)}`,
      `text_align=${s.align === 'left' ? 'L' : s.align === 'right' ? 'R' : 'C'}`,
      `enable='between(t,${sec(clip.start - offset)},${sec(clipEnd(clip) - offset)})'`
    ]
    if (s.strokeWidth > 0) parts.push(`borderw=${Math.max(1, Math.round(s.strokeWidth * size * 0.08))}`, `bordercolor=${hexColor(s.strokeColor)}`)
    if (s.background) parts.push('box=1', `boxcolor=${hexColor(s.background)}`, `boxborderw=${Math.round(size * 0.25)}`)
    const out = next('o')
    graph.push(`[${comp}]drawtext=${parts.join(':')}[${out}]`)
    comp = out
  }

  const vout = next('vout')
  graph.push(`[${comp}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[${vout}]`)

  let aout: string | null = null
  if (audioLabels.length) {
    aout = next('aout')
    const mix = audioLabels.length > 1 ? `amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,` : ''
    graph.push(`${audioLabels.map((l) => `[${l}]`).join('')}${mix}apad,atrim=duration=${sec(total)}[${aout}]`)
  }

  const scriptPath = `${opts.tmpDir.replace(/\\/g, '/')}/graph.txt`
  files.push({ path: scriptPath, content: graph.join(';\n') })

  const ex = project.export
  const kbps = ex.bitrate ?? autoBitrate(W, H, fps)
  const encoder = opts.encoder
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`]
  const encArgs = encoder.endsWith('_nvenc')
    ? ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', ...rate]
    : encoder.endsWith('_qsv') || encoder.endsWith('_amf')
      ? rate
      : ['-preset', 'veryfast', ...rate]

  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...inputs,
    '-/filter_complex', scriptPath,
    '-map', `[${vout}]`,
    ...(aout ? ['-map', `[${aout}]`, '-c:a', 'aac', '-b:a', '320k', '-ar', '48000'] : []),
    '-c:v', encoder, ...encArgs,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(fps), '-t', sec(total),
    '-movflags', '+faststart',
    opts.output
  ]
  return { args, files, duration: total }
}
