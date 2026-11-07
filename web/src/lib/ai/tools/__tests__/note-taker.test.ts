/**
 * tell_note_taker — the meeting chat's line to the live note-taker (live-agent
 * messaging L2). Pins: it writes a `talk_back` directive for the caller on the
 * capture, through the service role; only the capture's owner, only until the
 * end-of-meeting pass; never on an unattended run; the text rules and cap are
 * the directive store's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import {
  CAP,
  OTHER,
  OWNER,
  WS,
  directiveDb,
  liveCapture,
  type DirectiveDb,
} from '@/lib/live-agent/__tests__/helpers/directive-db'

const hoisted = vi.hoisted(() => ({ service: { current: null as unknown } }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service.current }))

import { createNoteTakerTools } from '../note-taker'

const EXEC_OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

let db: DirectiveDb
function run(args: { capture_id?: string; text: string }, opts: { userId?: string; unattended?: boolean } = {}) {
  const tools = createNoteTakerTools(opts.userId ?? OWNER, db.client, WS, opts.unattended ?? false)
  return tools.tell_note_taker.execute!({ capture_id: args.capture_id ?? CAP, text: args.text }, EXEC_OPTS) as unknown as Promise<
    Record<string, unknown>
  >
}

beforeEach(() => {
  db = directiveDb({ captures: [liveCapture()] })
  hoisted.service.current = db.client
})

describe('tell_note_taker', () => {
  it('writes the ask as the user’s talk-back directive on the capture', async () => {
    const out = await run({ text: ' Dana owns the budget ' })
    expect(out).toMatchObject({ success: true, directive_id: 'dir-1' })
    expect(db.tables.live_directive).toEqual([
      expect.objectContaining({
        capture_id: CAP,
        workspace_id: WS,
        created_by: OWNER,
        source: 'talk_back',
        text: 'Dana owns the budget',
        status: 'pending',
      }),
    ])
  })

  it('refuses on an unattended run, before reading anything', async () => {
    const out = await run({ text: 'x' }, { unattended: true })
    expect(out.success).toBe(false)
    expect(db.tables.live_directive).toHaveLength(0)
  })

  it('refuses a capture the caller does not own', async () => {
    const out = await run({ text: 'x' }, { userId: OTHER })
    expect(out).toMatchObject({ success: false, error: 'Not the capture owner' })
    expect(db.tables.live_directive).toHaveLength(0)
  })

  it('refuses an unknown capture id the same way (no probing)', async () => {
    const out = await run({ capture_id: 'cap-nope', text: 'x' })
    expect(out).toMatchObject({ success: false, error: 'Not the capture owner' })
  })

  it('refuses once the meeting’s notes are written', async () => {
    db = directiveDb({ captures: [liveCapture({ batch_processed_at: '2026-09-29T20:00:00Z' })] })
    hoisted.service.current = db.client
    const out = await run({ text: 'x' })
    expect(out.success).toBe(false)
    expect(db.tables.live_directive).toHaveLength(0)
  })

  it('refuses blank and over-long text', async () => {
    expect((await run({ text: '   ' })).success).toBe(false)
    expect((await run({ text: 'x'.repeat(501) })).success).toBe(false)
    expect(db.tables.live_directive).toHaveLength(0)
  })
})
