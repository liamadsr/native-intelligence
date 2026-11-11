/**
 * gatherDraftContext's recent meetings with the thread's participants.
 *
 * It read capture_participant ordered by a created_at the table never had
 * (it has joined_at), ignored the error, and so no reply draft ever drew on a
 * meeting. The double refuses that column the way PostgREST does. The read
 * runs on the service-role client, so the mailbox owner's capture visibility
 * is the fence: another member's private meeting stays out of the draft.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingDb } from '@/test/recording-db'
import { withTableSchema } from '@/test/table-schema'

const h = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.client }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: vi.fn() }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn(), checkUsageLimits: vi.fn() }))
vi.mock('@/lib/integrations/email', () => ({ createEmailDraft: vi.fn() }))
vi.mock('@/lib/email/email-read-service', () => ({ readEmailThread: vi.fn() }))

const { gatherDraftContext } = await import('../email-drafts')

const capture = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Meeting ${id}`,
  ai_summary: `Summary of ${id}.`,
  started_at: '2026-10-02T15:00:00Z',
  user_id: 'user-1',
  visibility: 'workspace',
  is_eval: false,
  notes_owner_out: false,
  cp: [{ external_email: 'avery@example.com' }],
  ...over,
})

let db: ReturnType<typeof recordingDb>

beforeEach(() => {
  db = recordingDb({
    captures: [
      capture('cap-3'),
      capture('cap-2', { user_id: 'user-1', visibility: 'private' }),
      capture('cap-other-private', { user_id: 'user-2', visibility: 'private' }),
      capture('cap-eval', { is_eval: true }),
      capture('cap-no-summary', { ai_summary: '' }),
    ],
  })
  h.client = withTableSchema({ ...db.client, rpc: async () => ({ data: [], error: null }) }, ['capture_participant', 'captures'])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('gatherDraftContext — recent captures with the participants', () => {
  it("brings the owner's visible meetings with a summary, and nothing else", async () => {
    const context = await gatherDraftContext('ws-1', 'user-1', { participant_emails: ['avery@example.com'] })
    expect(context.captures).toEqual([
      { id: 'cap-3', title: 'Meeting cap-3', ai_summary: 'Summary of cap-3.', started_at: '2026-10-02T15:00:00Z' },
      { id: 'cap-2', title: 'Meeting cap-2', ai_summary: 'Summary of cap-2.', started_at: '2026-10-02T15:00:00Z' },
    ])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('reads captures in the workspace joined to the participants, fenced to the owner, newest first', async () => {
    await gatherDraftContext('ws-1', 'user-1', { participant_emails: ['avery@example.com'] })
    const calls = db.calls.captures
    expect(calls).toContainEqual(['eq', 'workspace_id', 'ws-1'])
    expect(calls).toContainEqual(['in', 'cp.external_email', ['avery@example.com']])
    expect(calls).toContainEqual(['neq', 'is_eval', true])
    expect(calls).toContainEqual(['or', 'visibility.eq.workspace,user_id.eq.user-1'])
    expect(calls).toContainEqual(['order', 'started_at', { ascending: false, nullsFirst: false }])
    expect(calls).toContainEqual(['limit', 5])
    expect(db.calls.capture_participant).toBeUndefined()
  })
})
