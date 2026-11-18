// Motor de la vista previa: un elemento <video> por clip cercano (decodificación por
// hardware del navegador), audio por WebAudio y un reloj propio. Cada cuadro pide las
// capas visibles al modelo y se las pasa al mismo compositor que usa la exportación.

import type { CubeLut } from '@shared/cube'
import { type MediaClip, type Project, US, projectDuration } from '@shared/project'
import { type ClipFrame, audibleAt, clipsNear, layersAt } from '@shared/timeline'
import { type VoiceResult, voiceJob, voiceKey } from '@shared/voice'
import { api, mediaUrl } from '../api'
import { Compositor, type FrameSource, type SegSource } from '../gl/Compositor'
import { Segmenter, needsSegmentation, protectsSkinBelow, segNeeds } from './Segmenter'

const PRELOAD_BEFORE = 1 * US
const PRELOAD_AFTER = 3 * US
const MAX_POOL = 16
const DRIFT_PLAYING = 0.2

interface Slot {
  clipId: string
  mediaId: string
  el: HTMLVideoElement | HTMLImageElement
  gain: GainNode | null
  /** Audio ya limpio por el motor de voz (si el clip tiene efectos de voz). */
  voice: { key: string; el: HTMLAudioElement; gain: GainNode; start: number } | null
  lastUsed: number
}

export class Player {
  private compositor: Compositor
  private slots = new Map<string, Slot>()
  private audio = new AudioContext({ latencyHint: 'interactive' })
  private luts = new Map<string, CubeLut>()
  private lutLoading = new Set<string>()
  private segmenter: Segmenter | null = null
  private segLoading = false
  private voices = new Map<string, VoiceResult>()
  private voiceLoading = new Set<string>()
  private raf = 0
  private playing = false
  private clockStart = 0
  private timeStart = 0
  private project: Project | null = null
  private time = 0
  private dirty = true
  /** Ancho máximo de la vista previa (más chico = más fluido). */
  private maxWidth = 1280

  constructor(
    private canvas: HTMLCanvasElement,
    private onTime: (t: number) => void,
    private onEnded: () => void
  ) {
    this.compositor = new Compositor(canvas)
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    for (const s of this.slots.values()) this.dispose(s)
    void this.audio.close()
  }

  /** Calidad de la vista previa en píxeles de ancho (CapCut usa una vista reducida). */
  setQuality(maxWidth: number) {
    this.maxWidth = maxWidth
    if (this.project) this.setProject(this.project)
  }

