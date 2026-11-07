/**
 * openLiveSocket against a real local `ws` server: the key goes in the
 * Authorization header, text frames flow both ways, a refused attach rejects,
 * and a close reaches the bridge.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { openLiveSocket } from '../live-bridge'

let wss: WebSocketServer | null = null
let http: Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()))
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  wss = null
  http = null
})

function listen(onConnection: (socket: ServerSocket, auth: string | undefined) => void): Promise<string> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0 }, () => resolve(`ws://127.0.0.1:${(wss!.address() as AddressInfo).port}/attach`))
    wss.on('connection', (socket, req) => onConnection(socket, req.headers.authorization))
  })
}

describe('openLiveSocket', () => {
  it('attaches with the key and passes text frames both ways', async () => {
    let auth: string | undefined
    let server!: ServerSocket
    const received: string[] = []
    const url = await listen((socket, a) => {
      auth = a
      server = socket
      socket.on('message', (data) => received.push(data.toString()))
    })
    const socket = await openLiveSocket(url, 'sk-test-key')
    const got: string[] = []
    const closed = new Promise<void>((resolve) => socket.onClose(resolve))
    socket.onMessage((text) => got.push(text))
    socket.send('{"type":"session.thinking.append"}')
    await new Promise((resolve) => setTimeout(resolve, 50))
    server.send('{"type":"session.delegation.created"}')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(auth).toBe('Bearer sk-test-key')
    expect(received).toEqual(['{"type":"session.thinking.append"}'])
    expect(got).toEqual(['{"type":"session.delegation.created"}'])
    server.close()
    await closed
  })

  it('rejects an attach the server refuses', async () => {
    const url = await new Promise<string>((resolve) => {
      http = createServer((_req, res) => {
        res.writeHead(401)
        res.end()
      })
      http.listen(0, () => resolve(`ws://127.0.0.1:${(http!.address() as AddressInfo).port}/attach`))
    })
    await expect(openLiveSocket(url, 'bad')).rejects.toThrow('attach refused (401)')
  })
})
