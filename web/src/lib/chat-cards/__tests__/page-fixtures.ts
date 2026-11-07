/**
 * A workspace for the page-card tests (show and read_card for the pages),
 * on the in-memory double in its projecting mode, with records the person
 * may and may not see: a private team they are not in, a private eval case,
 * a package nobody shared with them, a teammate's personal skill, a
 * teammate's notifications.
 */
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createShowTools } from '@/lib/ai/tools/show'
import type { CardContextEntry } from '@/lib/chat-cards/context'

export const WS = 'ws-1'
export const ME = 'user-me'
export const OTHER_USER = 'user-k'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const ID = {
  myMember: uuid(901),
  otherMember: uuid(902),
  teamOpen: uuid(101),
  teamSecret: uuid(102),
  teamCore: uuid(103),
  seqOutbound: uuid(201),
  seqRenewal: uuid(202),
  listFintech: uuid(301),
  listArchived: uuid(302),
  suite: uuid(401),
  caseOpen: uuid(411),
  casePrivate: uuid(412),
  caseMine: uuid(413),
  run: uuid(421),
  flowOpen: uuid(501),
  flowSecret: uuid(502),
  flowSystemBot: uuid(503),
  botOpen: uuid(511),
  botSecret: uuid(512),
  botSystem: uuid(513),
  pkgOpen: uuid(601),
  pkgPersonal: uuid(602),
  pkgShared: uuid(603),
  agentSystem: uuid(701),
  skillMine: uuid(702),
  skillTheirs: uuid(703),
  skillWorkspace: uuid(704),
  createEval: '6b3f1d02-91ac-4e57-8c24-0a5f7d3e9b18',
}

export function action(n: number, title: string, teamId: string, extra: Record<string, unknown> = {}) {
  return {
    id: uuid(1000 + n),
    identifier: `GEN-${n}`,
    title,
    workspace_id: WS,
    team_id: teamId,
    parent_id: null,
    priority: 'medium',
    assignee_id: null,
    created_at: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    ...extra,
  }
}

