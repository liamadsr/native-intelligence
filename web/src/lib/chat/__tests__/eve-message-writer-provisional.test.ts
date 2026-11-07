import { describe, it, expect } from 'vitest'
import { persistEveMessage, EVE_PROVISIONAL_METADATA_KEY, EVE_WRITTEN_METADATA_KEY } from '../eve-message-writer'
import { chatMessagesFake } from '@/test/chat-messages-fake'

/**
 * The reply backup's provisional rows (eve-message-writer.ts "Provisional
 * rows"): the server writes its own copy of each reply, and when the page is
 * alive the browser's copy is the one kept, whichever lands first.
 *   - a provisional write is stamped eve_provisional;
 *   - the browser's write replaces a provisional row (and clears the mark);
 *   - a later provisional write (a parked reply's answer) replaces the earlier;
 *   - nothing replaces the browser's copy (a late server write is a no-op);
 *   - a user message is never replaced;
 *   - only the insert fires the knowledge hook (conversationActivityFired).
 */

const CONV = { id: 'conv-1', user_id: 'u-1', workspace_id: 'ws-1' }
const tenancy = { conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1' }
const text = (t: string) => [{ type: 'text', text: t }]

function rowOf(db: ReturnType<typeof chatMessagesFake>, id: string) {
  return db.messages.find((m) => m.ui_message.id === id)
}

describe('persistEveMessage — provisional rows', () => {
  it('stamps a provisional write and fires the knowledge hook on its insert', async () => {
    const db = chatMessagesFake([CONV])
    const res = await persistEveMessage(db.client, { ...tenancy, parts: text('server copy'), messageId: 'r-1', provisional: true })
    expect(res).toMatchObject({ written: true, conversationActivityFired: true })
    expect(res.replaced).toBeUndefined()
    const meta = rowOf(db, 'r-1')!.ui_message.metadata!
    expect(meta[EVE_PROVISIONAL_METADATA_KEY]).toBe(true)
    expect(meta[EVE_WRITTEN_METADATA_KEY]).toBe(true)
  })

  it("the browser's write replaces the server's provisional row and makes it final", async () => {
    const db = chatMessagesFake([CONV])
    await persistEveMessage(db.client, { ...tenancy, parts: text('server copy'), messageId: 'r-1', provisional: true })
    const res = await persistEveMessage(db.client, { ...tenancy, parts: text('browser copy'), messageId: 'r-1', metadata: { stopped: true } })
    expect(res).toMatchObject({ written: false, replaced: true, conversationActivityFired: false })
    expect(db.messages).toHaveLength(1)
    const row = rowOf(db, 'r-1')!
    expect(row.ui_message.parts).toEqual(text('browser copy'))
    expect(row.ui_message.metadata![EVE_PROVISIONAL_METADATA_KEY]).toBeUndefined()
    expect(row.ui_message.metadata!.stopped).toBe(true)
  })

  it('a later server write replaces its own provisional row (a parked reply, then its answer)', async () => {
    const db = chatMessagesFake([CONV])
    await persistEveMessage(db.client, { ...tenancy, parts: text('asked'), messageId: 'r-1', provisional: true })
    const res = await persistEveMessage(db.client, { ...tenancy, parts: text('asked, then answered'), messageId: 'r-1', provisional: true })
    expect(res).toMatchObject({ written: false, replaced: true })
    expect(rowOf(db, 'r-1')!.ui_message.parts).toEqual(text('asked, then answered'))
    expect(rowOf(db, 'r-1')!.ui_message.metadata![EVE_PROVISIONAL_METADATA_KEY]).toBe(true)
  })

  it("nothing replaces the browser's copy: a server write after it is a no-op", async () => {
    const db = chatMessagesFake([CONV])
    await persistEveMessage(db.client, { ...tenancy, parts: text('browser copy'), messageId: 'r-1' })
    const res = await persistEveMessage(db.client, { ...tenancy, parts: text('server copy'), messageId: 'r-1', provisional: true })
    expect(res).toMatchObject({ written: false, conversationActivityFired: false })
    expect(res.replaced).toBeUndefined()
    expect(rowOf(db, 'r-1')!.ui_message.parts).toEqual(text('browser copy'))
  })

  it('a replayed browser write after the replace is a no-op too', async () => {
    const db = chatMessagesFake([CONV])
    await persistEveMessage(db.client, { ...tenancy, parts: text('server copy'), messageId: 'r-1', provisional: true })
    await persistEveMessage(db.client, { ...tenancy, parts: text('browser copy'), messageId: 'r-1' })
    const again = await persistEveMessage(db.client, { ...tenancy, parts: text('browser copy'), messageId: 'r-1' })
    expect(again).toMatchObject({ written: false, conversationActivityFired: false })
    expect(again.replaced).toBeUndefined()
  })

  it('never replaces a user message', async () => {
    const db = chatMessagesFake([CONV])
    await persistEveMessage(db.client, { ...tenancy, role: 'user', parts: text('hi'), messageId: 'u-msg' })
    const res = await persistEveMessage(db.client, { ...tenancy, role: 'user', parts: text('edited'), messageId: 'u-msg' })
    expect(res.written).toBe(false)
    expect(res.replaced).toBeUndefined()
    expect(rowOf(db, 'u-msg')!.ui_message.parts).toEqual(text('hi'))
  })
})
