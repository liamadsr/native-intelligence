/**
 * The review tools (roadmap D3): set_review_link saves a Google link (owners
 * and admins), complete_job sends the job-done event the review request
 * follows, and only a person's own turn says a job is done.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryDb } from '@/test/outreach-memory-db'

const hoisted = vi.hoisted(() => ({ emitJobCompleted: vi.fn() }))
vi.mock('@/lib/jobs/events', () => ({ emitJobCompleted: hoisted.emitJobCompleted }))

const { createReviewTools } = await import('@/lib/ai/tools/reviews')

const LINK = 'https://g.page/r/CQ3xBrightWeave/review'

function world(settings: Record<string, unknown> = {}) {
  return memoryDb(
    {
      workspace: [{ id: 'ws-1', name: 'Bright Weave', settings }],
      member: [
        { id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1', display_name: 'Sam', role: 'owner' },
        { id: 'mem-2', workspace_id: 'ws-1', user_id: 'user-2', display_name: 'Lee', role: 'member' },
      ],
      contact: [{ id: 'c-ana', workspace_id: 'ws-1', first_name: 'Ana', email: 'ana@example.com' }],
      actions: [{ id: 'act-7', workspace_id: 'ws-1', title: 'Wash the Ruiz rug' }],
      review_request: [],
    },
    { hidden: ['c-private'] },
  )
}

beforeEach(() => {
  hoisted.emitJobCompleted.mockReset()
  hoisted.emitJobCompleted.mockResolvedValue(undefined)
})

describe('set_review_link', () => {
  it('saves a Google link and refuses anything else', async () => {
    const db = world()
    const tools = createReviewTools('user-1', db.client, 'ws-1')
    expect(await tools.set_review_link.execute!({ url: 'https://evil.example/review' }, {} as never)).toMatchObject({ success: false, code: 'INVALID_LINK' })
    expect(await tools.set_review_link.execute!({ url: LINK }, {} as never)).toMatchObject({ success: true, review_link: LINK })
    expect((db.tables.workspace[0].settings as { review_link: { url: string } }).review_link.url).toBe(LINK)
  })
})

describe('complete_job', () => {
  it("sends the job-done event for the customer's job, today's when it has no id", async () => {
    const db = world({ review_link: { url: LINK, set_by: 'user-1', set_at: '2026-11-01T00:00:00Z' } })
    const res = await createReviewTools('user-1', db.client, 'ws-1').complete_job.execute!({ contact_id: 'c-ana' }, {} as never)
    expect(res).toMatchObject({ success: true, review_request: 'on_its_way', job: { type: 'manual' } })
    const data = hoisted.emitJobCompleted.mock.calls[0][0] as { workspaceId: string; contactId: string; jobRef: { type: string; id: string }; userId: string }
    expect(data).toMatchObject({ workspaceId: 'ws-1', contactId: 'c-ana', userId: 'user-1', reason: 'done', jobRef: { type: 'manual' } })
    expect(data.jobRef.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    await createReviewTools('user-1', db.client, 'ws-1').complete_job.execute!({ contact_id: 'c-ana', action_id: 'act-7' }, {} as never)
    expect((hoisted.emitJobCompleted.mock.calls[1][0] as { jobRef: unknown }).jobRef).toEqual({ type: 'action', id: 'act-7' })
  })

  it('takes only a real board action as the job, never an id the model made up', async () => {
    const db = world({ review_link: { url: LINK, set_by: 'user-1' } })
    const res = await createReviewTools('user-1', db.client, 'ws-1').complete_job.execute!({ contact_id: 'c-ana', action_id: 'act-invented' }, {} as never)
    expect(res).toMatchObject({ success: false, error: 'action_id is not an action in this workspace' })
    expect(hoisted.emitJobCompleted).not.toHaveBeenCalled()
  })

  it('is the owner\'s or an admin\'s to call (the email goes from the owner\'s mailbox)', async () => {
    const db = world({ review_link: { url: LINK, set_by: 'user-1' } })
    const res = await createReviewTools('user-2', db.client, 'ws-1').complete_job.execute!({ contact_id: 'c-ana' }, {} as never)
    expect(res).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(hoisted.emitJobCompleted).not.toHaveBeenCalled()
  })

  it('says when no review link is set, and when this job was already asked about', async () => {
    const noLink = world()
    expect(await createReviewTools('user-1', noLink.client, 'ws-1').complete_job.execute!({ contact_id: 'c-ana' }, {} as never)).toMatchObject({ review_request: 'no_review_link' })

    const asked = world({ review_link: { url: LINK, set_by: 'user-1' } })
    asked.tables.review_request.push({ id: 'rr-1', workspace_id: 'ws-1', contact_id: 'c-ana', job_type: 'action', job_id: 'act-7', status: 'sent' })
    expect(await createReviewTools('user-1', asked.client, 'ws-1').complete_job.execute!({ contact_id: 'c-ana', action_id: 'act-7' }, {} as never)).toMatchObject({ review_request: 'already_asked' })
  })

  it('only a person says a job is done, and only for a contact they can see', async () => {
    const db = world({ review_link: { url: LINK, set_by: 'user-1' } })
    expect(await createReviewTools('user-1', db.client, 'ws-1', false, { unattended: true }).complete_job.execute!({ contact_id: 'c-ana' }, {} as never)).toMatchObject({ code: 'NEEDS_PERSON' })
    db.tables.contact.push({ id: 'c-private', workspace_id: 'ws-1', email: 'p@example.com' })
    expect(await createReviewTools('user-1', db.client, 'ws-1').complete_job.execute!({ contact_id: 'c-private' }, {} as never)).toMatchObject({ success: false, error: 'Contact not found' })
    expect(hoisted.emitJobCompleted).not.toHaveBeenCalled()
  })
})
