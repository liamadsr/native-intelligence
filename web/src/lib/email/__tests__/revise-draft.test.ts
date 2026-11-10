/**
 * revise_email_draft's logic (bots v3 Phase 5): "make it more formal" rewrites
 * the draft ROW and the PROVIDER draft, never sends. The plan's test is
 * "revise_email_draft updates both the row and the provider draft".
 *
 *  - a drafting pass's row: the mailbox draft is rewritten first
 *    (updateProviderDraft), then the row follows (body, html, subject,
 *    recipients, and Gmail's new message id);
 *  - the mailbox draft changed or gone since: nothing is written, the row
 *    included;
 *  - an agent's draft named by its mailbox id: rewritten when the caller's own
 *    thread index lists it as a draft in this workspace, else not found;
 *  - a sent or dismissed draft, or someone else's, is refused;
 *  - a row whose mailbox copy was never saved is revised in Native Intelligence only;
 *  - Gmail's new message id: the caller's work items and runs that delivered
 *    the old id follow it, so sending the revised draft still settles them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const updateProviderDraft = vi.fn()
vi.mock('@/lib/integrations/email', () => ({
  updateProviderDraft: (...args: unknown[]) => updateProviderDraft(...args),
}))

import { reviseEmailDraft } from '../revise-draft'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'

const WS = 'a2000000-0000-4000-8000-000000000001'
const ROW = 'd2000000-0000-4000-8000-000000000001'
const SENT_ROW = 'd2000000-0000-4000-8000-000000000002'
const ANAS_ROW = 'd2000000-0000-4000-8000-000000000003'
const LOCAL_ROW = 'd2000000-0000-4000-8000-000000000004'

let fake: FakeSupabase
const row = (id: string) => fake.rows('email_draft').find((r) => r.id === id)!

beforeEach(() => {
  fake = makeFakeSupabase()
  updateProviderDraft.mockReset()
  updateProviderDraft.mockImplementation(async (_u, _w, threadId, _m, revision: { body: string; subject?: string }) => ({
    ok: true,
    threadId,
    messageId: 'm-new',
    edits: { to: ['simon@harborline.io'], cc: [], subject: revision.subject ?? 'Re: Exploratory Meeting', body: revision.body },
  }))
  fake.seed('email_draft', [
    { id: ROW, workspace_id: WS, user_id: 'user-1', status: 'pending_review', subject: 'Re: Exploratory Meeting', to_emails: ['simon@harborline.io'], cc_emails: [], provider_thread_id: 'thr-1', provider_draft_id: 'm-old', body_text: 'hey' },
    { id: SENT_ROW, workspace_id: WS, user_id: 'user-1', status: 'sent', subject: 'x', to_emails: ['a@b.co'], cc_emails: [], provider_thread_id: 'thr-2', provider_draft_id: 'm-sent' },
    { id: ANAS_ROW, workspace_id: WS, user_id: 'user-ana', status: 'pending_review', subject: 'x', to_emails: ['a@b.co'], cc_emails: [], provider_thread_id: 'thr-3', provider_draft_id: 'm-ana' },
    { id: LOCAL_ROW, workspace_id: WS, user_id: 'user-1', status: 'pending_review', subject: 'Re: Q', to_emails: ['q@b.co'], cc_emails: [], provider_thread_id: 'thr-4', provider_draft_id: null },
  ])
  fake.seed('email_thread_index', [
    { id: 'idx-1', workspace_id: WS, user_id: 'user-1', provider_thread_id: 'thr-9', provider_message_id: 'm-agent', is_draft: true },
  ])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('reviseEmailDraft', () => {
  it('rewrites the mailbox draft, then the row follows (body, html, subject, Gmail’s new id); never sends', async () => {
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: ROW, body: 'Dear Simon,\n\nThank you.', subject: 'Re: Our meeting' })
    expect(out).toMatchObject({ success: true, draft_row_id: ROW, draft_id: 'm-new', mailbox_updated: true, subject: 'Re: Our meeting' })
    expect(updateProviderDraft).toHaveBeenCalledWith('user-1', WS, 'thr-1', 'm-old', { body: 'Dear Simon,\n\nThank you.', subject: 'Re: Our meeting' })
    const r = row(ROW)
    expect(r.body_text).toBe('Dear Simon,\n\nThank you.')
    expect(String(r.body_html)).toContain('Thank you.')
    expect(r.subject).toBe('Re: Our meeting')
    expect(r.provider_draft_id).toBe('m-new')
    // Still waiting on the person: a revision is not a send.
    // The person's revision is their edit: a new message keeps it (stale), never re-drafts over it.
    expect(r.status).toBe('edited')
    expect(JSON.stringify(out)).toMatch(/Not sent/)
  })

  it('names the row by the mailbox draft it holds too', async () => {
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: 'm-old', body: 'Formal.' })
    expect(out).toMatchObject({ success: true, draft_row_id: ROW })
    expect(row(ROW).body_text).toBe('Formal.')
  })

  it('the mailbox draft changed or gone since: nothing is written, the row included', async () => {
    updateProviderDraft.mockResolvedValue({ ok: false, reason: 'not_found' })
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: ROW, body: 'Formal.' })
    expect(out).toMatchObject({ success: false, code: 'MAILBOX_CHANGED' })
    expect(row(ROW).body_text).toBe('hey')
    expect(row(ROW).provider_draft_id).toBe('m-old')
  })

  it('a mailbox draft a plain-text rewrite would strip is not revisable, and the row is left as it was', async () => {
    updateProviderDraft.mockResolvedValue({ ok: false, reason: 'rich' })
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: ROW, body: 'Formal.' })
    expect(out).toMatchObject({ success: false, code: 'NOT_REVISABLE' })
    expect(JSON.stringify(out)).toMatch(/attachments/)
    expect(row(ROW).body_text).toBe('hey')
  })

  it('a revision that isn’t a well-formed draft is refused, and nothing is written', async () => {
    updateProviderDraft.mockResolvedValue({ ok: false, reason: 'invalid' })
    expect(await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: ROW, body: 'x', to: ['not an address'] })).toMatchObject({ code: 'INVALID' })
    expect(row(ROW).body_text).toBe('hey')
  })

  it('an agent’s draft by its mailbox id: rewritten when the caller’s own index lists it here; else not found', async () => {
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: 'm-agent', body: 'Formal.' })
    expect(out).toMatchObject({ success: true, draft_row_id: null, draft_id: 'm-new' })
    expect(updateProviderDraft).toHaveBeenCalledWith('user-1', WS, 'thr-9', 'm-agent', { body: 'Formal.' })
    updateProviderDraft.mockClear()
    expect(await reviseEmailDraft(fake as never, 'user-2', WS, { draftId: 'm-agent', body: 'x' })).toMatchObject({ code: 'NOT_FOUND' })
    expect(updateProviderDraft).not.toHaveBeenCalled()
  })

  it('a sent draft is refused; someone else’s is not found; neither reaches the mailbox', async () => {
    expect(await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: SENT_ROW, body: 'x' })).toMatchObject({ code: 'NOT_REVISABLE' })
    expect(await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: ANAS_ROW, body: 'x' })).toMatchObject({ code: 'NOT_FOUND' })
    expect(await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: '../etc', body: 'x' })).toMatchObject({ code: 'NOT_FOUND' })
    expect(updateProviderDraft).not.toHaveBeenCalled()
    expect(row(ANAS_ROW).body_text).toBeUndefined()
  })

  it('a row with no mailbox copy is revised in Native Intelligence only, and says so', async () => {
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: LOCAL_ROW, body: 'Formal.' })
    expect(out).toMatchObject({ success: true, mailbox_updated: false, draft_id: null })
    expect(updateProviderDraft).not.toHaveBeenCalled()
    expect(row(LOCAL_ROW).body_text).toBe('Formal.')
  })

  it('Gmail’s new id: the caller’s work item and its run follow it, so sending the revised draft settles the item', async () => {
    fake.seed('member', [
      { id: 'mem-1', workspace_id: WS, user_id: 'user-1' },
      { id: 'mem-ana', workspace_id: WS, user_id: 'user-ana' },
    ])
    fake.seed('tracked_job', [
      { id: 'job-1', workspace_id: WS, member_id: 'mem-1', status: 'needs_review', agent_run_id: 'run-1', deliverables: [{ type: 'email_draft', id: 'm-agent', label: 'Reply to Simon' }] },
      // Someone else's item naming the same id is not the caller's to move.
      { id: 'job-ana', workspace_id: WS, member_id: 'mem-ana', status: 'needs_review', agent_run_id: null, deliverables: [{ type: 'email_draft', id: 'm-agent' }] },
    ])
    fake.seed('agent_run', [
      { id: 'run-1', workspace_id: WS, triggered_by: null, deliverables: [{ type: 'email_draft', id: 'm-agent', label: 'Reply to Simon' }] },
      { id: 'run-ana', workspace_id: WS, triggered_by: 'user-ana', deliverables: [{ type: 'email_draft', id: 'm-agent' }] },
    ])
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: 'm-agent', body: 'Formal.' })
    expect(out).toMatchObject({ success: true, draft_id: 'm-new' })

    const job = (id: string) => fake.rows('tracked_job').find((r) => r.id === id)!
    const run = (id: string) => fake.rows('agent_run').find((r) => r.id === id)!
    expect(job('job-1').deliverables).toEqual([{ type: 'email_draft', id: 'm-new', label: 'Reply to Simon' }])
    expect(run('run-1').deliverables).toEqual([{ type: 'email_draft', id: 'm-new', label: 'Reply to Simon' }])
    expect(job('job-ana').deliverables).toEqual([{ type: 'email_draft', id: 'm-agent' }])
    expect(run('run-ana').deliverables).toEqual([{ type: 'email_draft', id: 'm-agent' }])

    // The send path resolves by the draft's id now: the item completes.
    const resolved = await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'm-new' })
    expect(resolved.completed).toEqual(['job-1'])
    expect(job('job-1').status).toBe('done')
  })

  it('Outlook keeps the id: nothing is re-pointed', async () => {
    updateProviderDraft.mockImplementation(async (_u, _w, threadId, messageId: string, revision: { body: string }) => ({
      ok: true,
      threadId,
      messageId,
      edits: { to: ['simon@harborline.io'], cc: [], subject: 'Re: x', body: revision.body },
    }))
    fake.seed('member', [{ id: 'mem-1', workspace_id: WS, user_id: 'user-1' }])
    fake.seed('tracked_job', [
      { id: 'job-1', workspace_id: WS, member_id: 'mem-1', status: 'needs_review', agent_run_id: null, deliverables: [{ type: 'email_draft', id: 'm-agent' }] },
    ])
    const out = await reviseEmailDraft(fake as never, 'user-1', WS, { draftId: 'm-agent', body: 'Formal.' })
    expect(out).toMatchObject({ success: true, draft_id: 'm-agent' })
    expect(fake.rows('tracked_job')[0].deliverables).toEqual([{ type: 'email_draft', id: 'm-agent' }])
  })
})
