// Puente local para el CLI: un WebSocket en 127.0.0.1 protegido con un token que
// solo se puede leer desde este usuario de Windows. Cada petición del CLI se
// atiende aquí o se reenvía a la ventana, que aplica los cambios en vivo.

import { app } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

export interface BridgeRequest {
  id: number
  method: string
  params?: Record<string, unknown>
}

export type BridgeHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

export const bridgeInfoPath = (): string => join(app.getPath('userData'), 'bridge.json')

export async function startBridge(handle: BridgeHandler): Promise<() => void> {
  const token = randomBytes(24).toString('hex')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024 * 1024 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const { port } = wss.address() as AddressInfo

  const info = bridgeInfoPath()
  await mkdir(dirname(info), { recursive: true })
  await writeFile(info, JSON.stringify({ port, token, pid: process.pid }), { encoding: 'utf8', mode: 0o600 })

  wss.on('connection', (socket: WebSocket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('token') !== token) {
      socket.close(4401, 'token inválido')
      return
    }
    socket.on('message', async (raw) => {
      let msg: BridgeRequest
      try {
        msg = JSON.parse(raw.toString()) as BridgeRequest
      } catch {
        return
      }
      try {
        const result = await handle(msg.method, msg.params ?? {})
        socket.send(JSON.stringify({ id: msg.id, result }))
      } catch (err) {
        socket.send(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }))
      }
    })
  })

  return () => wss.close()
}
