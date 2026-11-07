/**
 * Campaigns that send (roadmap D2), end to end on an in-memory database:
 *
 *   - the audience (customers last in touch more than 180 days ago) matches
 *     only those customers, visible to the launcher, with an email, not
 *     merged away; the opt-out list, people already in the sequence and
 *     people in another sequence are left out and counted;
 *   - the card names exactly the eligible people; the yes enrolls and arms
 *     only the named ones who still qualify, and the campaign records the
 *     launch; an edit after the card sends nothing;
 *   - the counts (sent, replied, opted out) come from the enrollments;
 *   - a rolling campaign's weekly pass raises one card for newcomers, none
 *     while one waits, none when nobody is new.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryDb } from '@/test/outreach-memory-db'
import type { OutreachApprovalContext } from '@/lib/safety/approved-call'

const hoisted = vi.hoisted(() => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: hoisted.createToolApproval }))

const { prepareCampaignLaunch, executeCampaignLaunch, raiseCampaignCard, refreshRollingCampaign, loadCampaignForLaunch } = await import('../launch')
const { campaignCounts } = await import('../counts')

const NOW = Date.parse('2026-11-01T12:00:00Z')
const LAPSED = '2026-01-15T00:00:00Z'
const RECENT = '2026-10-20T00:00:00Z'

function contact(id: string, name: string, extra: Record<string, unknown> = {}) {
  const first = name.split(' ')[0]
  return {
    id,
    workspace_id: 'ws-1',
    full_name: name,
    first_name: first,
    last_name: name.split(' ')[1] ?? null,
    email: `${first.toLowerCase()}@example.com`,
    relationship_type: 'customer',
    last_interaction_at: LAPSED,
    merged_into_contact_id: null,
    tags: [],
    ...extra,
  }
}

function world(campaign: Record<string, unknown> = {}) {
  return memoryDb(
    {
      campaign: [
        {
          id: 'camp-1',
          workspace_id: 'ws-1',
          name: 'Win-back',
          status: 'planned',
          sequence_id: 'seq-1',
          audience: { relationship_types: ['customer'], last_contacted_more_than_days: 180 },
          rolling: true,
          stats: {},
          launched_at: null,
          launched_by: null,
          ...campaign,
        },
      ],
      sequence: [
        { id: 'seq-1', workspace_id: 'ws-1', name: 'Win-back', status: 'draft', timezone: 'America/Los_Angeles', delay_unit: 'business', send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 }, sending_account_id: null },
        { id: 'seq-other', workspace_id: 'ws-1', name: 'Spring', status: 'active', timezone: 'America/Los_Angeles', delay_unit: 'business', send_window: { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 }, sending_account_id: null },
      ],
      sequence_step: [
        { id: 'st-1', sequence_id: 'seq-1', step_order: 1, subject: 'Checking in, {{first_name|there}}', body: 'Hi {{first_name|there}}, it has been a while.', delay_days: 0, is_active: true },
        { id: 'st-2', sequence_id: 'seq-1', step_order: 2, subject: null, body: 'Just following up.', delay_days: 7, is_active: true },
      ],
      connected_account: [{ id: 'acct-1', user_id: 'user-1', capability: 'email', is_enabled: true, is_primary: true, account_email: 'owner@brightweave.com', display_name: 'Gmail' }],
      member: [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1', display_name: 'Sam Rivera', role: 'owner' }],
      contact: [
        contact('c-ana', 'Ana Ruiz'),
        contact('c-ben', 'Ben Okafor', { last_interaction_at: RECENT }), // seen recently
        contact('c-cal', 'Cal Diaz'), // in another active sequence
        contact('c-dee', 'Dee Park'), // opted out
        contact('c-eve', 'Eve Stone', { relationship_type: 'lead' }), // not a customer
        contact('c-fay', 'Fay Lund', { last_interaction_at: null }), // never in touch
        contact('c-gus', 'Gus Holm'), // another member's private contact
        contact('c-hal', 'Hal Ames', { merged_into_contact_id: 'c-ana' }), // merged away
        contact('c-ivy', 'Ivy Moss', { email: null }), // no email
        contact('c-jo', 'Jo Kim', { last_interaction_at: '2025-11-01T00:00:00Z' }), // quiet longest
        contact('c-other', 'Ola Ward', { workspace_id: 'ws-2' }), // another workspace
      ],
      sequence_enrollment: [
        { id: 'enr-cal', workspace_id: 'ws-1', sequence_id: 'seq-other', contact_id: 'c-cal', contact_email: 'cal@example.com', status: 'active', current_step_order: 1, next_send_at: '2026-11-03T17:00:00Z', exit_reason: null },
      ],
      outreach_suppression: [{ id: 'sup-1', workspace_id: 'ws-1', email: 'Dee@example.com' }],
    },
    {
      hidden: ['c-gus'],
      unique: { sequence_enrollment: [['sequence_id', 'contact_id']] },
      // 227's defaults: a fresh enrollment has sent nothing.
      defaults: { sequence_enrollment: { current_step_order: 0, overrides: null, thread_subject: null, provider_thread_id: null, exit_reason: null } },
    },
  )
}

async function campaignOf(db: ReturnType<typeof world>) {
  return (await loadCampaignForLaunch(db.client, { workspaceId: 'ws-1', campaignId: 'camp-1' }))!
}

beforeEach(() => {
  hoisted.createToolApproval.mockReset()
  hoisted.createToolApproval.mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

describe('prepareCampaignLaunch: who the audience reaches', () => {
  it('names only eligible customers quiet for 180+ days, longest-quiet first, and counts who was left out', async () => {
    const db = world()
    const prep = await prepareCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', now: NOW })
    if (!prep.ok) throw new Error(prep.error)
    expect(prep.recipients.map((r) => r.id)).toEqual(['c-jo', 'c-ana'])
    expect(prep.skipped).toEqual({ opted_out: 1, already_in_sequence: 0, in_another_sequence: 1 })
    expect(db.writes).toEqual([])
  })

  it('leaves out a customer an import tagged as unsubscribed from email (Brevo), counted as opted out', async () => {
    const db = world()
    db.tables.contact.find((c) => c.id === 'c-ana')!.tags = ['Unsubscribed Email']
    const prep = await prepareCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', now: NOW })
    if (!prep.ok) throw new Error(prep.error)
    expect(prep.recipients.map((r) => r.id)).toEqual(['c-jo'])
    expect(prep.skipped.opted_out).toBe(2)
  })

  it('takes people never in touch only when asked', async () => {
    const db = world({ audience: { relationship_types: ['customer'], last_contacted_more_than_days: 180, include_never_contacted: true } })
    const prep = await prepareCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', now: NOW })
    if (!prep.ok) throw new Error(prep.error)
    expect(prep.recipients.map((r) => r.id)).toEqual(['c-fay', 'c-jo', 'c-ana'])
  })

  it('a group by tag reaches every type with the tag', async () => {
    const db = world({ audience: { tags_any: ['persian'] } })
    db.tables.contact.find((c) => c.id === 'c-eve')!.tags = ['persian']
    db.tables.contact.find((c) => c.id === 'c-ben')!.tags = ['persian']
    const prep = await prepareCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', now: NOW })
    if (!prep.ok) throw new Error(prep.error)
    expect(prep.recipients.map((r) => r.id).sort()).toEqual(['c-ben', 'c-eve'])
  })

  it('refuses without a sequence or an audience', async () => {
    for (const campaign of [{ sequence_id: null }, { audience: null }]) {
      const db = world(campaign)
      const prep = await prepareCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', now: NOW })
      expect(prep).toMatchObject({ ok: false, code: campaign.audience === null ? 'NO_AUDIENCE' : 'NO_SEQUENCE' })
    }
  })
})

describe('the campaign card and its yes', () => {
  async function card(db: ReturnType<typeof world>): Promise<OutreachApprovalContext> {
    const prep = await prepareCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', now: NOW })
    if (!prep.ok) throw new Error(prep.error)
    const held = await raiseCampaignCard(db.client, { prep, userId: 'user-1', origin: { conversationId: null } })
    expect(held).toMatchObject({ ok: true, approval_id: 'appr-1' })
    const call = hoisted.createToolApproval.mock.calls[0][1] as { toolName: string; input: Record<string, unknown>; context: { outreach: OutreachApprovalContext }; card: { title: string } }
    expect(call.toolName).toBe('launch_campaign')
    expect(call.card.title).toBe('Send “Win-back” to 2 people?')
    expect(call.input).toMatchObject({
      campaign_id: 'camp-1',
      campaign: 'Win-back',
      audience: 'Customers last in touch more than 6 months ago',
      recipients: 'Jo Kim <jo@example.com>\nAna Ruiz <ana@example.com>',
    })
    return call.context.outreach
  }

  it('the yes enrolls and arms exactly the named people who still qualify, and records the launch', async () => {
    const db = world()
    const outreach = await card(db)
    expect(outreach).toMatchObject({ kind: 'campaign', id: 'camp-1', recipient_ids: ['c-jo', 'c-ana'] })
    // Since the card: Ana got in touch (no longer quiet), and Ben went quiet (not on this card).
    db.tables.contact.find((c) => c.id === 'c-ana')!.last_interaction_at = RECENT
    db.tables.contact.find((c) => c.id === 'c-ben')!.last_interaction_at = LAPSED

    const outcome = await executeCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', approved: outreach, now: NOW })
    expect(outcome).toMatchObject({ ok: true, enrolled: 1, armed: 1 })
    const enrolled = db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1')
    expect(enrolled.map((e) => e.contact_id)).toEqual(['c-jo'])
    expect(typeof enrolled[0].next_send_at).toBe('string')
    expect(db.tables.sequence.find((s) => s.id === 'seq-1')).toMatchObject({ status: 'active', auto_send: true, sending_account_id: 'acct-1' })
    expect(db.tables.campaign[0]).toMatchObject({ status: 'active', launched_by: 'user-1', stats: { skipped_opted_out: 1, launches: 1 } })
  })

  it('sends nothing when the emails changed after the card', async () => {
    const db = world()
    const outreach = await card(db)
    db.tables.sequence_step[1].body = 'A new follow-up the card never showed.'
    const outcome = await executeCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', approved: outreach, now: NOW })
    expect(outcome).toMatchObject({ ok: false, code: 'CAMPAIGN_CHANGED' })
    expect(db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1')).toEqual([])
    expect(db.tables.sequence.find((s) => s.id === 'seq-1')!.status).toBe('draft')
  })

  it('never mails an address the card did not show (a contact edited or merged since)', async () => {
    const db = world()
    const outreach = await card(db)
    expect(outreach.recipient_emails).toEqual(['jo@example.com', 'ana@example.com'])
    db.tables.contact.find((c) => c.id === 'c-jo')!.email = 'jo@newjob.example'
    const outcome = await executeCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', approved: outreach, now: NOW })
    expect(outcome).toMatchObject({ ok: true, enrolled: 1 })
    expect(db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1').map((e) => e.contact_email)).toEqual(['ana@example.com'])
  })

  it('a card that recorded no addresses sends nothing', async () => {
    const db = world()
    const { recipient_emails: _dropped, ...outreach } = await card(db)
    const outcome = await executeCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', approved: outreach, now: NOW })
    expect(outcome).toMatchObject({ ok: false, code: 'CARD_INCOMPLETE' })
    expect(db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1')).toEqual([])
  })

  it('never enrolls someone an import tagged unsubscribed after the card', async () => {
    const db = world()
    const outreach = await card(db)
    db.tables.contact.find((c) => c.id === 'c-jo')!.tags = ['unsubscribed email']
    const outcome = await executeCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', approved: outreach, now: NOW })
    expect(outcome).toMatchObject({ ok: true, enrolled: 1 })
    expect(db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1').map((e) => e.contact_id)).toEqual(['c-ana'])
  })

  it('never reaches someone who opted out after the card', async () => {
    const db = world()
    const outreach = await card(db)
    db.tables.outreach_suppression.push({ id: 'sup-2', workspace_id: 'ws-1', email: 'jo@example.com' })
    const outcome = await executeCampaignLaunch(db.client, { workspaceId: 'ws-1', campaign: await campaignOf(db), userId: 'user-1', approved: outreach, now: NOW })
    expect(outcome).toMatchObject({ ok: true, enrolled: 1 })
    expect(db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1').map((e) => e.contact_id)).toEqual(['c-ana'])
  })
})

describe('campaignCounts', () => {
  it('counts sent, replied and opted out from the enrollments, plus the audience\'s opted-out people', async () => {
    const db = world({ stats: { skipped_opted_out: 2 } })
    db.tables.sequence_enrollment.push(
      { id: 'e1', workspace_id: 'ws-1', sequence_id: 'seq-1', contact_id: 'a', status: 'active', current_step_order: 1, exit_reason: null },
      { id: 'e2', workspace_id: 'ws-1', sequence_id: 'seq-1', contact_id: 'b', status: 'exited', current_step_order: 1, exit_reason: 'replied' },
      { id: 'e3', workspace_id: 'ws-1', sequence_id: 'seq-1', contact_id: 'c', status: 'exited', current_step_order: 0, exit_reason: 'opted_out' },
      { id: 'e4', workspace_id: 'ws-1', sequence_id: 'seq-1', contact_id: 'd', status: 'active', current_step_order: 0, exit_reason: null, next_send_at: '2026-11-03T17:00:00Z' },
      // Staged and never launched (a declined card): reached nobody, not counted.
      { id: 'e5', workspace_id: 'ws-1', sequence_id: 'seq-1', contact_id: 'e', status: 'active', current_step_order: 0, exit_reason: null, next_send_at: null },
    )
    const counts = await campaignCounts(db.client, { workspaceId: 'ws-1', campaigns: [{ id: 'camp-1', sequence_id: 'seq-1', stats: { skipped_opted_out: 2 } }, { id: 'plan', sequence_id: null }] })
    expect(counts.get('camp-1')).toEqual({ recipients: 4, sent: 2, replied: 1, opted_out: 3, active: 2 })
    expect(counts.has('plan')).toBe(false)
  })
})

describe('refreshRollingCampaign: the weekly pass', () => {
  it('raises one card for the people newly matching, in the home thread of who launched it', async () => {
    const db = world({ status: 'active', launched_by: 'user-1', launched_at: '2026-10-01T00:00:00Z' })
    const result = await refreshRollingCampaign(db.client, await campaignOf(db), { now: NOW })
    expect(result).toMatchObject({ outcome: 'card', approval_id: 'appr-1', recipients: 2 })
    const call = hoisted.createToolApproval.mock.calls[0][1] as { userId: string; conversationId: string | null }
    expect(call).toMatchObject({ userId: 'user-1', conversationId: null })
    expect(db.tables.sequence_enrollment.filter((e) => e.sequence_id === 'seq-1')).toEqual([])
  })

  it('raises none while its card waits, and none when nobody is new', async () => {
    const db = world({ status: 'active', launched_by: 'user-1' })
    db.tables.tool_approval = [{ id: 'appr-0', user_id: 'user-1', tool: 'launch_campaign', status: 'pending', expires_at: '2999-01-01T00:00:00Z', context: { outreach: { id: 'camp-1' } } }]
    expect(await refreshRollingCampaign(db.client, await campaignOf(db), { now: NOW })).toMatchObject({ outcome: 'card_waiting' })

    db.tables.tool_approval = []
    for (const id of ['c-jo', 'c-ana']) db.tables.sequence_enrollment.push({ id: `e-${id}`, workspace_id: 'ws-1', sequence_id: 'seq-1', contact_id: id, contact_email: `${id.slice(2)}@example.com`, status: 'exited', current_step_order: 2, exit_reason: 'completed' })
    expect(await refreshRollingCampaign(db.client, await campaignOf(db), { now: NOW })).toMatchObject({ outcome: 'nobody_new' })
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('does nothing for a campaign that is off, not rolling, or never launched', async () => {
    for (const campaign of [{ status: 'paused', launched_by: 'user-1' }, { status: 'active', rolling: false, launched_by: 'user-1' }, { status: 'active', launched_by: null }]) {
      const db = world(campaign)
      expect(await refreshRollingCampaign(db.client, await campaignOf(db), { now: NOW })).toMatchObject({ outcome: 'not_ready' })
    }
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })
})
