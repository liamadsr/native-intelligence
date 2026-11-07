/**
 * The Realtime fence in src/test/setup.ts: a unit test must never open a real
 * websocket to the supabase host (on a Vercel build that host is prod). The
 * guard throws at construction, and supabase-js surfaces that from the
 * `subscribe()` call — the line that needs the mock.
 */
import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const host = process.env.NEXT_PUBLIC_SUPABASE_URL!
const socketUrl = `${host.replace(/^http/, 'ws')}/realtime/v1/websocket`

describe('the Realtime fence', () => {
  it('refuses a socket to the resolved supabase host and to the placeholder', () => {
    expect(() => new WebSocket(socketUrl)).toThrow(/real Realtime connection to the supabase host/)
    expect(() => new WebSocket('wss://test.supabase.co/realtime/v1/websocket')).toThrow(/mock the channel/)
    expect(() => new WebSocket(new URL(socketUrl))).toThrow(/supabase host/)
  })

  it('leaves every other host alone, with the real constructor’s statics and instanceof', async () => {
    expect(WebSocket.OPEN).toBe(1)
    expect(WebSocket.CLOSED).toBe(3)
    // Nothing listens on this port: the socket is created, then fails to
    // connect on its own — no network beyond loopback.
    const ws = new WebSocket('ws://127.0.0.1:9/')
    expect(ws).toBeInstanceOf(WebSocket)
    await new Promise<void>((resolve) => {
      ws.addEventListener('error', () => resolve())
      ws.addEventListener('close', () => resolve())
    })
  })

  it('surfaces at channel.subscribe() through supabase-js, naming the fix', () => {
    const client = createClient(host, 'test-anon-key', { auth: { persistSession: false } })
    const channel = client
      .channel('fence-probe')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tracked_job' }, () => {})
    expect(() => channel.subscribe()).toThrow(/mock the channel or the supabase client/)
  })
})
