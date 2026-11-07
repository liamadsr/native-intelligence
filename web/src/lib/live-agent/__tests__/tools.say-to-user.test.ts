/**
 * Telemetry tests for the live-agent `say_to_user` tool.
 *
 * REGRESSION THIS GUARDS: the drop event fired behind an AND-gate
 * (`!delivered && !chatWrite.written`), so the EXACT production symptom —
 * the chat shows the heads-up but the floating HUD stays blank (broadcast
 * dropped, chat write fine) — never once fired `live_agent_nudge_drop` in
 * PostHog. Because chat is the authoritative surface and almost always
 * succeeds, the event read as zero while HUD delivery was silently failing
 * in the field. The fix fires whenever the BROADCAST is undelivered and
 * carries `chat_written` so dashboards separate HUD-only loss from total loss.
 *
 * These run the real `say_to_user` execute() with broadcastNudge /
 * appendAgentMessage / trackServerEvent mocked so we assert exactly when the
 * event fires and with what properties.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

const { mockBroadcast, mockAppend, mockTrack } = vi.hoisted(() => ({
  // Typed to the widened boolean shape so tests can resolve either
  // { written: true } or { written: false } without a const-narrowing clash.
  mockBroadcast: vi.fn<(nudge: { id: string; message: string; kind: string }) => Promise<boolean>>(async () => true),
  mockAppend: vi.fn<(sb: unknown, opts: Record<string, unknown>) => Promise<{ written: boolean }>>(async () => ({ written: true })),
  mockTrack: vi.fn(),
}))

vi.mock('@/lib/live-agent/nudge-channel', () => ({
  broadcastNudge: mockBroadcast,
}))
vi.mock('@/lib/live-agent/conversation-writer', () => ({
  appendAgentMessage: mockAppend,
  hasPendingLiveQuestion: vi.fn(async () => false),
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: mockTrack }))
// say_to_user never touches these, but createLiveAgentTools imports them at
// module load — stub so the import graph resolves without real deps.
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn() }))
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  updateAppliedEntity: vi.fn(),
  deleteAppliedEntity: vi.fn(),
}))
vi.mock('@/lib/mcp-client/adapter', () => ({
  namespacedToolName: (s: string, t: string) => `mcp__${s}__${t}`,
}))

import { createLiveAgentTools } from '../tools'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const CAPTURE_ID = 'cap-1'
const EXEC_OPTS = { toolCallId: 'tc-1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

// say_to_user makes no DB calls of its own; a no-op supabase stub suffices.
const supabase = {} as never

function tools() {
  return createLiveAgentTools(USER_ID, supabase, WORKSPACE_ID, CAPTURE_ID, null, null, null, null, null)
}

beforeEach(() => {
  mockBroadcast.mockReset().mockResolvedValue(true)
  mockAppend.mockReset().mockResolvedValue({ written: true })
  mockTrack.mockReset()
})

describe('say_to_user — nudge-drop telemetry', () => {
  it('fires live_agent_nudge_drop with chat_written:true when the broadcast is undelivered but chat succeeded', async () => {
    // The invisible regression: HUD-only loss. Broadcast dropped, chat fine.
    mockBroadcast.mockResolvedValue(false)
    mockAppend.mockResolvedValue({ written: true })

    const res = (await tools().say_to_user.execute!(
      { message: 'Heads up: the deadline moved', kind: 'reminder' },
      EXEC_OPTS,
    )) as { delivered: boolean }

    // Chat carried it, so the tool still reports delivered.
    expect(res.delivered).toBe(true)
    expect(mockTrack).toHaveBeenCalledTimes(1)
    const [event, ctx, props] = mockTrack.mock.calls[0]
    expect(event).toBe('live_agent_nudge_drop')
    expect(ctx).toMatchObject({ userId: USER_ID, workspaceId: WORKSPACE_ID })
    expect(props).toMatchObject({
      capture_id: CAPTURE_ID,
      stage: 'cloud_tool',
      kind: 'reminder',
      chat_written: true,
    })
  })

  it('fires with chat_written:false when BOTH surfaces fail (total loss)', async () => {
    mockBroadcast.mockResolvedValue(false)
    mockAppend.mockResolvedValue({ written: false })

    const res = (await tools().say_to_user.execute!(
      { message: 'Nobody will see this' },
      EXEC_OPTS,
    )) as { delivered: boolean }

    expect(res.delivered).toBe(false)
    expect(mockTrack).toHaveBeenCalledTimes(1)
    expect(mockTrack.mock.calls[0][2]).toMatchObject({ chat_written: false })
  })

  it('does NOT fire when the broadcast is delivered', async () => {
    mockBroadcast.mockResolvedValue(true)
    mockAppend.mockResolvedValue({ written: true })

    await tools().say_to_user.execute!({ message: 'HUD got it' }, EXEC_OPTS)

    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('does NOT fire on a delivered broadcast even when the chat write failed', async () => {
    // Broadcast is the signal — if the HUD got it, there is no drop to report,
    // regardless of the chat surface.
    mockBroadcast.mockResolvedValue(true)
    mockAppend.mockResolvedValue({ written: false })

    await tools().say_to_user.execute!({ message: 'HUD only' }, EXEC_OPTS)

    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('defaults kind to insight in the drop event when unspecified', async () => {
    mockBroadcast.mockResolvedValue(false)
    mockAppend.mockResolvedValue({ written: true })

    await tools().say_to_user.execute!({ message: 'No kind given' }, EXEC_OPTS)

    expect(mockTrack.mock.calls[0][2]).toMatchObject({ kind: 'insight' })
  })
})

describe('say_to_user — one id for the broadcast and the row', () => {
  it('passes the broadcast id as the row id (ui_message.id → ui_message_id) and returns it', async () => {
    const res = (await tools().say_to_user.execute!(
      { message: 'Ask about the budget.', kind: 'suggestion' },
      EXEC_OPTS,
    )) as { delivered: boolean; id: string }

    expect(mockAppend).toHaveBeenCalledTimes(1)
    expect(mockBroadcast).toHaveBeenCalledTimes(1)
    const rowOpts = mockAppend.mock.calls[0][1]
    const nudge = mockBroadcast.mock.calls[0][0]
    expect(nudge.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rowOpts.messageId).toBe(nudge.id)
    expect(res.id).toBe(nudge.id)
    expect(rowOpts.metadata).toEqual({ kind: 'say_to_user', nudge_kind: 'suggestion' })
  })

  it('writes the row unthrottled: no throttle option, and every call gets its own id', async () => {
    await tools().say_to_user.execute!({ message: 'First.' }, EXEC_OPTS)
    await tools().say_to_user.execute!({ message: 'Second, a second later.' }, EXEC_OPTS)
    expect(mockAppend).toHaveBeenCalledTimes(2)
    for (const [, opts] of mockAppend.mock.calls) expect(opts).not.toHaveProperty('throttleKind')
    const [a, b] = mockAppend.mock.calls.map(([, opts]) => opts.messageId)
    expect(a).not.toBe(b)
    expect(mockBroadcast.mock.calls.map(([n]) => n.id)).toEqual([a, b])
  })
})