/** The workspace, with `features` overridden over the full edition (every feature on by default). */
export function seededWorkspace(features: Record<string, 'on' | 'off'> = {}) {
  const db = makeFakeSupabase({ project: true })
  db.seed('workspace', [{ id: WS, settings: { edition: 'full', feature_overrides: features } }])
  db.seed('member', [
    { id: ID.myMember, user_id: ME, workspace_id: WS, display_name: 'Liam', role: 'member' },
    { id: ID.otherMember, user_id: OTHER_USER, workspace_id: WS, display_name: 'Kenan', role: 'member' },
  ])
  db.seed('team', [
    { id: ID.teamOpen, name: 'Platform', is_private: false, workspace_id: WS },
    { id: ID.teamSecret, name: 'Secret Ops', is_private: true, workspace_id: WS },
    { id: ID.teamCore, name: 'Core', is_private: true, workspace_id: WS },
  ])
  db.seed('team_member', [
    { team_id: ID.teamOpen, member_id: ID.myMember },
    { team_id: ID.teamCore, member_id: ID.myMember },
    { team_id: ID.teamSecret, member_id: ID.otherMember },
  ])
  db.seed('actions', [
    action(1, 'Pricing page copy', ID.teamOpen, { priority: 'high' }),
    action(2, 'Fix login', ID.teamOpen),
    action(3, 'Acquisition memo', ID.teamSecret),
    action(4, 'Core refactor', ID.teamCore),
  ])
  db.seed('sequence', [
    { id: ID.seqOutbound, name: 'Q4 outbound', status: 'active', workspace_id: WS, created_at: '2026-10-01' },
    { id: ID.seqRenewal, name: 'Renewals', status: 'draft', workspace_id: WS, created_at: '2026-10-02' },
  ])
  db.seed('sequence_step', [
    { id: uuid(211), sequence_id: ID.seqOutbound, step_order: 1, subject: 'Hello', delay_days: 0, is_active: true },
    { id: uuid(212), sequence_id: ID.seqOutbound, step_order: 2, subject: null, delay_days: 3, is_active: true },
  ])
  db.seed('prospect_list', [
    { id: ID.listFintech, name: 'Fintech CFOs', status: 'active', workspace_id: WS, created_at: '2026-10-01' },
    { id: ID.listArchived, name: 'Old list', status: 'archived', workspace_id: WS, created_at: '2026-09-01' },
  ])
  db.seed('prospect_list_entry', [
    { id: uuid(311), list_id: ID.listFintech, workspace_id: WS, stage: 'new', candidate: { name: 'Acme Pay' }, created_at: '2026-10-02' },
    { id: uuid(312), list_id: ID.listFintech, workspace_id: WS, stage: 'dismissed', candidate: { name: 'Gone Inc' }, created_at: '2026-10-03' },
    { id: uuid(313), list_id: ID.listArchived, workspace_id: WS, stage: 'new', candidate: { name: 'Elsewhere' }, created_at: '2026-10-04' },
  ])
  db.seed('eval_suite', [{ id: ID.suite, name: 'Triage suite', workspace_id: WS, created_at: '2026-10-01' }])
  db.seed('eval_case', [
    { id: ID.caseOpen, suite_id: ID.suite, name: 'Shared case', visibility: 'workspace', created_by: OTHER_USER, workspace_id: WS, sort_order: 1 },
    { id: ID.casePrivate, suite_id: ID.suite, name: 'Kenan private case', visibility: 'private', created_by: OTHER_USER, workspace_id: WS, sort_order: 2 },
    { id: ID.caseMine, suite_id: ID.suite, name: 'My private case', visibility: 'private', created_by: ME, workspace_id: WS, sort_order: 3 },
  ])
  db.seed('eval_run', [{ id: ID.run, suite_id: ID.suite, mode: 'batch', status: 'done', outcome: 'pass', started_at: '2026-10-05T10:00:00Z', workspace_id: WS }])
  db.seed('flow', [
    { id: ID.flowOpen, name: 'Notify on done', workspace_id: WS, team_id: ID.teamOpen, team: { id: ID.teamOpen, name: 'Platform' }, bot: { id: ID.botOpen, name: 'Pat' }, created_at: '2026-10-01' },
    { id: ID.flowSecret, name: 'Secret hook', workspace_id: WS, team_id: ID.teamSecret, team: { id: ID.teamSecret, name: 'Secret Ops' }, bot: { id: ID.botSecret, name: 'Shadow bot' }, created_at: '2026-10-02' },
    { id: ID.flowSystemBot, name: 'Triage loop', workspace_id: WS, team_id: ID.teamOpen, team: { id: ID.teamOpen, name: 'Platform' }, bot: { id: ID.botSystem, name: 'Triage' }, created_at: '2026-10-03' },
  ])
  db.seed('ai_team_member', [
    { id: ID.botOpen, name: 'Pat', team_id: ID.teamOpen, is_system: false, workspace_id: WS },
    { id: ID.botSecret, name: 'Shadow bot', team_id: ID.teamSecret, is_system: false, workspace_id: WS },
    { id: ID.botSystem, name: 'Triage', team_id: ID.teamSecret, is_system: true, workspace_id: WS },
  ])
  db.seed('campaign', [
    { id: uuid(801), name: 'Launch week', status: 'active', workspace_id: WS, updated_at: '2026-10-02' },
    { id: uuid(802), name: 'Other workspace campaign', status: 'active', workspace_id: 'ws-other', updated_at: '2026-10-03' },
  ])
  db.seed('claim', [
    { id: uuid(851), text: 'Pricing moves to $99', status: 'active', confirmation: 'confirmed', workspace_id: WS, created_at: '2026-10-01' },
    { id: uuid(852), text: 'Dismissed claim', status: 'active', confirmation: 'dismissed', workspace_id: WS, created_at: '2026-10-02' },
  ])
  db.seed('knowledge_package', [
    { id: ID.pkgOpen, name: 'Sales playbook', visibility: 'workspace', team_id: null, created_by: OTHER_USER, workspace_id: WS },
    { id: ID.pkgPersonal, name: 'Kenan notes', visibility: 'personal', team_id: null, created_by: OTHER_USER, workspace_id: WS },
    { id: ID.pkgShared, name: 'Board prep', visibility: 'personal', team_id: null, created_by: OTHER_USER, workspace_id: WS },
  ])
  db.seed('knowledge_package_share', [{ package_id: ID.pkgShared, shared_with_member_id: ID.myMember, shared_with_team_id: null, workspace_id: WS }])
  db.seed('knowledge_package_item', [
    { package_id: ID.pkgOpen, entity_type: 'claim', entity_id: uuid(851), workspace_id: WS },
    { package_id: ID.pkgOpen, entity_type: 'capture', entity_id: uuid(852), workspace_id: WS },
  ])
  db.seed('recipe', [
    { id: ID.agentSystem, name: 'Note taker', category: 'agent', is_system: true, visibility: 'workspace', workspace_id: null, created_by: null },
    { id: ID.skillMine, name: 'My tone', category: 'skill', is_system: false, visibility: 'personal', workspace_id: WS, created_by: ME },
    { id: ID.skillTheirs, name: 'Kenan secret skill', category: 'skill', is_system: false, visibility: 'personal', workspace_id: WS, created_by: OTHER_USER },
    { id: ID.skillWorkspace, name: 'Follow-up writer', category: 'skill', is_system: false, visibility: 'workspace', workspace_id: WS, created_by: OTHER_USER },
    { id: ID.createEval, name: 'Create eval', slug: 'create-eval', category: 'skill', is_system: true, visibility: 'workspace', workspace_id: null, created_by: null },
  ])
  db.seed('notification', [
    { id: uuid(951), recipient_id: ID.myMember, title: 'Kenan mentioned you', is_read: false, is_archived: false, metadata: {}, created_at: '2026-10-05', workspace_id: WS },
    { id: uuid(952), recipient_id: ID.otherMember, title: 'For Kenan only', is_read: false, is_archived: false, metadata: {}, created_at: '2026-10-06', workspace_id: WS },
    { id: uuid(953), recipient_id: ID.myMember, title: 'A bot notice', is_read: false, is_archived: false, metadata: { teammate_id: 'bot-1' }, created_at: '2026-10-07', workspace_id: WS },
    { id: uuid(954), recipient_id: ID.myMember, title: 'Archived', is_read: true, is_archived: true, metadata: {}, created_at: '2026-10-01', workspace_id: WS },
    // A bot on a private team the person is not on: its notice has no bot to
    // live with, so it stays in the bell.
    { id: uuid(955), recipient_id: ID.myMember, title: 'An orphaned bot notice', is_read: false, is_archived: false, metadata: { teammate_id: ID.botSecret }, created_at: '2026-10-08', workspace_id: WS },
    { id: uuid(956), recipient_id: ID.myMember, title: 'A reachable bot notice', is_read: false, is_archived: false, metadata: { teammate_id: ID.botOpen }, created_at: '2026-10-09', workspace_id: WS },
  ])
  return db
}

type Exec = (input: unknown) => Promise<Record<string, unknown>>

export function pageTools(db: ReturnType<typeof makeFakeSupabase>, cards?: CardContextEntry[]) {
  const t = createShowTools(ME, db as never, WS, cards)
  return {
    show: ((input: unknown) => (t.show.execute as unknown as Exec)(input)) as Exec,
    readCard: ((input: unknown) => (t.read_card.execute as unknown as Exec)(input)) as Exec,
  }
}

/** Every string anywhere in a tool result, for "this name never appears" checks. */
export function allText(value: unknown): string {
  return JSON.stringify(value)
}
