/**
 * The pure pieces under the merge dialog: the plan sent back to the preflight
 * (choices only), the <select> round trip, the typed-name rule, and the
 * sentences built from the preflight's numbers.
 */
import { describe, it, expect } from 'vitest'
import { choiceOf, choiceValue, choicesOf, parseChoice, planFromChoices } from '../plan'
import { collisionLines, confirmNameMatches, defaultCloudLines, describeBlockers, integrationLines, mergeCountsLine, peopleLines, teamLine } from '../wording'
import type { PreflightCollisions, PreflightTeam } from '../types'

const team = (over: Partial<PreflightTeam> = {}): PreflightTeam => ({
  source_team_id: 't1',
  source_name: 'General',
  source_slug: 'general',
  source_prefix: 'GEN',
  is_private: false,
  is_first: true,
  actions: 12,
  members: 2,
  collides: { slug: true, prefix: true },
  mode: 'own',
  destination_team_id: null,
  name: 'Coherix',
  slug: 'coherix',
  prefix: 'COH',
  identifiers: { reprefixed: 12, renumbered: 0 },
  states_remapped: [],
  active_cycle_conflict: false,
  destination_team: null,
  ...over,
})

describe('the plan', () => {
  it('sends choices only: own teams carry no name, folds carry their destination', () => {
    const teams = [team(), team({ source_team_id: 't2', source_name: 'Design' })]
    const plan = planFromChoices(teams, { t2: { mode: 'fold', destination_team_id: 'd-eng' } })
    expect(plan).toEqual({
      teams: [
        { source_team_id: 't1', mode: 'own' },
        { source_team_id: 't2', mode: 'fold', destination_team_id: 'd-eng' },
      ],
    })
  })

  it('reads the current choice off a preflight row and round-trips the <select> value', () => {
    expect(choiceOf(team())).toEqual({ mode: 'own' })
    expect(choiceOf(team({ mode: 'fold', destination_team_id: 'd-eng' }))).toEqual({ mode: 'fold', destination_team_id: 'd-eng' })
    expect(choicesOf([team(), team({ source_team_id: 't2', mode: 'fold', destination_team_id: 'd-eng' })])).toEqual({
      t1: { mode: 'own' },
      t2: { mode: 'fold', destination_team_id: 'd-eng' },
    })
    expect(choiceValue({ mode: 'own' })).toBe('own')
    expect(choiceValue({ mode: 'fold', destination_team_id: 'd-eng' })).toBe('fold:d-eng')
    expect(parseChoice('fold:d-eng')).toEqual({ mode: 'fold', destination_team_id: 'd-eng' })
    expect(parseChoice('own')).toEqual({ mode: 'own' })
    expect(parseChoice('fold:')).toEqual({ mode: 'own' })
    expect(parseChoice('garbage')).toEqual({ mode: 'own' })
  })
})

describe('confirmNameMatches', () => {
  it('is the route’s rule: case and surrounding spaces aside, never empty', () => {
    expect(confirmNameMatches('Coherix', 'coherix')).toBe(true)
    expect(confirmNameMatches('Coherix', '  Coherix ')).toBe(true)
    expect(confirmNameMatches('Coherix', 'Coherix Inc')).toBe(false)
    expect(confirmNameMatches('Coherix', '')).toBe(false)
    expect(confirmNameMatches('', '')).toBe(false)
  })
})

