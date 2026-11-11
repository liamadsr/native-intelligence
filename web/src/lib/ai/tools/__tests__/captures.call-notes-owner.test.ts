/**
 * A team call's notes and the agent's reads (migrations 566 and 568): the
 * owner of a call's notes reads them through the agent's tools only while
 * they may read the call's conversation (captures.notes_owner_out, kept by
 * the database); anyone the conversation's grant reaches still reads them;
 * every other capture of the owner is untouched.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { applyCaptureVisibility, isCaptureVisible } from '../_shared'

const OWNER = '11111111-1111-4111-8111-111111111111'
const READER = '22222222-2222-4222-8222-222222222222'
const NOTES_IN = '33333333-3333-4333-8333-333333333333'
const NOTES_OUT = '44444444-4444-4444-8444-444444444444'
const PLAIN = '55555555-5555-4555-8555-555555555555'

const rows = () => ({
  captures: [
    { id: NOTES_IN, user_id: OWNER, visibility: 'private', is_eval: false, notes_owner_out: false },
    { id: NOTES_OUT, user_id: OWNER, visibility: 'private', is_eval: false, notes_owner_out: true },
    { id: PLAIN, user_id: OWNER, visibility: 'private', is_eval: false, notes_owner_out: false },
  ],
})

async function ids(requester: string, granted?: string[]): Promise<string[]> {
  const db = memoryDb(rows())
  const { data } = await applyCaptureVisibility(db.from('captures').select('id'), requester, undefined, granted)
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort()
}

describe("a call's notes in the agent's reads", () => {
  it('the owner who left the conversation no longer reads those notes; their other captures stay', async () => {
    expect(await ids(OWNER)).toEqual([NOTES_IN, PLAIN].sort())
  })

  it("someone else is untouched by the owner's condition (only the conversation's grant opens private notes to them)", async () => {
    expect(await ids(READER)).toEqual([])
  })

  it('the row check agrees', () => {
    const [inside, out, plain] = rows().captures
    expect(isCaptureVisible(inside, OWNER)).toBe(true)
    expect(isCaptureVisible(out, OWNER)).toBe(false)
    expect(isCaptureVisible(plain, OWNER)).toBe(true)
    expect(isCaptureVisible(out, READER, undefined, new Set([NOTES_OUT]))).toBe(true)
  })
})
