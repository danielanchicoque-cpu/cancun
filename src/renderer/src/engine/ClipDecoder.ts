// Decodificación cuadro-exacta con WebCodecs (por hardware). Lee el índice de muestras
// del MP4/MOV con mp4box y pide al archivo solo los bytes que necesita, así sirve
// para videos largos sin cargarlos enteros en memoria.

import { createFile, DataStream } from 'mp4box'

interface Sample {
  offset: number
  size: number
  /** Tiempo de presentación en µs. */
  cts: number
  sync: boolean
}

interface Mp4Sample {
  offset: number
  size: number
  cts: number
  timescale: number
  is_sync: boolean
}

interface Mp4Box {
  write(stream: DataStream): void
}

interface Mp4Trak {
  samples: Mp4Sample[]
  mdia: { minf: { stbl: { stsd: { entries: Record<string, Mp4Box | undefined>[] } } } }
}

interface Mp4File {
  onReady: (info: { videoTracks: { id: number; codec: string; video: { width: number; height: number } }[] }) => void
  onError: (e: string) => void
  appendBuffer(b: ArrayBuffer & { fileStart: number }): number
  flush(): void
  getTrackById(id: number): Mp4Trak
}

const CHUNK = 6 * 1024 * 1024
const MAX_QUEUED_FRAMES = 6

async function fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
  if (!r.ok) throw new Error(`No se pudo leer ${url} (${r.status})`)
  return r.arrayBuffer()
}

/** Busca las cajas de nivel superior (ftyp, moov) sin leer el mdat. */
async function readHeader(url: string, size: number): Promise<{ boxes: { type: string; start: number; size: number }[] }> {
  const boxes: { type: string; start: number; size: number }[] = []
  let pos = 0
  while (pos + 8 <= size) {
    const head = new DataView(await fetchRange(url, pos, Math.min(size, pos + 16)))
    let boxSize = head.getUint32(0)
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7))
    if (boxSize === 1) boxSize = Number(head.getBigUint64(8))
    else if (boxSize === 0) boxSize = size - pos
    if (boxSize < 8) break
    boxes.push({ type, start: pos, size: boxSize })
    pos += boxSize
  }
  return { boxes }
}

function fail(reason: string, ...detail: unknown[]): null {
  console.warn('WebCodecs no disponible:', reason, ...detail)
  return null
}

export const decodeStats = { waits: 0, waitMs: 0, chunks: 0, fetches: 0, fetchMs: 0, fetchBytes: 0, resets: 0 }

export class ClipDecoder {
  private decoder: VideoDecoder | null = null
  private next = 0
  private frames: VideoFrame[] = []
  private pending: Promise<void> | null = null
  private wake: (() => void) | null = null
  private error: Error | null = null
  private cache: { start: number; end: number; data: Uint8Array } | null = null
  private flushed = false

  private constructor(
    private url: string,
    private config: VideoDecoderConfig,
    private samples: Sample[]
  ) {}

