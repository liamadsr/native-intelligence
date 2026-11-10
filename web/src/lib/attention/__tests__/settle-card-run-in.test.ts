/**
 * A work card's Start in the place picked on the card (`run_in`,
 * src/lib/attention/work-place.ts; settle-card.ts startWorkCardIn):
 *   - only the person's own click picks a place: the model's settle_card
 *     never sends work to their Mac; a malformed place, or one on anything
 *     but a Start, is refused before the card is touched;
 *   - a Mac folder: the card's tracked action, then the job (startWorkOnMac),
 *     the proposal applied once it started; a refusal (or a throw) puts the
 *     card back and takes the action back, with the person's sentence;
 *   - a cloud environment: the card's coding run (startCardCodingRun), never
 *     on a person's own ChatGPT plan; a refusal puts the card back.
 * The Native Intelligence run with no place is the route's (attention-items route tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fake }))
const hoisted = vi.hoisted(() => ({
  onMac: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'started', sessionId: 'sess-1', mac: 'Liam’s MacBook', folder: 'notes', edits: false, created: true })),
  cloud: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'started', agent_run_id: 'run-9', action: { id: 'act-cloud', identifier: 'ENG-9' }, repo: 'acme/core', environment: { name: 'Core sandbox' } })),
  plan: vi.fn(async (..._a: unknown[]) => false),
  send: vi.fn(async () => ({ ids: ['evt'] })),
}))
vi.mock('@/lib/environments/start', () => ({ startWorkOnMac: hoisted.onMac }))
vi.mock('@/lib/chat/cloud-coding-tools', () => ({ startCardCodingRun: hoisted.cloud }))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.plan }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

import { settleAttentionCard } from '../settle-card'

const WS = 'a5000000-0000-4000-8000-000000000001'
const CARD = 'c5000000-0000-4000-8000-000000000001'
const PROPOSAL = 'b5000000-0000-4000-8000-000000000001'
const FOLDER = '88888888-8888-4888-8888-888888888881'
const ENV = '99999999-9999-4999-8999-999999999902'
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MAC_PLACE = { kind: 'mac', folder_id: FOLDER }
const CLOUD_PLACE = { kind: 'cloud', environment_id: ENV, project_id: PROJECT }

const cardRow = () => ({
  id: CARD,
  workspace_id: WS,
  member_id: 'mem-liam',
  kind: 'work_proposal',
  title: 'Draft the connection diagram',
  why: null,
  status: 'pending',
  proposal_id: PROPOSAL,
  payload: { task: 'Current state and target state, for Friday.' },
  expires_at: null,
})
const card = () => fake.rows('attention_item').find((r) => r.id === CARD)
const proposal = () => fake.rows('proposed_change').find((r) => r.id === PROPOSAL)
/**
 * The person's own client, as RLS has it for a plain member: it may file an
 * action but not delete one (actions_delete is owners' and admins'), and a
 * refused delete removes nothing and says nothing. Everything else is the fake's.
 */
const anything: unknown = new Proxy(() => {}, {
  get: (_t, k) => (k === 'then' ? (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }) : () => anything),
})
const memberClient = () =>
  new Proxy(fake, {
    get: (t, k) =>
      k === 'from'
        ? (table: string) => {
            const q = t.from(table)
            return table === 'actions' ? new Proxy(q, { get: (qt, qk) => (qk === 'delete' ? () => anything : Reflect.get(qt, qk)) }) : q
          }
        : Reflect.get(t, k),
  })
const start = (runIn: unknown, by: 'person' | 'model' = 'person', action: 'start' | 'dismiss' = 'start') =>
  settleAttentionCard(memberClient() as never, 'user-liam', { id: CARD, action, run_in: runIn }, { ...(by === 'person' ? { actor: 'person' as const } : {}), ownerMemberId: 'mem-liam' })

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'mem-liam', user_id: 'user-liam', workspace_id: WS }])
  fake.seed('team', [{ id: 'team-1', workspace_id: WS, created_at: '2026-01-01' }])
  fake.seed('workflow_state', [{ id: 'st-todo', team_id: 'team-1', is_default: true }])
  fake.seed('attention_item', [cardRow()])
  fake.seed('proposed_change', [{ id: PROPOSAL, workspace_id: WS, status: 'pending' }])
  fake.seed('actions', [])
  for (const f of Object.values(hoisted)) f.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('who picks the place', () => {
  it('the model (settle_card, no person actor) never does: 403, the card untouched, nothing started', async () => {
    const res = await start(MAC_PLACE, 'model')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'RUN_IN_PERSON_ONLY' })
    expect(card()?.status).toBe('pending')
    expect(hoisted.onMac).not.toHaveBeenCalled()
    expect(fake.rows('actions')).toHaveLength(0)
  })

  it('a malformed place, or a place on a dismiss, is refused before the card is touched', async () => {
    for (const bad of [{ kind: 'mac' }, { kind: 'mac', folder_id: 'not-a-uuid' }, { kind: 'cloud', environment_id: ENV }, { kind: 'ssh', host: 'x' }, 'mac', [MAC_PLACE]]) {
      const res = await start(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'INVALID_RUN_IN' })
    }
    expect((await start(MAC_PLACE, 'person', 'dismiss')).status).toBe(400)
    expect(card()?.status).toBe('pending')
    expect(hoisted.onMac).not.toHaveBeenCalled()
  })
})

