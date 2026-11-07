/**
 * Initial imports → the work ledger (Sequence row 11, plan §1.1). One row per
 * import run, owned by the user who connected the account and not quiet: a
 * failed import is news nothing else delivers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router (and the home turn) through Inngest: mocked,
// so no test sends a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'
import {
  emailAccountKey,
  failHubspotImport,
  finishEmailImport,
  finishHubspotImport,
  hubspotProgressText,
  openEmailImport,
  openHubspotImport,
  stepHubspotImport,
} from '../import-mirror'

const W = '11111111-1111-4111-8111-000000000001'
const STARTED = '2026-09-28T09:00:00.000Z'
const HUB = { accountId: 'acct-hub', workspaceId: W, userId: 'u-1', startedAt: STARTED }
const GMAIL = { workspaceId: W, userId: 'u-1', provider: 'google' as const, accountId: 'acct-mail' }

function seeded() {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [{ id: 'm-1', workspace_id: W, user_id: 'u-1' }])
  return fake
}
const jobs = (fake: ReturnType<typeof seeded>) => fake.rows('tracked_job')

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

describe('the step text', () => {
  it('counts what is in so far', () => {
    expect(hubspotProgressText(1200, null)).toBe('Imported 1,200 companies')
    expect(hubspotProgressText(1, 1)).toBe('Imported 1 company and 1 contact')
  })

  it('keys a legacy mailbox on user and provider', () => {
    expect(emailAccountKey(GMAIL)).toBe('acct-mail')
    expect(emailAccountKey({ ...GMAIL, accountId: null })).toBe('u-1:google')
  })
})

describe('the HubSpot import', () => {
  it('opens one running row per run for the connecting user; a continuation finds it without a new step', async () => {
    const fake = seeded()
    await openHubspotImport(fake as never, HUB, true)
    await openHubspotImport(fake as never, HUB, false)
    expect(jobs(fake)).toHaveLength(1)
    expect(jobs(fake)[0]).toMatchObject({
      kind: 'crm_import',
      status: 'running',
      member_id: 'm-1',
      title: 'Importing from HubSpot',
      run_key: `hubspot:acct-hub:${STARTED}`,
      current_step: 'Importing companies',
      source: { provider: 'hubspot', account_id: 'acct-hub' },
    })
    expect(jobs(fake)[0].source).not.toHaveProperty('quiet')
    expect((jobs(fake)[0].progress as { steps: unknown[] }).steps).toHaveLength(1)
  })

  it('a re-kicked run (a new start) is a new row, not the old one reopened', async () => {
    const fake = seeded()
    await openHubspotImport(fake as never, HUB, true)
    await failHubspotImport(fake as never, HUB, 'No valid HubSpot token')
    await openHubspotImport(fake as never, { ...HUB, startedAt: '2026-09-28T10:00:00.000Z' }, true)
    expect(jobs(fake).map((j) => j.status)).toEqual(['failed', 'running'])
  })

  it('steps with the running totals and finishes with a summary', async () => {
    const fake = seeded()
    await openHubspotImport(fake as never, HUB, true)
    await stepHubspotImport(fake as never, HUB, 300, null)
    await stepHubspotImport(fake as never, HUB, 300, 40)
    expect(jobs(fake)[0].current_step).toBe('Imported 300 companies and 40 contacts')
    await finishHubspotImport(fake as never, HUB, 300, 41)
    expect(jobs(fake)[0]).toMatchObject({
      status: 'done',
      result_summary: 'Imported 300 companies and 41 contacts from HubSpot',
    })
  })

  it('a failure is failed with the reason, and pushes', async () => {
    const fake = seeded()
    await openHubspotImport(fake as never, HUB, true)
    await failHubspotImport(fake as never, HUB, 'No valid HubSpot token for this account — reconnect HubSpot')
    expect(jobs(fake)[0]).toMatchObject({
      status: 'failed',
      error_message: 'No valid HubSpot token for this account — reconnect HubSpot',
    })
    expect(hoisted.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'work_failed', recipientId: 'm-1' }))
  })

  it('writes nothing when the connecting user has no member row, or the run has no row', async () => {
    const fake = seeded()
    await openHubspotImport(fake as never, { ...HUB, userId: 'u-gone' }, true)
    await stepHubspotImport(fake as never, HUB, 1, null)
    await finishHubspotImport(fake as never, HUB, 1, 1)
    expect(jobs(fake)).toHaveLength(0)
  })
})

describe('the Gmail / Outlook import', () => {
  it('opens a running row for the mailbox and steps into the recent mail', async () => {
    const fake = seeded()
    await openEmailImport(fake as never, GMAIL, STARTED)
    expect(jobs(fake)).toHaveLength(1)
    expect(jobs(fake)[0]).toMatchObject({
      kind: 'email_import',
      status: 'running',
      member_id: 'm-1',
      title: 'Importing Gmail',
      run_key: `email:acct-mail:${STARTED}`,
      current_step: 'Importing the last 30 days',
      source: { provider: 'google', account_id: 'acct-mail', account_key: 'acct-mail' },
    })
  })

  it('a restart cancels the mailbox’s older open row, leaving other mailboxes alone', async () => {
    const fake = seeded()
    const outlook = { ...GMAIL, provider: 'microsoft' as const, accountId: null }
    await openEmailImport(fake as never, GMAIL, STARTED)
    await openEmailImport(fake as never, outlook, STARTED)
    await openEmailImport(fake as never, GMAIL, '2026-09-28T09:30:00.000Z')

    const [first, other, second] = jobs(fake)
    expect(first).toMatchObject({ status: 'canceled', error_message: 'Restarted — a newer import replaced it' })
    expect(other).toMatchObject({ status: 'running', title: 'Importing Outlook', source: { account_key: 'u-1:microsoft' } })
    expect(second).toMatchObject({ status: 'running', run_key: 'email:acct-mail:2026-09-28T09:30:00.000Z' })
    // Canceling is not news.
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('the finish settles the mailbox’s open row', async () => {
    const fake = seeded()
    await openEmailImport(fake as never, GMAIL, STARTED)
    await finishEmailImport(fake as never, GMAIL, 1)
    expect(jobs(fake)[0]).toMatchObject({ status: 'done', result_summary: 'Imported 1 message from Gmail' })
    // Settled: a late finish finds no open row and writes nothing.
    await finishEmailImport(fake as never, GMAIL, 99)
    expect(jobs(fake)).toHaveLength(1)
    expect(jobs(fake)[0]).toMatchObject({ status: 'done', result_summary: 'Imported 1 message from Gmail' })
  })
})

describe('the imports come from their area’s face (one-agent S3, migration 318)', () => {
  it('the HubSpot import is CRM’s and the mail import Mail’s, each recording its area', async () => {
    const fake = seeded()
    fake.seed('ai_team_member', [
      { id: 'tm-assistant', workspace_id: W, system_key: 'assistant', is_system: true },
      { id: 'tm-crm', workspace_id: W, system_key: 'crm', is_system: true },
      { id: 'tm-mail', workspace_id: W, system_key: 'mail', is_system: true },
    ])
    await openHubspotImport(fake as never, HUB, true)
    await openEmailImport(fake as never, GMAIL, STARTED)
    const [hub, mail] = jobs(fake)
    expect(hub).toMatchObject({ kind: 'crm_import', ai_team_member_id: 'tm-crm', area: 'crm' })
    expect(mail).toMatchObject({ kind: 'email_import', ai_team_member_id: 'tm-mail', area: 'mail' })
  })

  it('a workspace without the face yet falls back to the Assistant', async () => {
    const fake = seeded()
    fake.seed('ai_team_member', [{ id: 'tm-assistant', workspace_id: W, system_key: 'assistant', is_system: true }])
    await openHubspotImport(fake as never, HUB, true)
    expect(jobs(fake)[0]).toMatchObject({ ai_team_member_id: 'tm-assistant', area: 'crm' })
  })
})