  /** null si el formato o el códec no se pueden decodificar así (se usa el plan B con ffmpeg). */
  static async open(url: string): Promise<ClipDecoder | null> {
    if (typeof VideoDecoder === 'undefined') return null
    const head = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    const size = Number(head.headers.get('content-range')?.split('/')[1] ?? 0)
    if (!size) return fail('sin tamaño (Range)', head.status, [...head.headers].join(';'))
    const { boxes } = await readHeader(url, size)
    const moov = boxes.find((b) => b.type === 'moov')
    if (!moov || !boxes.some((b) => b.type === 'ftyp')) return fail('sin moov/ftyp', boxes.map((b) => b.type).join(','))

    const file = createFile() as unknown as Mp4File
    const ready = new Promise<Parameters<Mp4File['onReady']>[0]>((resolve, reject) => {
      file.onReady = resolve
      file.onError = (e) => reject(new Error(e))
    })
    // mp4box lee en orden; como solo hace falta el índice (los offsets de las muestras
    // son absolutos), se le entregan ftyp y moov pegados aunque el moov esté al final.
    const parts = await Promise.all(
      boxes.filter((x) => x.type === 'ftyp' || x.type === 'moov').map((b) => fetchRange(url, b.start, b.start + b.size))
    )
    const joined = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0))
    let at = 0
    for (const b of parts) {
      joined.set(new Uint8Array(b), at)
      at += b.byteLength
    }
    const buf = joined.buffer as ArrayBuffer & { fileStart: number }
    buf.fileStart = 0
    file.appendBuffer(buf)
    file.flush()
    const info = await Promise.race([ready, new Promise<null>((r) => setTimeout(() => r(null), 3000))])
    const track = info?.videoTracks[0]
    if (!track) return fail('mp4box sin pista de video', JSON.stringify(info)?.slice(0, 200))
    const trak = file.getTrackById(track.id)

    let description: Uint8Array | undefined
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
        box.write(stream)
        description = new Uint8Array(stream.buffer, 8)
        break
      }
    }
    const config: VideoDecoderConfig = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      description,
      hardwareAcceleration: 'prefer-hardware'
    }
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))
    if (!support.supported) return fail('códec no soportado', JSON.stringify({ ...config, description: undefined }))
    const samples = trak.samples.map((s) => ({
      offset: s.offset,
      size: s.size,
      cts: Math.round((s.cts * 1_000_000) / s.timescale),
      sync: s.is_sync
    }))
    return new ClipDecoder(url, config, samples)
  }

  private reset(fromIndex: number) {
    decodeStats.resets++
    for (const f of this.frames) f.close()
    this.frames = []
    this.decoder?.close()
    this.flushed = false
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.frames.push(frame)
        this.frames.sort((a, b) => a.timestamp - b.timestamp)
        this.wake?.()
      },
      error: (e) => {
        this.error = e instanceof Error ? e : new Error(String(e))
        this.wake?.()
      }
    })
    // Despierta al liberar la cola de entrada, no solo al entregar un cuadro.
    this.decoder.addEventListener('dequeue', () => this.wake?.())
    this.decoder.configure(this.config)
    this.next = fromIndex
  }

  private async sampleData(i: number): Promise<Uint8Array> {
    const s = this.samples[i]
    const c = this.cache
    if (!c || s.offset < c.start || s.offset + s.size > c.end) {
      const start = s.offset
      let end = start + s.size
      // Lee de una vez las muestras siguientes que quepan en el bloque.
      for (let j = i + 1; j < this.samples.length && this.samples[j].offset + this.samples[j].size - start <= CHUNK; j++) {
        if (this.samples[j].offset >= start) end = Math.max(end, this.samples[j].offset + this.samples[j].size)
      }
      const t0 = performance.now()
      this.cache = { start, end, data: new Uint8Array(await fetchRange(this.url, start, end)) }
      decodeStats.fetches++
      decodeStats.fetchMs += performance.now() - t0
      decodeStats.fetchBytes += end - start
    }
    const cc = this.cache!
    return cc.data.subarray(s.offset - cc.start, s.offset - cc.start + s.size)
  }

  private waitOutput(): Promise<void> {
    decodeStats.waits++
    const t0 = performance.now()
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null
        resolve()
      }
      setTimeout(() => this.wake?.(), 8)
    }).then(() => {
      decodeStats.waitMs += performance.now() - t0
    })
  }

  private keyIndexFor(us: number): number {
    let key = 0
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].sync && this.samples[i].cts <= us) key = i
      if (this.samples[i].cts > us + 2_000_000) break
    }
    return key
  }

  /**
   * Cuadro que se ve en el instante `us` de la fuente. El cuadro pertenece al
   * decodificador: sirve hasta la siguiente llamada.
   */
  async frameAt(us: number): Promise<VideoFrame | null> {
    while (this.pending) await this.pending
    let release!: () => void
    this.pending = new Promise((r) => (release = r))
    try {
      return await this.locate(us)
    } finally {
      this.pending = null
      release()
    }
  }

  private async locate(us: number): Promise<VideoFrame | null> {
    if (this.error) throw this.error
    const started = performance.now()
    const newest = this.frames[this.frames.length - 1]
    const oldest = this.frames[0]
    // Saltar hacia atrás o muy adelante: se reinicia desde el cuadro clave anterior.
    const far = newest ? us > newest.timestamp + 2_000_000 : true
    const back = oldest ? us < oldest.timestamp - 1000 : false
    if (!this.decoder || back || (far && this.keyIndexFor(us) > this.next)) this.reset(this.keyIndexFor(us))

    for (;;) {
      if (this.error) throw this.error
      if (performance.now() - started > 4000) {
        console.warn(`decodificador atascado en ${us}µs: next=${this.next}/${this.samples.length} cola=${this.decoder?.decodeQueueSize} cuadros=${this.frames.map((f) => f.timestamp).join(',')} flushed=${this.flushed} estado=${this.decoder?.state}`)
        break
      }
      const after = this.frames.findIndex((f) => f.timestamp > us + 500)
      if (after >= 0 || this.flushed) break
      if (this.next < this.samples.length) {
        if (this.decoder!.decodeQueueSize > 16 || this.frames.length > MAX_QUEUED_FRAMES + 8) {
          await this.waitOutput()
          this.trimBefore(us)
          continue
        }
        const s = this.samples[this.next]
        const data = await this.sampleData(this.next)
        decodeStats.chunks++
        this.decoder!.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: s.cts, data }))
        this.next++
        this.trimBefore(us)
      } else {
        // flush() puede no volver si el decodificador por hardware se queda sin salida.
        const ok = await Promise.race([
          this.decoder!.flush().then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 400))
        ])
        this.flushed = true
      }
    }
    let best: VideoFrame | null = null
    for (const f of this.frames) if (f.timestamp <= us + 500) best = f
    best ??= this.frames[0] ?? null
    this.trimBefore(best ? best.timestamp : us)
    return best
  }

  /** Libera los cuadros anteriores al que se va a mostrar. */
  private trimBefore(us: number) {
    let keep = 0
    for (let i = 0; i < this.frames.length; i++) if (this.frames[i].timestamp <= us + 500) keep = i
    if (keep > 0) {
      for (const f of this.frames.splice(0, keep)) f.close()
    }
  }

  close() {
    for (const f of this.frames) f.close()
    this.frames = []
    this.decoder?.close()
    this.decoder = null
  }
}