  setProject(p: Project) {
    this.project = p
    const w = Math.min(p.canvas.width, this.maxWidth)
    this.compositor.resize(w, Math.round((p.canvas.height * w) / p.canvas.width), p.canvas.width)
    let wantsSeg = false
    for (const t of p.tracks)
      for (const c of t.clips) {
        // Los LUT de las capas de ajuste también (antes solo se cargaban los de los clips
        // y la capa de ajuste se veía sin LUT).
        if ((c.type === 'media' || c.type === 'adjust') && c.color.lut) this.ensureLut(c.color.lut.path)
        if (c.type !== 'media') continue
        if (needsSegmentation(c, protectsSkinBelow(p))) wantsSeg = true
      }
    if (wantsSeg) this.ensureSegmenter()
    const alive = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)))
    for (const [id, s] of this.slots) if (!alive.has(id)) this.dispose(s)
    this.compositor.prune(alive)
    this.dirty = true
  }

  seek(t: number) {
    if (Math.abs(t - this.time) < 1 && !this.dirty) return
    this.time = t
    if (this.playing) {
      this.clockStart = performance.now()
      this.timeStart = t
    }
    this.dirty = true
  }

  play() {
    if (this.playing) return
    void this.audio.resume()
    this.playing = true
    this.clockStart = performance.now()
    this.timeStart = this.time
  }

  pause() {
    this.playing = false
    for (const s of this.slots.values()) {
      if (s.el instanceof HTMLVideoElement) s.el.pause()
      s.voice?.el.pause()
    }
    this.dirty = true
  }

  /** PNG del cuadro en `t`, esperando a que los videos terminen de buscar (lo usa el CLI). */
  async frameAt(t: number, timeoutMs = 5000): Promise<string> {
    this.seek(t)
    const deadline = performance.now() + timeoutMs
    for (;;) {
      this.draw()
      await new Promise((r) => requestAnimationFrame(r))
      if (!this.busy(t) || performance.now() > deadline) break
    }
    this.draw()
    return this.canvas.toDataURL('image/png')
  }

  /** Cuadro actual en JPEG pequeño (portada del proyecto). Sin esperar a que cargue nada. */
  snapshot(width = 360): string {
    this.draw()
    const c = document.createElement('canvas')
    c.width = width
    c.height = Math.round((width * this.canvas.height) / this.canvas.width)
    c.getContext('2d')!.drawImage(this.canvas, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.8)
  }

  private busy(t: number): boolean {
    const p = this.project
    if (!p) return false
    if (this.lutLoading.size > 0 || this.segLoading) return true
    const visible = new Set<string>()
    const frames: ClipFrame[] = []
    for (const l of layersAt(p, t)) {
      if (l.kind === 'clip') frames.push(l.frame)
      else if (l.kind === 'transition') frames.push(l.a, l.b)
    }
    for (const f of frames) visible.add(f.clip.id)
    // Para la captura exacta (CLI, portadas) la máscara tiene que ser de este mismo cuadro.
    const waitingMask = frames.some(
      (f) =>
        needsSegmentation(f.clip, protectsSkinBelow(p)) &&
        (!this.segmenter || (p.media[f.clip.mediaId]?.kind === 'image' ? !this.segmenter.has(f.clip.id) : !this.segmenter.hasFresh(f.clip.id, f.source / US)))
    )
    return (
      waitingMask ||
      [...this.slots.values()].some((s) => visible.has(s.clipId) && s.el instanceof HTMLVideoElement && (s.el.seeking || s.el.readyState < 2))
    )
  }

  private ensureLut(path: string) {
    if (this.luts.has(path) || this.lutLoading.has(path)) return
    this.lutLoading.add(path)
    api
      .loadLut(path)
      .then((l) => {
        this.luts.set(path, { ...l, data: new Float32Array(l.data) })
        this.dirty = true
      })
      .catch((err) => console.error('LUT', path, err))
      .finally(() => this.lutLoading.delete(path))
  }

  private ensureSegmenter() {
    if (this.segmenter || this.segLoading) return
    this.segLoading = true
    Segmenter.get()
      .then((s) => {
        this.segmenter = s
        s.onMask = () => (this.dirty = true)
        this.dirty = true
      })
      .catch((err) => console.error('Segmentación', err))
      .finally(() => (this.segLoading = false))
  }

  private slotFor(p: Project, clip: MediaClip): Slot {
    let slot = this.slots.get(clip.id)
    if (slot && slot.mediaId !== clip.mediaId) {
      this.dispose(slot)
      slot = undefined
    }
    if (!slot) {
      const media = p.media[clip.mediaId]
      let el: HTMLVideoElement | HTMLImageElement
      let gain: GainNode | null = null
      if (media.kind === 'image') {
        el = new Image()
        el.decoding = 'async'
        el.onload = () => (this.dirty = true)
        el.src = mediaUrl(media.path)
      } else {
        const v = document.createElement('video')
        v.src = mediaUrl(media.path)
        v.preload = 'auto'
        v.playsInline = true
        v.crossOrigin = 'anonymous'
        v.disableRemotePlayback = true
        v.onseeked = () => (this.dirty = true)
        v.onloadeddata = () => (this.dirty = true)
        if (media.hasAudio) {
          gain = this.audio.createGain()
          gain.gain.value = 0
          this.audio.createMediaElementSource(v).connect(gain).connect(this.audio.destination)
        } else v.muted = true
        el = v
      }
      slot = { clipId: clip.id, mediaId: clip.mediaId, el, gain, voice: null, lastUsed: performance.now() }
      this.slots.set(clip.id, slot)
      this.evict()
    }
    slot.lastUsed = performance.now()
    return slot
  }

  private dispose(s: Slot) {
    if (s.el instanceof HTMLVideoElement) {
      s.el.pause()
      s.el.removeAttribute('src')
      s.el.load()
    }
    s.gain?.disconnect()
    this.dropVoice(s)
    this.segmenter?.forget(s.clipId)
    this.slots.delete(s.clipId)
  }

  /** Audio limpio del clip: lo pide al proceso principal la primera vez y lo conecta. */
  private voiceFor(p: Project, clip: MediaClip, slot: Slot): Slot['voice'] {
    const job = voiceJob(clip, p.media[clip.mediaId])
    if (!job) {
      this.dropVoice(slot)
      return null
    }
    const key = voiceKey(job)
    if (slot.voice?.key === key) return slot.voice
    const ready = this.voices.get(key)
    if (!ready) {
      if (!this.voiceLoading.has(key)) {
        this.voiceLoading.add(key)
        api
          .prepareVoice(job)
          .then((r) => {
            this.voices.set(key, r)
            this.dirty = true
          })
          .catch((err) => console.error('Voz', err))
          .finally(() => this.voiceLoading.delete(key))
      }
      // Mientras se procesa, suena el audio original (sin efectos).
      return slot.voice
    }
    this.dropVoice(slot)
    const el = new Audio(mediaUrl(ready.path))
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    const gain = this.audio.createGain()
    gain.gain.value = 0
    this.audio.createMediaElementSource(el).connect(gain).connect(this.audio.destination)
    slot.voice = { key, el, gain, start: ready.start }
    return slot.voice
  }

  /**
   * Recorte cuadrado de la cara detectada en el cuadro actual del clip (como el cuadrito
   * que muestra CapCut al ajustar los rasgos). null si no hay cara o aún no se detectó.
   */
  faceThumb(clipId: string, size = 96): string | null {
    const slot = this.slots.get(clipId)
    const face = this.segmenter?.latestFor(clipId)?.marks?.face
    if (!slot || !face) return null
    const el = slot.el
    const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth
    const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight
    if (!w || !h) return null
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0
    for (let i = 0; i < face.length; i += 2) {
      x0 = Math.min(x0, face[i]); x1 = Math.max(x1, face[i])
      y0 = Math.min(y0, face[i + 1]); y1 = Math.max(y1, face[i + 1])
    }
    const side = Math.max((x1 - x0) * w, (y1 - y0) * h) * 1.35
    const cx = ((x0 + x1) / 2) * w
    const cy = ((y0 + y1) / 2) * h
    const c = document.createElement('canvas')
    c.width = c.height = size
    c.getContext('2d')!.drawImage(el, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size)
    return c.toDataURL('image/jpeg', 0.85)
  }

  private dropVoice(s: Slot) {
    if (!s.voice) return
    s.voice.el.pause()
    s.voice.el.removeAttribute('src')
    s.voice.el.load()
    s.voice.gain.disconnect()
    s.voice = null
  }

  private evict() {
    if (this.slots.size <= MAX_POOL) return
    const old = [...this.slots.values()].sort((a, b) => a.lastUsed - b.lastUsed)
    for (const s of old.slice(0, this.slots.size - MAX_POOL)) this.dispose(s)
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop)
    const p = this.project
    if (!p) return
    if (this.playing) {
      this.time = this.timeStart + (now - this.clockStart) * 1000
      const end = projectDuration(p)
      if (this.time >= end) {
        this.time = end
        this.pause()
        this.onEnded()
      }
      this.onTime(this.time)
      this.dirty = true
    }
    if (this.dirty) this.draw()
  }

  private draw() {
    const p = this.project
    if (!p) return
    this.dirty = false
    const t = this.time
    const layers = layersAt(p, t)
    const sources = new Map<string, FrameSource>()
    const segs = new Map<string, SegSource>()
    const visible = new Map<string, { source: number; clip: MediaClip }>()
    for (const l of layers) {
      if (l.kind === 'clip') visible.set(l.frame.clip.id, { source: l.frame.source, clip: l.frame.clip })
      else if (l.kind === 'transition') {
        visible.set(l.a.clip.id, { source: l.a.source, clip: l.a.clip })
        visible.set(l.b.clip.id, { source: l.b.source, clip: l.b.clip })
      }
    }
    const gains = new Map(audibleAt(p, t).map((a) => [a.clip.id, a]))

    for (const clip of clipsNear(p, t, PRELOAD_BEFORE, PRELOAD_AFTER)) {
      const slot = this.slotFor(p, clip)
      const vis = visible.get(clip.id)
      const audible = gains.get(clip.id)
      const target = vis?.source ?? audible?.source
      const voice = slot.gain ? this.voiceFor(p, clip, slot) : null
      const level = this.playing ? audible?.gain ?? 0 : 0
      if (slot.gain) slot.gain.gain.setTargetAtTime(voice ? 0 : level, this.audio.currentTime, 0.01)
      if (voice) {
        voice.gain.gain.setTargetAtTime(level, this.audio.currentTime, 0.01)
        const a = voice.el
        if (this.playing && target !== undefined && !clip.freeze) {
          const want = Math.max(0, (target - voice.start) / US)
          a.playbackRate = clip.speed
          if (a.paused) {
            a.currentTime = want
            void a.play().catch(() => undefined)
          } else if (Math.abs(a.currentTime - want) > DRIFT_PLAYING * Math.max(1, clip.speed)) a.currentTime = want
        } else if (!a.paused) a.pause()
      }
      if (slot.el instanceof HTMLVideoElement) {
        const v = slot.el
        if (target === undefined) {
          // Clip próximo: se deja en su primer cuadro para que entre sin tirón.
          if (!v.paused) v.pause()
          if (Math.abs(v.currentTime - clip.sourceIn / US) > 0.05 && !v.seeking) v.currentTime = clip.sourceIn / US
          continue
        }
        const want = target / US
        if (this.playing && !clip.freeze) {
          v.playbackRate = clip.speed
          if (v.paused) {
            v.currentTime = want
            void v.play().catch(() => undefined)
          } else if (Math.abs(v.currentTime - want) > DRIFT_PLAYING * Math.max(1, clip.speed)) {
            v.currentTime = want
          }
        } else {
          if (!v.paused) v.pause()
          if (Math.abs(v.currentTime - want) > 0.5 / (p.canvas.fps || 30) && !v.seeking) v.currentTime = want
        }
      }
      if (vis) {
        sources.set(clip.id, slot.el)
        const ready = slot.el instanceof HTMLVideoElement ? slot.el.readyState >= 2 : slot.el.complete
        if (this.segmenter && ready && needsSegmentation(vis.clip, protectsSkinBelow(p))) {
          // Mientras el video busca, su cuadro aún es el viejo: no se pide máscara de él.
          const video = slot.el instanceof HTMLVideoElement ? slot.el : null
          // En pausa, si ya hay máscara de este mismo cuadro no se pide otra: antes cada
          // máscara nueva provocaba un repintado que pedía otra, sin fin (la GPU nunca
          // descansaba y todo, hasta el desplazamiento de los paneles, se sentía lento).
          const t = video?.currentTime ?? 0
          const settled = !this.playing && (video ? this.segmenter.hasFresh(clip.id, t) : this.segmenter.has(clip.id))
          const seg = video?.seeking || settled ? this.segmenter.latestFor(clip.id) : this.segmenter.request(clip.id, slot.el, t, segNeeds(vis.clip))
          if (seg) segs.set(clip.id, seg)
        }
      }
    }

    this.compositor.render(p, layers, sources, this.luts, segs)
    if (!this.playing && this.busy(t)) this.dirty = true
  }
}