describe('a folder on the person’s Mac', () => {
  it('files the card’s tracked action, starts the job there, applies the proposal, and says where', async () => {
    const res = await start(MAC_PLACE)
    expect(res.status).toBe(200)
    const body = await res.json()
    const [action] = fake.rows('actions')
    expect(action).toMatchObject({ title: 'Draft the connection diagram', description: 'Current state and target state, for Friday.', status_id: 'st-todo', agent_run_status: 'starting' })
    expect(action.context_data).toMatchObject({ work_run: true, attention_item_id: CARD })
    expect(hoisted.onMac).toHaveBeenCalledWith(fake, {
      userId: 'user-liam',
      workspaceId: WS,
      folderId: FOLDER,
      action: { id: action.id, identifier: expect.any(String), title: 'Draft the connection diagram', task: 'Current state and target state, for Friday.' },
    })
    expect(body).toMatchObject({ ok: true, status: 'started', entity_id: action.id, entity_kind: 'action', where: { kind: 'mac', mac: 'Liam’s MacBook', folder: 'notes', edits: false, session_id: 'sess-1' } })
    expect(card()?.status).toBe('accepted')
    expect(proposal()).toMatchObject({ status: 'applied', result_entity_id: action.id })
    // No Native Intelligence work run: the Mac does it.
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('a refusal (the Mac offline) puts the card back and takes the action back (on the service client: a member can’t delete actions), with the person’s sentence', async () => {
    hoisted.onMac.mockResolvedValueOnce({ status: 'refused', code: 'MAC_OFFLINE', reason: 'Liam’s MacBook is offline, so nothing started in notes.', httpStatus: 409 })
    const res = await start(MAC_PLACE)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Liam’s MacBook is offline, so nothing started in notes.', code: 'MAC_OFFLINE' })
    expect(card()?.status).toBe('pending')
    expect(fake.rows('actions')).toHaveLength(0)
    expect(proposal()?.status).toBe('pending')
  })

  it('a throw is a 500 that leaves nothing behind either', async () => {
    hoisted.onMac.mockRejectedValueOnce(new Error('db down'))
    const res = await start(MAC_PLACE)
    expect(res.status).toBe(500)
    expect(card()?.status).toBe('pending')
    expect(fake.rows('actions')).toHaveLength(0)
  })

  it('a card already started elsewhere is a 409, and nothing is filed', async () => {
    card()!.status = 'accepted'
    expect((await start(MAC_PLACE)).status).toBe(409)
    expect(fake.rows('actions')).toHaveLength(0)
    expect(hoisted.onMac).not.toHaveBeenCalled()
  })
})

describe('a cloud environment', () => {
  it('starts the card’s coding run on the project’s repo there, applies the proposal, and says where', async () => {
    const res = await start(CLOUD_PLACE)
    expect(res.status).toBe(200)
    expect(hoisted.cloud).toHaveBeenCalledWith(fake, { userId: 'user-liam', workspaceId: WS }, {
      projectId: PROJECT,
      environmentId: ENV,
      title: 'Draft the connection diagram',
      request: 'Current state and target state, for Friday.',
      attentionItemId: CARD,
    })
    expect(await res.json()).toMatchObject({ ok: true, status: 'started', agent_run_id: 'run-9', entity_id: 'act-cloud', identifier: 'ENG-9', where: { kind: 'cloud', environment: 'Core sandbox', repo: 'acme/core' } })
    expect(card()?.status).toBe('accepted')
    expect(proposal()).toMatchObject({ status: 'applied', result_entity_id: 'act-cloud' })
  })

  it('a refusal puts the card back, with the person’s sentence', async () => {
    hoisted.cloud.mockResolvedValueOnce({ status: 'refused', code: 'NO_GITHUB', reason: 'A coding run pushes to GitHub as you. Connect GitHub in Settings → Connections, then press Start again.' })
    const res = await start(CLOUD_PLACE)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'NO_GITHUB', error: expect.stringContaining('Connect GitHub') })
    expect(card()?.status).toBe('pending')
    expect(proposal()?.status).toBe('pending')
  })

  it('a throw is a 500 that puts the card back', async () => {
    hoisted.cloud.mockRejectedValueOnce(new Error('db down'))
    const res = await start(CLOUD_PLACE)
    expect(res.status).toBe(500)
    expect(card()?.status).toBe('pending')
    expect(proposal()?.status).toBe('pending')
  })

  it('never on a person’s own ChatGPT plan: 403 before the card is claimed', async () => {
    hoisted.plan.mockResolvedValueOnce(true)
    const res = await start(CLOUD_PLACE)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'CHATGPT_PLAN_NO_CODING' })
    expect(card()?.status).toBe('pending')
    expect(hoisted.cloud).not.toHaveBeenCalled()
  })
})
