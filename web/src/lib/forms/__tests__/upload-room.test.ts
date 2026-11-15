/**
 * The room for form uploads in flight (../upload-room.ts): taken by the
 * declared length, refused past the server's room or past a sender's
 * uploads at once, given back once however often release is called.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { FORM_UPLOAD_BODY_MAX } from '../body'
import { __resetUploadRoomForTests, FORM_UPLOAD_BYTES_IN_FLIGHT, FORM_UPLOADS_PER_SENDER, takeUploadRoom, uploadBytesInFlight } from '../upload-room'
import { FORM_FILE_LIMITS } from '../types'

beforeEach(() => __resetUploadRoomForTests())

describe('the room for uploads in flight', () => {
  it('is sized for a handful of uploads at their largest, with their sends, well inside the web container', () => {
    const atLargest = Math.floor(FORM_UPLOAD_BYTES_IN_FLIGHT / FORM_UPLOAD_BODY_MAX)
    expect(atLargest).toBeGreaterThanOrEqual(4)
    // Each upload holds its body once plus one file being sent: the worst the room allows stays under 1 GB of the 6.
    expect(atLargest * (FORM_UPLOAD_BODY_MAX + FORM_FILE_LIMITS.maxBytes)).toBeLessThan(1024 * 1024 * 1024)
    expect(FORM_UPLOAD_BYTES_IN_FLIGHT * 2).toBeLessThan(1024 * 1024 * 1024)
  })

  it('takes room by the bytes declared and gives it back once', () => {
    const a = takeUploadRoom(1000, 'sender-a')
    expect(a.ok).toBe(true)
    expect(uploadBytesInFlight()).toBe(1000)
    if (!a.ok) return
    a.release()
    a.release()
    expect(uploadBytesInFlight()).toBe(0)
  })

  it('past the room, an upload is refused as busy; another fits once room is given back', () => {
    const big = takeUploadRoom(FORM_UPLOAD_BYTES_IN_FLIGHT - 10, 'sender-a')
    expect(takeUploadRoom(11, 'sender-b')).toEqual({ ok: false, reason: 'busy' })
    expect(takeUploadRoom(10, 'sender-b').ok).toBe(true)
    if (big.ok) big.release()
    expect(takeUploadRoom(FORM_UPLOAD_BYTES_IN_FLIGHT / 2, 'sender-c').ok).toBe(true)
  })

  it(`one sender holds at most ${FORM_UPLOADS_PER_SENDER} at once; a sender the edge could not name counts in the total only`, () => {
    const mine = Array.from({ length: FORM_UPLOADS_PER_SENDER }, () => takeUploadRoom(10, 'sender-a'))
    expect(mine.every((r) => r.ok)).toBe(true)
    expect(takeUploadRoom(10, 'sender-a')).toEqual({ ok: false, reason: 'sender' })
    expect(takeUploadRoom(10, 'sender-b').ok).toBe(true)
    const first = mine[0]
    if (first.ok) first.release()
    expect(takeUploadRoom(10, 'sender-a').ok).toBe(true)
    for (let i = 0; i < 5; i++) expect(takeUploadRoom(10, null).ok).toBe(true)
  })
})
