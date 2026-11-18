/**
 * Does Deepgram take our key? Two looks that cost nothing (no audio is sent,
 * and Deepgram bills streaming by the second of audio):
 *
 *   - `checkDeepgramKey`: its management API (GET /v1/projects), with the key.
 *     200: taken; 401: refused; 402: the account cannot pay; 403: a key that
 *     may not read projects (no verdict: the socket look decides). Then, where
 *     the key may read it, the first project's balance (a number to show, never
 *     a verdict: an invoiced account has none).
 *   - `checkDeepgramStream`: a streaming socket opened with the key and closed
 *     at once (CloseStream), proving the key may stream (a key with
 *     management rights only would pass the first look).
 *
 * The REST address is the streaming one's host (a test's fake answers both).
 * The key goes in a header or the socket's subprotocol, never a URL or a log.
 */
import type { DeepgramVerdict } from './health.ts'
import type { SocketFactory } from './deepgram.ts'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Deepgram's REST base for a streaming address: wss://api.deepgram.com/v1/listen → https://api.deepgram.com. */
export function restBase(streamUrl: string): string {
  const u = new URL(streamUrl)
  const protocol = u.protocol === 'ws:' ? 'http:' : 'https:'
  return `${protocol}//${u.host}`
}

export interface KeyCheck {
  verdict: DeepgramVerdict
  status: number
  /** The first project's balance, where the key may read it. */
  balance: { amount: number; units: string } | null
}

/** The verdict a REST status gives. */
export function verdictOfStatus(status: number): DeepgramVerdict {
  if (status >= 200 && status < 300) return 'ok'
  // 403 is a key that may not read projects (a streaming-only key): no verdict on streaming.
  if (status === 401) return 'refused'
  if (status === 402) return 'no_credit'
  if (status === 0) return 'unreachable'
  return 'unknown'
}

export async function checkDeepgramKey(opts: { streamUrl: string; key: string; fetch?: Fetch; timeoutMs?: number }): Promise<KeyCheck> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const base = restBase(opts.streamUrl)
  const headers = { authorization: `Token ${opts.key}` }
  const timeout = opts.timeoutMs ?? 8_000
  let res: Response
  try {
    res = await doFetch(`${base}/v1/projects`, { headers, signal: AbortSignal.timeout(timeout) })
  } catch {
    return { verdict: 'unreachable', status: 0, balance: null }
  }
  const verdict = verdictOfStatus(res.status)
  const body = (await res.json().catch(() => null)) as { projects?: Array<{ project_id?: unknown }> } | null
  if (verdict !== 'ok') return { verdict, status: res.status, balance: null }
  const projectId = body?.projects?.[0]?.project_id
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(projectId)) return { verdict, status: res.status, balance: null }
  try {
    const b = await doFetch(`${base}/v1/projects/${projectId}/balances`, { headers, signal: AbortSignal.timeout(timeout) })
    const json = (await b.json().catch(() => null)) as { balances?: Array<{ amount?: unknown; units?: unknown }> } | null
    const first = b.ok ? json?.balances?.[0] : undefined
    const balance = first && typeof first.amount === 'number' ? { amount: first.amount, units: typeof first.units === 'string' ? first.units : '' } : null
    return { verdict, status: res.status, balance }
  } catch {
    return { verdict, status: res.status, balance: null }
  }
}

/** A streaming socket opened with the key and closed before any audio: 'open', or why not. */
export function checkDeepgramStream(opts: { url: string; key: string; socket?: SocketFactory; timeoutMs?: number }): Promise<'open' | 'closed' | 'timeout'> {
  const factory = opts.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as ReturnType<SocketFactory>)
  return new Promise((resolve) => {
    let done = false
    const socket = factory(opts.url, ['token', opts.key])
    const finish = (out: 'open' | 'closed' | 'timeout') => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      try {
        socket.close(1000, 'check')
      } catch {
        // gone already
      }
      resolve(out)
    }
    const timer = setTimeout(() => finish('timeout'), opts.timeoutMs ?? 8_000)
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        // closing anyway
      }
      finish('open')
    }
    socket.onclose = () => finish('closed')
    socket.onerror = () => undefined
  })
}
