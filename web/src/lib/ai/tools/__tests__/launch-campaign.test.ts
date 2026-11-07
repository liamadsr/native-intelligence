/**
 * The campaign tools that send (roadmap D2): create_campaign's win_back
 * recipe sets up the campaign and its draft emails in one call (nothing
 * sends), launch_campaign raises the owner's card and, on its yes, enrolls
 * and launches, and list_campaigns reports the counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryDb } from '@/test/outreach-memory-db'
import type { OutreachApprovalContext } from '@/lib/safety/approved-call'

const hoisted = vi.hoisted(() => ({ createToolApproval: vi.fn(), service: null as unknown }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: hoisted.createToolApproval }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

const { createCampaignTools } = await import('@/lib/ai/tools/campaigns')

function world() {
  const db = memoryDb(
    {
      workspace: [{ id: 'ws-1', name: 'Bright Weave', settings: {} }],
      campaign: [],
      sequence: [],
      sequence_step: [],
      connected_account: [{ id: 'acct-1', user_id: 'user-1', capability: 'email', is_enabled: true, is_primary: true, account_email: 'owner@brightweave.com', display_name: 'Gmail' }],
      member: [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1', display_name: null, role: 'owner' }],
      contact: [
        { id: 'c-ana', workspace_id: 'ws-1', full_name: 'Ana Ruiz', first_name: 'Ana', email: 'ana@example.com', relationship_type: 'customer', last_interaction_at: '2025-12-01T00:00:00Z', merged_into_contact_id: null, tags: [] },
        { id: 'c-ben', workspace_id: 'ws-1', full_name: 'Ben Okafor', first_name: 'Ben', email: 'ben@example.com', relationship_type: 'customer', last_interaction_at: new Date().toISOString(), merged_into_contact_id: null, tags: [] },
      ],
      sequence_enrollment: [],
      outreach_suppression: [],
    },
    {
      unique: { sequence_enrollment: [['sequence_id', 'contact_id']] },
      defaults: {
        sequence: { sending_account_id: null, auto_send: false },
        sequence_step: { is_active: true },
        sequence_enrollment: { current_step_order: 0, overrides: null, thread_subject: null, provider_thread_id: null, exit_reason: null },
        campaign: { stats: {}, launched_at: null, launched_by: null },
      },
    },
  )
  hoisted.service = db.client
  return db
}

const tools = (db: ReturnType<typeof world>, ctx: Parameters<typeof createCampaignTools>[5] = {}) =>
  createCampaignTools(db.client, 'ws-1', 'user-1', false, 'session', ctx)

beforeEach(() => {
  hoisted.createToolApproval.mockReset()
  hoisted.createToolApproval.mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

describe('create_campaign { recipe: win_back }', () => {
  it('saves the campaign, its audience and a draft sequence of two emails, and sends nothing', async () => {
    const db = world()
    const res = (await tools(db).create_campaign.execute!({ recipe: 'win_back' }, {} as never)) as Record<string, unknown>
    expect(res).toMatchObject({ success: true, audience_text: 'Customers last in touch more than 6 months ago' })
    const [campaign] = db.tables.campaign
    expect(campaign).toMatchObject({
      name: 'Win-back',
      recipe: 'win_back',
      rolling: true,
      status: 'planned',
      channels: ['email'],
      audience: { relationship_types: ['customer'], last_contacted_more_than_days: 180 },
    })
    const [sequence] = db.tables.sequence
    expect(sequence).toMatchObject({ status: 'draft', workspace_id: 'ws-1' })
    expect(campaign.sequence_id).toBe(sequence.id)
    expect(db.tables.sequence_step.map((s) => s.step_order)).toEqual([1, 2])
    // The sender has no name: the emails sign off as the business.
    expect(String(db.tables.sequence_step[0].body)).toContain('{{sender_name|Bright Weave}}')
    expect(db.tables.sequence_enrollment).toEqual([])
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('refuses a sequence from outside the workspace', async () => {
    const db = world()
    db.tables.sequence.push({ id: 'seq-x', workspace_id: 'ws-2', name: 'Theirs' })
    const res = await tools(db).create_campaign.execute!({ name: 'Mine', sequence_id: 'seq-x' }, {} as never)
    expect(res).toMatchObject({ success: false, error: 'sequence_id is not a sequence in this workspace' })
  })
})

describe('launch_campaign', () => {
  it('raises the card, then on its yes enrolls the quiet customer and launches; list_campaigns counts it', async () => {
    const db = world()
    await tools(db).create_campaign.execute!({ recipe: 'win_back' }, {} as never)
    const campaignId = db.tables.campaign[0].id as string

    const asked = (await tools(db, { conversationId: 'conv-1', approvalContext: { surface: 'sms' } }).launch_campaign.execute!({ campaign_id: campaignId }, {} as never)) as Record<string, unknown>
    expect(asked).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(db.tables.sequence_enrollment).toEqual([])
    const call = hoisted.createToolApproval.mock.calls[0][1] as { conversationId: string; context: { surface: string; outreach: OutreachApprovalContext }; input: Record<string, unknown> }
    expect(call.conversationId).toBe('conv-1')
    expect(call.context.surface).toBe('sms')
    expect(call.input.recipients).toBe('Ana Ruiz <ana@example.com>')

    const done = (await tools(db, { approvedCall: { approvalId: 'appr-1', tool: 'launch_campaign', outreach: call.context.outreach } }).launch_campaign.execute!(
      { campaign_id: campaignId },
      {} as never,
    )) as Record<string, unknown>
    expect(done).toMatchObject({ success: true, launched: true, enrolled: 1, armed_enrollments: 1 })
    expect(db.tables.sequence_enrollment.map((e) => e.contact_id)).toEqual(['c-ana'])
    expect(db.tables.campaign[0]).toMatchObject({ status: 'active', launched_by: 'user-1' })

    // The engine sent step 1 and Ana replied.
    Object.assign(db.tables.sequence_enrollment[0], { current_step_order: 1, status: 'exited', exit_reason: 'replied' })
    const listed = (await tools(db).list_campaigns.execute!({ limit: 50 }, {} as never)) as { campaigns: Array<Record<string, unknown>> }
    expect(listed.campaigns[0]).toMatchObject({
      counts: { recipients: 1, sent: 1, replied: 1, opted_out: 0, active: 0 },
      counts_text: '1 sent · 1 replied · 0 opted out',
      audience_text: 'Customers last in touch more than 6 months ago',
    })
  })

  it('tells the agent who was left out when nobody can be sent to, and raises no card', async () => {
    const db = world()
    await tools(db).create_campaign.execute!({ recipe: 'win_back' }, {} as never)
    db.tables.outreach_suppression.push({ id: 's1', workspace_id: 'ws-1', email: 'ana@example.com' })
    const res = await tools(db).launch_campaign.execute!({ campaign_id: db.tables.campaign[0].id as string }, {} as never)
    expect(res).toMatchObject({ success: false, code: 'NO_RECIPIENTS' })
    expect(String((res as { error: string }).error)).toContain('1 opted out')
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('refuses with nobody there to say yes', async () => {
    const db = world()
    await tools(db).create_campaign.execute!({ recipe: 'win_back' }, {} as never)
    const res = await tools(db, { unattended: true }).launch_campaign.execute!({ campaign_id: db.tables.campaign[0].id as string }, {} as never)
    expect(res).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
  })
})