describe('the wording', () => {
  it('counts: the tables people recognise, biggest first', () => {
    expect(mergeCountsLine({ actions: 12, captures: 1, member: 3, agent_log: 999 })).toBe('12 actions, 1 capture')
    expect(mergeCountsLine({})).toBe('')
  })

  it('blockers: recordings by title, running jobs by count, drift by side', () => {
    const lines = describeBlockers([
      { code: 'source_busy', detail: { live_captures: [{ id: 'c1', title: 'Standup' }], agent_runs: 2, flow_runs: 1, tracked_jobs: 1 } },
      { code: 'drift', source: [{ check: 'actions.team', violations: 1 }], destination: [] },
    ])
    expect(lines).toEqual([
      'A capture is still recording: “Standup”. Stop it first.',
      '2 agent runs are still going. Wait for them to finish.',
      // 417: a loop run counts only while it is parked on an approval card
      '1 loop run is waiting on an approval card. Accept or skip it first.',
      '1 background job is in progress. Wait for them to finish.',
      'The other workspace fails 1 integrity check (actions.team). The repair has to run first; nothing was changed.',
    ])
  })

  it('people: who joins, who is already here, what happens to invites', () => {
    expect(
      peopleLines({
        joining: [{ user_id: 'u1', display_name: 'A', role: 'admin' }, { user_id: 'u2', display_name: 'B', role: 'member' }],
        in_both: [{ user_id: 'u3', display_name: 'C' }],
        destination_members: 4,
        invites_moving: 1,
        invites_dropped: 2,
      }),
    ).toEqual([
      '2 people join this workspace as admin or member.',
      '1 person is already here; each keeps the higher of their two roles.',
      '1 pending invite moves over.',
      '2 invites are dropped (already a member here, already invited, or expired).',
    ])
  })

  it('teams: an own team names its new prefix and renaming; a fold names the destination, renumbering and statuses', () => {
    expect(teamLine(team())).toBe('Arrives as its own team, “Coherix” (COH); 12 identifiers change GEN- to COH-, numbers kept; renamed from “General” (a team here has that name).')
    expect(
      teamLine(
        team({
          mode: 'fold',
          destination_team_id: 'd',
          destination_team: { id: 'd', name: 'Engineering', prefix: 'ENG' },
          identifiers: { reprefixed: 0, renumbered: 3 },
          states_remapped: [{ from: 'Blocked', to: null, actions: 2 }],
          active_cycle_conflict: true,
        }),
      ),
    ).toBe('Folds into Engineering (ENG); 3 identifiers are renumbered; “Blocked” → “the default status” (2); both teams have an active cycle.')
  })

  it('integrations: what moves and where this workspace keeps its connection', () => {
    expect(
      integrationLines({
        tasks: [
          { provider: 'linear', source: true, destination: false, outcome: 'moves' },
          { provider: 'jira', source: true, destination: true, outcome: 'destination_wins', links_severed: 4 },
        ],
        crm: [{ provider: 'hubspot', source: true, destination: true, outcome: 'destination_wins', provider_ids_cleared: 10 }],
        connected_accounts: 1,
        account_links: 1,
        mcp_servers: 0,
        cloud_environments: 2,
        default_cloud_environment: {
          outcome: 'destination_keeps',
          source: { name: 'Locked down', network_access: 'restricted' },
          destination: { name: 'Default cloud', network_access: 'trusted' },
          source_loops: 3,
          projects_pinned: 2,
        },
        github_prs: 1,
      }),
    ).toEqual([
      'Linear task sync comes over.',
      'Jira: this workspace keeps its own connection; 4 linked tasks keep the link as a URL.',
      'HubSpot: this workspace keeps its own CRM connection; 10 synced records are unlinked from the provider.',
      '1 connected mail or calendar account comes over, with their sign-ins.',
      '2 cloud environments come over.',
      'This workspace keeps its default cloud environment, “Default cloud” (trusted network); the other workspace’s comes over as an ordinary one.',
      '2 projects from the other workspace with no environment of their own keep running in its default, “Locked down” (restricted network).',
      'The other workspace’s 3 loops run in this workspace’s default cloud environment, “Default cloud” (trusted network), from now on.',
      '1 linked pull request stays linked.',
    ])
  })

  it('the default cloud environment (migration 420): where the other workspace’s loops and projects run afterwards', () => {
    const src = { name: 'Locked down', network_access: 'restricted' }
    const dst = { name: 'Default cloud', network_access: 'trusted' }
    // Only the other workspace has one: it becomes this one's, and its loops and projects stay in it.
    expect(defaultCloudLines({ outcome: 'source_adopted', source: src, destination: null, source_loops: 2, projects_pinned: 1 })).toEqual([
      'The other workspace’s default cloud environment, “Locked down” (restricted network), becomes this workspace’s default.',
      '1 project from the other workspace with no environment of its own keeps running in its default, “Locked down” (restricted network).',
    ])
    // The other has none: its loops ran with no environment, and now run in this workspace's default.
    expect(defaultCloudLines({ outcome: 'none', source: null, destination: dst, source_loops: 1, projects_pinned: 0 })).toEqual([
      'The other workspace’s 1 loop runs in this workspace’s default cloud environment, “Default cloud” (trusted network), from now on.',
    ])
    // Neither has one, and nothing moves: nothing to say.
    expect(defaultCloudLines({ outcome: 'none', source: null, destination: null, source_loops: 4, projects_pinned: 0 })).toEqual([])
    // A preflight from before 420 has no field: nothing is said about it.
    const base = { tasks: [], crm: [], connected_accounts: 0, account_links: 0, mcp_servers: 0, cloud_environments: 1, github_prs: 0 }
    expect(integrationLines(base)).toEqual(['1 cloud environment comes over.'])
  })

  it('collisions: only what is non-zero, in plain words', () => {
    const c: PreflightCollisions = {
      contacts_folded: 3,
      companies_folded: 0,
      workspace_company_demoted: true,
      documents_canon_demoted: [{ id: 'd1', title: 'Product', canon_key: 'product' }],
      documents_reslugged: 1,
      views_reslugged: 1,
      recipes_reslugged: 0,
      packages_reslugged: 0,
      prospect_lists_renamed: 0,
      home_threads_demoted: 1,
      teammate_threads_demoted: 0,
      system_teammates_folded: 2,
      seeded_flows_dropped: 1,
      default_projects_folded: 0,
      thread_copies_folded: 0,
      account_links_deduped: 0,
      sequence_enrollments_exited: 0,
      singletons_dropped: { reminders: 2, meeting_goal: 0, environment_default: 1 },
    }
    expect(collisionLines(c)).toEqual([
      '3 contacts match by email and are folded into the ones here (undo stays possible).',
      'The other workspace’s own company becomes an ordinary company; this workspace keeps its own.',
      '1 canonical document exists here already (“Product”); the other copies stay as ordinary documents.',
      '2 documents, views, recipes or packages get a new link address (a name here is the same).',
      '1 home chat becomes an ordinary conversation; everyone keeps this workspace’s.',
      '2 built-in teammates are the same here; their work carries on under this workspace’s.',
      '1 seeded loop is dropped; this workspace’s run instead.',
      '3 per-person records that exist here already (reminders, goals, logs, default environments) are dropped.',
    ])
  })
})
