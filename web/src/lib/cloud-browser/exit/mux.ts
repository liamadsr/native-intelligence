/**
 * The Mac exit tunnel's frames, mux v1 (docs/plans/cloud-browser.md, C4). The
 * desktop's side is desktop/`src-tauri/crates/browser-exit/src/mux.rs`;
 * the two must agree byte for byte (both tests hold the same vectors).
 *
 * After the text handshake (exit.ts), every WebSocket message is one binary
 * frame: `type: u8`, `stream: u32` (big-endian; 0 for the tunnel's own
 * frames), then the payload.
 *
 *   1 OPEN    hub → Mac  port: u16 + host (UTF-8, IPv6 unbracketed)
 *   2 OPENED  Mac → hub  —
 *   3 REFUSED Mac → hub  reason: u8 (Refusal)
 *   4 DATA    both       bytes, at most MAX_DATA
 *   5 CREDIT  both       bytes: u32, that many more may be sent
 *   6 FIN     both       — (no more data this way)
 *   7 RESET   both       — (the stream is gone)
 *   8 PING    both       nonce: u64
 *   9 PONG    both       the PING's nonce
 *
 * Each side may have at most WINDOW bytes of a stream's DATA unanswered by
 * CREDIT, so one stalled stream never blocks the others.
 */

export const MUX_VERSION = 1
export const WINDOW = 512 * 1024
export const MAX_DATA = 64 * 1024
export const MAX_STREAMS = 256

export const FRAME = { OPEN: 1, OPENED: 2, REFUSED: 3, DATA: 4, CREDIT: 5, FIN: 6, RESET: 7, PING: 8, PONG: 9 } as const

/** Why the Mac refused a stream. */
export const REFUSAL = { blocked: 1, dns: 2, connect: 3, port: 4, busy: 5 } as const
export type Refusal = keyof typeof REFUSAL

export type Frame =
  | { type: 'open'; stream: number; host: string; port: number }
  | { type: 'opened'; stream: number }
  | { type: 'refused'; stream: number; reason: Refusal }
  | { type: 'data'; stream: number; bytes: Uint8Array }
  | { type: 'credit'; stream: number; bytes: number }
  | { type: 'fin'; stream: number }
  | { type: 'reset'; stream: number }
  | { type: 'ping'; nonce: bigint }
  | { type: 'pong'; nonce: bigint }

function head(type: number, stream: number, extra: number): { out: Uint8Array; view: DataView } {
  const out = new Uint8Array(5 + extra)
  const view = new DataView(out.buffer)
  out[0] = type
  view.setUint32(1, stream)
  return { out, view }
}

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case 'open': {
      const host = new TextEncoder().encode(frame.host)
      const { out, view } = head(FRAME.OPEN, frame.stream, 2 + host.length)
      view.setUint16(5, frame.port)
      out.set(host, 7)
      return out
    }
    case 'opened': return head(FRAME.OPENED, frame.stream, 0).out
    case 'refused': {
      const { out } = head(FRAME.REFUSED, frame.stream, 1)
      out[5] = REFUSAL[frame.reason]
      return out
    }
    case 'data': {
      const { out } = head(FRAME.DATA, frame.stream, frame.bytes.length)
      out.set(frame.bytes, 5)
      return out
    }
    case 'credit': {
      const { out, view } = head(FRAME.CREDIT, frame.stream, 4)
      view.setUint32(5, frame.bytes)
      return out
    }
    case 'fin': return head(FRAME.FIN, frame.stream, 0).out
    case 'reset': return head(FRAME.RESET, frame.stream, 0).out
    case 'ping':
    case 'pong': {
      const { out, view } = head(frame.type === 'ping' ? FRAME.PING : FRAME.PONG, 0, 8)
      view.setBigUint64(5, frame.nonce)
      return out
    }
  }
}

const REFUSALS = Object.fromEntries(Object.entries(REFUSAL).map(([name, code]) => [code, name])) as Record<number, Refusal>

/** One frame, or null for anything malformed (the tunnel then closes). */
export function decodeFrame(raw: Uint8Array): Frame | null {
  if (raw.length < 5) return null
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const stream = view.getUint32(1)
  const body = raw.subarray(5)
  switch (raw[0]) {
    case FRAME.OPEN: {
      if (body.length < 3 || body.length > 2 + 255) return null
      let host: string
      try { host = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(2)) } catch { return null }
      return { type: 'open', stream, host, port: view.getUint16(5) }
    }
    case FRAME.OPENED: return body.length === 0 ? { type: 'opened', stream } : null
    case FRAME.REFUSED: return body.length === 1 && REFUSALS[body[0]] ? { type: 'refused', stream, reason: REFUSALS[body[0]] } : null
    case FRAME.DATA: return body.length <= MAX_DATA ? { type: 'data', stream, bytes: body } : null
    case FRAME.CREDIT: return body.length === 4 ? { type: 'credit', stream, bytes: view.getUint32(5) } : null
    case FRAME.FIN: return body.length === 0 ? { type: 'fin', stream } : null
    case FRAME.RESET: return body.length === 0 ? { type: 'reset', stream } : null
    case FRAME.PING:
    case FRAME.PONG:
      if (body.length !== 8 || stream !== 0) return null
      return { type: raw[0] === FRAME.PING ? 'ping' : 'pong', nonce: view.getBigUint64(5) }
    default: return null
  }
}
