// @vitest-environment jsdom
/**
 * The merge sheet, end to end against a fake API: only workspaces the person
 * OWNS (and not this one) are offered; picking one runs the preflight with the
 * destination pinned; a blocked preflight disables the merge however the name
 * is typed and offers a re-check; a team's fold choice re-plans with choices
 * only and goes back when the re-plan fails; a private team folding into a
 * public one is flagged; the typed name gates the button by the route's rule;
 * the merge sends the preflight's normalised plan and lands the window in the
 * destination; a refusal stays inline; a stale plan re-plans from the
 * defaults; a lost answer whose source is gone counts as merged; a stale
 * preflight answer never fills a reopened sheet; while merging the sheet has
 * no way to close and the window cannot reload for a deploy. The header
 * always says which way the merge goes: from the workspace picked, into this one.
 *
 * Radix's Sheet is replaced with plain elements (jsdom cannot drive it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  recording: false,
  finish: vi.fn(),
  registerReloadBlocker: vi.fn((_isBusy: () => boolean) => vi.fn()),
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? h('div', { 'data-testid': 'sheet' }, children) : null),
  SheetContent: ({ children }: { children: ReactNode }) => h('div', null, children),
  SheetHeader: ({ children }: { children: ReactNode }) => h('div', null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => h('h2', null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => h('p', null, children),
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => ({ isRecording: hoisted.recording }) }))
vi.mock('@/lib/workspace-merge/after-merge', () => ({ finishWorkspaceMerge: (...a: unknown[]) => hoisted.finish(...a) }))
vi.mock('@/lib/deploy-reload', () => ({ registerReloadBlocker: hoisted.registerReloadBlocker }))

import { MergeWorkspaceSheet } from '../merge-workspace-sheet'

const DST = '22222222-2222-4222-8222-222222222222'
const SRC = '11111111-1111-4111-8111-111111111111'
const OTHER = '33333333-3333-4333-8333-333333333333'

const WORKSPACES = {
  workspaces: [
    { id: DST, name: 'Dial8', slug: 'dial8', role: 'owner' },
    { id: SRC, name: 'Coherix', slug: 'coherix', role: 'owner' },
    { id: OTHER, name: 'Shared', slug: 'shared', role: 'admin' },
  ],
}
const TEAMS = { teams: [{ id: 'd-eng', name: 'Engineering', issue_prefix: 'ENG', is_private: false }] }
const TEAM = {
  source_team_id: 't1', source_name: 'General', source_slug: 'general', source_prefix: 'GEN', is_private: false, is_first: true, actions: 12, members: 2,
  collides: { slug: true, prefix: true }, mode: 'own', destination_team_id: null, name: 'Coherix', slug: 'coherix', prefix: 'COH',
  identifiers: { reprefixed: 12, renumbered: 0 }, states_remapped: [], active_cycle_conflict: false, destination_team: null,
}
const PREFLIGHT = {
  ok: true,
  blockers: [],
  source: { id: SRC, name: 'Coherix', slug: 'coherix' },
  destination: { id: DST, name: 'Dial8', slug: 'dial8' },
  busy: { live_captures: [], agent_runs: 0, flow_runs: 0, tracked_jobs: 0 },
  drift: { source: [], destination: [] },
  people: { joining: [{ user_id: 'u1', display_name: 'A', role: 'member' }], in_both: [], destination_members: 2, invites_moving: 0, invites_dropped: 0 },
  teams: [TEAM],
  labels: { matched: 2, created: 1 },
  integrations: { tasks: [], crm: [], connected_accounts: 0, account_links: 0, mcp_servers: 0, cloud_environments: 0, github_prs: 0 },
  collisions: {
    contacts_folded: 0, companies_folded: 0, workspace_company_demoted: false, documents_canon_demoted: [], documents_reslugged: 0, views_reslugged: 0,
    recipes_reslugged: 0, packages_reslugged: 0, prospect_lists_renamed: 0, home_threads_demoted: 0, teammate_threads_demoted: 0, system_teammates_folded: 0,
    seeded_flows_dropped: 0, default_projects_folded: 0, thread_copies_folded: 0, account_links_deduped: 0, sequence_enrollments_exited: 0, singletons_dropped: {},
  },
  counts: { actions: 12, captures: 3, member: 2 },
  plan: { teams: [{ source_team_id: 't1', mode: 'own', destination_team_id: null, name: 'Coherix', slug: 'coherix', prefix: 'COH' }] },
}
const FOLDED = {
  ...PREFLIGHT,
  teams: [{ ...TEAM, mode: 'fold', destination_team_id: 'd-eng', name: null, slug: null, prefix: null, identifiers: { reprefixed: 0, renumbered: 2 }, destination_team: { id: 'd-eng', name: 'Engineering', prefix: 'ENG' } }],
  plan: { teams: [{ source_team_id: 't1', mode: 'fold', destination_team_id: 'd-eng', name: null, slug: null, prefix: null }] },
}
const MERGED = {
  ok: true,
  merge: { merge_id: 'm1', source: { id: SRC, name: 'Coherix' }, destination: { id: DST, name: 'Dial8' }, counts: {}, rows_before: { actions: 12, member: 2 } },
  snapshot: { prefix: `${SRC}/snap`, total_rows: 40, total_pages: 2 },
  members_told: 1,
}

type Reply = { status: number; body: unknown }
type Call = { url: string; body: unknown }
const calls: Call[] = []
let listResponse: () => Reply
let teamsResponse: () => Reply
let preflightResponse: () => Reply | Promise<Reply>
let mergeResponse: () => Reply | Promise<Reply>

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const container = document.createElement('div')
let root: Root | null = null

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const tick = () => new Promise((r) => setTimeout(r, 5))

type Props = Parameters<typeof MergeWorkspaceSheet>[0]
let lastProps: Props

async function render(props: Partial<Props> = {}) {
  root = createRoot(container)
  lastProps = { open: true, onClose: vi.fn(), destination: { id: DST, name: 'Dial8' }, navigateDelayMs: 0, ...props }
  await act(async () => root!.render(h(MergeWorkspaceSheet, lastProps)))
  await flush()
}
async function rerender(props: Partial<Props>) {
  lastProps = { ...lastProps, ...props }
  await act(async () => root!.render(h(MergeWorkspaceSheet, lastProps)))
  await flush()
}

async function pickSource(id = SRC) {
  const btn = container.querySelector<HTMLButtonElement>(`button[data-source-id="${id}"]`)!
  expect(btn).toBeTruthy()
  await act(async () => btn.click())
  await flush()
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function chooseTeam(teamId: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`select[data-team-id="${teamId}"]`)!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

const confirmInput = () => container.querySelector<HTMLInputElement>('input[aria-label="Type the workspace\'s name to confirm"]')!
const mergeButton = () => container.querySelector<HTMLButtonElement>('button[data-testid="merge-confirm"]')!
const cancelButton = () => container.querySelector<HTMLButtonElement>('button[data-testid="merge-cancel"]')
const closeButton = () => container.querySelector<HTMLButtonElement>('button[data-testid="merge-close"]')
const direction = () => container.querySelector('[data-testid="merge-direction"]')!.textContent
const teamSelect = () => container.querySelector<HTMLSelectElement>('select[data-team-id="t1"]')!
const preflightCalls = () => calls.filter((c) => c.url.endsWith('/merge/preflight'))
const mergeCalls = () => calls.filter((c) => c.url.endsWith('/api/account/workspace/merge'))
const teamsCalls = () => calls.filter((c) => c.url === '/api/account/teams')

async function typeAndMerge(name = 'Coherix') {
  await act(async () => type(confirmInput(), name))
  await act(async () => mergeButton().click())
  await flush()
}

beforeEach(() => {
  document.body.appendChild(container)
  calls.length = 0
  hoisted.recording = false
  hoisted.finish.mockReset()
  hoisted.registerReloadBlocker.mockClear()
  listResponse = () => ({ status: 200, body: WORKSPACES })
  teamsResponse = () => ({ status: 200, body: TEAMS })
  preflightResponse = () => ({ status: 200, body: PREFLIGHT })
  mergeResponse = () => ({ status: 200, body: MERGED })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      calls.push({ url, body })
      if (url === '/api/account/workspace/list') return jsonRes(listResponse().status, listResponse().body)
      if (url === '/api/account/teams') return jsonRes(teamsResponse().status, teamsResponse().body)
      if (url.endsWith('/merge/preflight')) {
        const r = await preflightResponse()
        return jsonRes(r.status, r.body)
      }
      if (url.endsWith('/api/account/workspace/merge')) {
        const r = await mergeResponse()
        return jsonRes(r.status, r.body)
      }
      return jsonRes(404, { error: 'no such route' })
    }),
  )
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

describe('MergeWorkspaceSheet', () => {
  it('offers only the workspaces the person owns, and never this one', async () => {
    await render()
    const offered = [...container.querySelectorAll<HTMLButtonElement>('button[data-source-id]')].map((b) => b.dataset.sourceId)
    expect(offered).toEqual([SRC])
    expect(container.textContent).toContain('Coherix')
    expect(container.textContent).not.toContain('Shared')
  })

  it('the header says which way it goes: from the workspace picked, into this one', async () => {
    await render()
    expect(direction()).toContain('From')
    expect(direction()).toContain('A workspace you own')
    expect(direction()).toMatch(/Into.*You are here.*Dial8/)
    expect(container.textContent).toContain('Which workspace should move into Dial8?')
    await pickSource()
    expect(direction()).toMatch(/From.*Coherix.*Into.*Dial8/)
    expect(mergeButton().textContent).toBe('Merge Coherix into Dial8')
  })

  it('a first preflight that fails goes back to choosing, and the header no longer names a source', async () => {
    preflightResponse = () => ({ status: 500, body: { error: 'Could not plan the merge.' } })
    await render()
    await pickSource()
    expect(container.querySelector('button[data-source-id]')).toBeTruthy()
    expect(container.textContent).toContain('Could not plan the merge.')
    expect(direction()).toContain('A workspace you own')
    expect(direction()).not.toContain('Coherix')
  })

  it('closes from the header or the footer before a merge starts', async () => {
    await render()
    await act(async () => closeButton()!.click())
    expect(lastProps.onClose).toHaveBeenCalledTimes(1)
    await act(async () => cancelButton()!.click())
    expect(lastProps.onClose).toHaveBeenCalledTimes(2)
  })

  it('says so when there is nothing to merge in', async () => {
    listResponse = () => ({ status: 200, body: { workspaces: [{ id: DST, name: 'Dial8', slug: 'dial8', role: 'owner' }] } })
    await render()
    expect(container.querySelectorAll('button[data-source-id]')).toHaveLength(0)
    expect(container.textContent).toMatch(/not the owner of another workspace/i)
  })

  it('picking a source runs the preflight with the destination pinned and shows the review', async () => {
    await render()
    await pickSource()
    expect(preflightCalls()).toHaveLength(1)
    expect(preflightCalls()[0].body).toEqual({ source_workspace_id: SRC, destination_workspace_id: DST })
    const tiles = [...container.querySelectorAll('[data-testid="merge-count"]')].map((d) => d.textContent)
    expect(tiles).toEqual(['12actions', '3captures'])
    expect(container.textContent).toContain('…and everything attached to them.')
    expect(container.textContent).toContain('1 person joins this workspace as member.')
    expect(container.textContent).toContain('Arrives as its own team, “Coherix” (COH)')
    expect(container.textContent).toContain('Labels: 2 match by name, 1 is created here.')
    expect(mergeButton().disabled).toBe(true)
  })

  it('a blocked preflight explains why, keeps the merge disabled however the name is typed, and can be checked again', async () => {
    let blocked = true
    preflightResponse = () =>
      blocked
        ? { status: 200, body: { ...PREFLIGHT, ok: false, blockers: [{ code: 'source_busy', detail: { live_captures: [{ id: 'c1', title: 'Standup' }], agent_runs: 0, flow_runs: 0, tracked_jobs: 0 } }] } }
        : { status: 200, body: PREFLIGHT }
    await render()
    await pickSource()
    expect(container.textContent).toContain('The merge cannot start yet')
    expect(container.textContent).toContain('A capture is still recording: “Standup”. Stop it first.')
    await act(async () => type(confirmInput(), 'Coherix'))
    expect(mergeButton().disabled).toBe(true)

    blocked = false
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-testid="check-again"]')!.click())
    await flush()
    expect(preflightCalls()).toHaveLength(2)
    expect(preflightCalls()[1].body).toMatchObject({ plan: { teams: [{ source_team_id: 't1', mode: 'own' }] } })
    expect(container.textContent).not.toContain('The merge cannot start yet')
    expect(mergeButton().disabled).toBe(false)
  })

  it('choosing to fold a team re-plans with choices only, and the row then says where it folds', async () => {
    await render()
    await pickSource()
    preflightResponse = () => ({ status: 200, body: FOLDED })
    expect([...teamSelect().options].map((o) => o.value)).toEqual(['own', 'fold:d-eng'])
    await chooseTeam('t1', 'fold:d-eng')
    expect(preflightCalls()).toHaveLength(2)
    expect(preflightCalls()[1].body).toEqual({
      source_workspace_id: SRC,
      destination_workspace_id: DST,
      plan: { teams: [{ source_team_id: 't1', mode: 'fold', destination_team_id: 'd-eng' }] },
    })
    expect(container.textContent).toContain('Folds into Engineering (ENG); 2 identifiers are renumbered.')
    expect(teamSelect().value).toBe('fold:d-eng')
  })

  it('a re-plan the server refuses puts the choice back to what the plan will use, with the reason only for an invalid plan', async () => {
    await render()
    await pickSource()
    preflightResponse = () => ({ status: 400, body: { error: 'That destination team has no default status; pick another team to fold into', code: 'BAD_REQUEST', details: { reason: 'destination team has no default workflow state' } } })
    await chooseTeam('t1', 'fold:d-eng')
    expect(teamSelect().value).toBe('own')
    expect(container.textContent).toContain('That destination team has no default status; pick another team to fold into')
    expect(container.textContent).not.toContain('destination team has no default workflow state')
    expect(teamSelect().disabled).toBe(false)

    preflightResponse = () => ({ status: 409, body: { error: 'The plan is not valid any more; review the teams and try again', code: 'PLAN_INVALID', details: { reason: 'team slug "eng" is already taken in the destination' } } })
    await chooseTeam('t1', 'fold:d-eng')
    expect(container.textContent).toContain('The plan is not valid any more; review the teams and try again (team slug "eng" is already taken in the destination).')
  })

  it('a private team folding into a public one is flagged', async () => {
    preflightResponse = () => ({ status: 200, body: { ...PREFLIGHT, teams: [{ ...TEAM, is_private: true }] } })
    await render()
    await pickSource()
    expect(container.textContent).toContain('Private')
    expect(container.textContent).not.toContain('opens its work')
    preflightResponse = () => ({ status: 200, body: { ...FOLDED, teams: [{ ...FOLDED.teams[0], is_private: true }] } })
    await chooseTeam('t1', 'fold:d-eng')
    expect(container.textContent).toContain('This team is private: folding it into Engineering opens its work to that team’s members.')
  })

  it('says when the fold targets could not be loaded', async () => {
    teamsResponse = () => ({ status: 500, body: { error: 'down' } })
    await render()
    await pickSource()
    expect([...teamSelect().options].map((o) => o.value)).toEqual(['own'])
    expect(container.textContent).toContain('Could not load this workspace’s teams')
  })

  it('a failed re-plan puts the team picker back to the plan the merge would still send', async () => {
    await render()
    await pickSource()
    preflightResponse = () => ({ status: 500, body: { error: 'Could not plan the merge.' } })
    const select = container.querySelector<HTMLSelectElement>('select[data-team-id="t1"]')!
    await act(async () => {
      select.value = 'fold:d-eng'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(preflightCalls()).toHaveLength(2)
    expect(container.textContent).toContain('Could not plan the merge.')
    expect(container.querySelector<HTMLSelectElement>('select[data-team-id="t1"]')!.value).toBe('own')
  })

  it('the typed name gates the merge by the route’s rule, and the merge sends the preflight’s normalised plan', async () => {
    await render()
    await pickSource()
    await act(async () => type(confirmInput(), 'Coher'))
    expect(mergeButton().disabled).toBe(true)
    await act(async () => type(confirmInput(), ' coherix '))
    expect(mergeButton().disabled).toBe(false)

    await act(async () => mergeButton().click())
    await flush()
    expect(mergeCalls()).toHaveLength(1)
    expect(mergeCalls()[0].body).toEqual({
      source_workspace_id: SRC,
      destination_workspace_id: DST,
      plan: PREFLIGHT.plan,
      confirm_name: ' coherix ',
    })
    expect(container.textContent).toContain('Merged')
    expect(container.textContent).toContain('12 actions came over.')
    expect(container.textContent).toContain('1 person was told.')
    await tick()
    expect(hoisted.finish).toHaveBeenCalledWith(SRC, DST)
  })

  it('a recording in this window keeps the merge disabled and says why', async () => {
    hoisted.recording = true
    await render()
    await pickSource()
    await act(async () => type(confirmInput(), 'Coherix'))
    expect(mergeButton().disabled).toBe(true)
    expect(container.textContent).toContain('Stop the recording first')
  })

  it('while merging, the sheet has no way to close, says what is happening, and the window will not reload for a deploy', async () => {
    let release!: (r: Reply) => void
    mergeResponse = () => new Promise<Reply>((r) => (release = r))
    await render()
    await pickSource()
    await typeAndMerge()
    expect(cancelButton()).toBeNull()
    expect(closeButton()).toBeNull()
    expect(container.querySelector('button[data-testid="merge-confirm"]')).toBeNull()
    expect(container.querySelector('[data-testid="merging"]')!.textContent).toContain('Merging Coherix into Dial8')
    expect(container.textContent).toContain('0:00 elapsed')
    expect(container.querySelector('[role="timer"]')!.textContent).toContain('elapsed')
    expect(container.textContent).toContain('This window stays open until the merge finishes.')
    expect(container.textContent).not.toContain('Stop the recording now')
    hoisted.recording = true
    await rerender({})
    expect(container.textContent).toContain('Stop the recording now; this window reloads when the merge finishes.')
    expect(hoisted.registerReloadBlocker).toHaveBeenCalled()
    const isBusy = hoisted.registerReloadBlocker.mock.calls[0][0]
    expect(isBusy()).toBe(true)

    await act(async () => release({ status: 200, body: MERGED }))
    await flush()
    expect(container.textContent).toContain('Merged into Dial8')
    expect(cancelButton()).toBeNull()
    expect(closeButton()).toBeNull()
  })

  it('a refusal stays inline, the sheet stays open, and nothing navigates', async () => {
    mergeResponse = () => ({ status: 409, body: { error: 'The source workspace is busy (a live capture or a running job); try again when it is idle', code: 'SOURCE_BUSY' } })
    await render()
    await pickSource()
    await typeAndMerge()
    expect(container.textContent).toContain('The source workspace is busy')
    // next to the buttons, in view however the review is scrolled
    expect(mergeButton().closest('.border-t')!.querySelector('[role="alert"]')!.textContent).toContain('The source workspace is busy')
    expect(container.querySelector('[data-testid="sheet"]')).toBeTruthy()
    expect(mergeButton()).toBeTruthy()
    await tick()
    expect(hoisted.finish).not.toHaveBeenCalled()
  })

  it('a blocked merge (the engine saw a blocker the preflight missed) shows the blockers it answered with', async () => {
    mergeResponse = () => ({
      status: 409,
      body: { error: 'The merge cannot start yet', code: 'MERGE_BLOCKED', details: { blockers: [{ code: 'drift', source: [{ check: 'x.y', violations: 2 }], destination: [] }] } },
    })
    await render()
    await pickSource()
    await typeAndMerge()
    expect(container.textContent).toContain('The other workspace fails 1 integrity check (x.y)')
    expect(mergeButton().disabled).toBe(true)
  })

  it('a stale plan keeps its explanation, plans again from the server’s defaults, and refetches the fold targets', async () => {
    mergeResponse = () => ({ status: 409, body: { error: 'The plan is not valid any more; review the teams and try again', code: 'PLAN_INVALID', details: { reason: 'plan names a team that is not in the source workspace' } } })
    await render()
    await pickSource()
    const teamsBefore = teamsCalls().length
    await typeAndMerge()
    await flush()
    expect(container.textContent).toContain('The plan is not valid any more; review the teams and try again (plan names a team that is not in the source workspace).')
    expect(preflightCalls()).toHaveLength(2)
    expect(preflightCalls()[1].body).toEqual({ source_workspace_id: SRC, destination_workspace_id: DST })
    expect(teamsCalls().length).toBe(teamsBefore + 1)
    await tick()
    expect(hoisted.finish).not.toHaveBeenCalled()
  })

  it('a lost answer whose source is gone counts as merged and lands in the destination', async () => {
    mergeResponse = () => ({ status: 0, body: {} })
    await render()
    await pickSource()
    listResponse = () => ({ status: 200, body: { workspaces: [{ id: DST, name: 'Dial8', slug: 'dial8', role: 'owner' }] } })
    await typeAndMerge()
    expect(container.textContent).toContain('Merged')
    expect(container.textContent).toContain('Everything came over.')
    await tick()
    expect(hoisted.finish).toHaveBeenCalledWith(SRC, DST)
  })

  it('a lost answer whose source is still there is an error to retry', async () => {
    mergeResponse = () => ({ status: 0, body: {} })
    await render()
    await pickSource()
    await typeAndMerge()
    expect(container.textContent).toContain('Request failed')
    expect(mergeButton()).toBeTruthy()
    await tick()
    expect(hoisted.finish).not.toHaveBeenCalled()
  })

  it('a preflight answer that arrives after the sheet was closed and reopened never fills the fresh sheet', async () => {
    let release!: (r: Reply) => void
    preflightResponse = () => new Promise<Reply>((r) => (release = r))
    await render()
    await pickSource()
    expect(container.textContent).toContain('Checking what the merge would do')
    await rerender({ open: false })
    await rerender({ open: true })
    await act(async () => release({ status: 200, body: PREFLIGHT }))
    await flush()
    expect(container.querySelector('button[data-source-id]')).toBeTruthy()
    expect(container.textContent).not.toContain('What moves over')
  })
})
