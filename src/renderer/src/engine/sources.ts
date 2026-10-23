// Proveedores de cuadros por clip para la exportación: WebCodecs cuando se puede
// (MP4/MOV, por hardware) y, si no, ffmpeg decodificando en el proceso principal.

import { type Media, type MediaClip, US } from '@shared/project'
import { mediaUrl } from '../api'
import type { FrameSource } from '../gl/Compositor'
import { ClipDecoder } from './ClipDecoder'

export interface FrameProvider {
  frameAt(sourceUs: number): Promise<FrameSource | ImageData | null>
  close(): void
}

class ImageProvider implements FrameProvider {
  private bitmap: Promise<ImageBitmap>
  constructor(path: string) {
    this.bitmap = fetch(mediaUrl(path))
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
  }
  frameAt() {
    return this.bitmap
  }
  close() {
    void this.bitmap.then((b) => b.close())
  }
}

class WebCodecsProvider implements FrameProvider {
  constructor(private dec: ClipDecoder) {}
  frameAt(us: number) {
    return this.dec.frameAt(us)
  }
  close() {
    this.dec.close()
  }
}

/** Plan B: ffmpeg entrega cuadros RGBA en orden a la cadencia de la fuente. */
class FfmpegProvider implements FrameProvider {
  private id: Promise<number>
  private current: { us: number; img: ImageData } | null = null
  private nextUs = 0
  private readonly step: number

  constructor(
    media: Media,
    private startUs: number,
    rate: number,
    private w: number,
    private h: number
  ) {
    this.step = US / rate
    this.nextUs = startUs
    this.id = window.cancun.decode.open(media.path, startUs, rate, w, h)
  }

  async frameAt(us: number) {
    const id = await this.id
    while (!this.current || this.nextUs <= us + this.step / 2) {
      const data = await window.cancun.decode.frame(id)
      if (!data) break
      this.current = { us: this.nextUs, img: new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), this.w, this.h) }
      this.nextUs += this.step
    }
    return this.current?.img ?? null
  }

  close() {
    void this.id.then((id) => window.cancun.decode.close(id))
  }
}

export async function openProvider(media: Media, clip: MediaClip, fps: number): Promise<FrameProvider> {
  if (media.kind === 'image') return new ImageProvider(media.path)
  const dec = await ClipDecoder.open(mediaUrl(media.path)).catch((err) => {
    console.warn('WebCodecs falló:', err instanceof Error ? err.message : err)
    return null
  })
  if (dec) return new WebCodecsProvider(dec)
  // Resolución de decodificación: la del medio, limitada a 1920 por el lado mayor.
  const mw = media.width ?? 1920
  const mh = media.height ?? 1080
  const k = Math.min(1, 1920 / Math.max(mw, mh))
  const w = Math.max(2, Math.round((mw * k) / 2) * 2)
  const h = Math.max(2, Math.round((mh * k) / 2) * 2)
  return new FfmpegProvider(media, clip.sourceIn, fps * Math.max(clip.speed, 0.01), w, h)
}
