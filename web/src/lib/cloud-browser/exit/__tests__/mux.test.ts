/**
 * The tunnel's frames (src/lib/cloud-browser/exit/mux.ts): the same byte
 * vectors as the desktop's mux.rs, so a change on one side fails both.
 */
import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeFrame, FRAME, MAX_DATA, type Frame } from '../mux'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('mux v1 frames', () => {
  it('match the desktop’s bytes', () => {
    const cases: [Frame, string][] = [
      [{ type: 'open', stream: 7, host: 'example.com', port: 443 }, '010000000701bb6578616d706c652e636f6d'],
      [{ type: 'opened', stream: 7 }, '0200000007'],
      [{ type: 'refused', stream: 7, reason: 'blocked' }, '030000000701'],
      [{ type: 'data', stream: 1, bytes: new TextEncoder().encode('hi') }, '04000000016869'],
      [{ type: 'credit', stream: 1, bytes: 65536 }, '050000000100010000'],
      [{ type: 'fin', stream: 2 }, '0600000002'],
      [{ type: 'reset', stream: 2 }, '0700000002'],
      [{ type: 'ping', nonce: BigInt(42) }, '0800000000000000000000002a'],
      [{ type: 'pong', nonce: BigInt(42) }, '0900000000000000000000002a'],
    ]
    for (const [frame, bytes] of cases) {
      expect(hex(encodeFrame(frame))).toBe(bytes)
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
    }
  })

  it('refuses malformed frames', () => {
    expect(decodeFrame(new Uint8Array([]))).toBeNull()
    expect(decodeFrame(new Uint8Array([FRAME.OPEN, 0, 0, 0, 1]))).toBeNull()
    expect(decodeFrame(new Uint8Array([FRAME.REFUSED, 0, 0, 0, 1, 99]))).toBeNull()
    expect(decodeFrame(new Uint8Array([FRAME.PING, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]))).toBeNull()
    expect(decodeFrame(new Uint8Array([FRAME.OPENED, 0, 0, 0, 1, 0]))).toBeNull()
    expect(decodeFrame(new Uint8Array([42, 0, 0, 0, 1]))).toBeNull()
    expect(decodeFrame(new Uint8Array(5 + MAX_DATA + 1).fill(FRAME.DATA, 0, 1))).toBeNull()
  })
})
