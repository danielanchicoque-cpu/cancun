declare module 'mp4box' {
  export function createFile(): unknown
  export class DataStream {
    static BIG_ENDIAN: boolean
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    buffer: ArrayBuffer
  }
}
