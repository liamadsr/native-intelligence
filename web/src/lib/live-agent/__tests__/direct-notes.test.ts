/**
 * direct_notes — the paired copilot relays what the user asked it to note
 * (live-agent messaging L2). Pins: it writes a `copilot` directive for the
 * turn's user on this capture; a member who does not own the capture writes
 * nothing; closed after the end-of-meeting pass; an eval capture writes nothing
 * (its turns read no directives) but the call still succeeds.
 */
import { describe, it, expect } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createLiveAgentTools } from '../tools'
import { CAP, OTHER, OWNER, WS, directiveDb, liveCapture } from './helpers/directive-db'

const EXEC_OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

function relay(seed: Parameters<typeof directiveDb>[0], text: string, opts: { userId?: string; isEval?: boolean } = {}) {
  const db = directiveDb(seed)
  const tools = createLiveAgentTools(opts.userId ?? OWNER, db.client, WS, CAP, null, null, null, null, null, {
    isEvalCapture: opts.isEval,
  })
  const out = tools.direct_notes.execute!({ text }, EXEC_OPTS) as unknown as Promise<Record<string, unknown>>
  return { db, out }
}

describe('direct_notes', () => {
  it('writes the user’s ask as a copilot directive on this capture', async () => {
    const { db, out } = relay({ captures: [liveCapture()] }, 'Put the Friday deadline in the notes')
    expect(await out).toMatchObject({ success: true, directive_id: 'dir-1' })
    expect(db.tables.live_directive).toEqual([
      expect.objectContaining({
        capture_id: CAP,
        workspace_id: WS,
        created_by: OWNER,
        source: 'copilot',
        text: 'Put the Friday deadline in the notes',
      }),
    ])
  })

  it('a member who does not own the capture writes nothing', async () => {
    const { db, out } = relay({ captures: [liveCapture()] }, 'x', { userId: OTHER })
    expect(await out).toMatchObject({ success: false })
    expect(db.tables.live_directive).toHaveLength(0)
  })

  it('nothing after the end-of-meeting pass', async () => {
    const { db, out } = relay({ captures: [liveCapture({ batch_processed_at: '2026-09-29T20:00:00Z' })] }, 'x')
    expect(await out).toMatchObject({ success: false })
    expect(db.tables.live_directive).toHaveLength(0)
  })

  it('an eval capture: a success the trace records, and no row', async () => {
    const { db, out } = relay({ captures: [liveCapture()] }, 'x', { isEval: true })
    expect(await out).toMatchObject({ success: true, eval_suppressed: true })
    expect(db.tables.live_directive).toHaveLength(0)
  })

  it('caps the text at the column limit in its schema', () => {
    const tools = createLiveAgentTools(OWNER, directiveDb().client, WS, CAP, null, null)
    const schema = tools.direct_notes.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ text: 'x'.repeat(500) }).success).toBe(true)
    expect(schema.safeParse({ text: 'x'.repeat(501) }).success).toBe(false)
    expect(schema.safeParse({ text: '' }).success).toBe(false)
  })
})
