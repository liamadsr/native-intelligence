// @vitest-environment jsdom
/**
 * The Teams panel's AI teammate rows (teams-view.tsx): who gets the Edit and
 * Remove menu, and what a row says about a persona or skill the viewer can't
 * read.
 *
 *   • Workspace owners and admins, and this team's leads, may edit and remove
 *     its AI teammates (ai_team_member's RLS). Anyone else sees no menu; the
 *     routes still decide (403). Who's looking comes from the workspace read
 *     the panel already makes (`currentRole`, `currentMemberId`).
 *   • Another creator's personal persona reads "Private persona", and the
 *     skill count counts the private skills too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [], refetchTeams: vi.fn() }) }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))

import { TeamsView } from '../teams-view'

const RILEY = {
  id: 'ai-riley',
  name: 'Riley',
  avatar_url: null,
  team_role: 'member',
  created_at: '2026-09-01T00:00:00Z',
  is_system: false,
  system_key: null,
  bot_character: 'chat',
  agent: { id: 'r-1', name: 'Researcher persona', icon: null, color: null },
  skills: [{ id: 's-1', name: 'Summarize', icon: null, color: null }],
  agent_recipe_id: 'r-1',
  skill_recipe_ids: ['s-1'],
}

const QUILL = {
  ...RILEY,
  id: 'ai-quill',
  name: 'Quill',
  bot_character: 'writer',
  // Built on another creator's personal persona, with one of their personal skills.
  agent: null,
  agent_recipe_id: 'r-private',
  skill_recipe_ids: ['s-private', 's-1'],
}

let viewer: { currentRole: string; currentMemberId: string }
let teamMembers: Array<{ team_member_id: string; member_id: string; team_role: string }>

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  viewer = { currentRole: 'member', currentMemberId: 'm-me' }
  teamMembers = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/account/teams/team-1') {
        return json({
          team: { id: 'team-1', name: 'Growth', slug: 'growth', icon: null, issue_prefix: 'GRO', issue_counter: 1, is_private: false, timezone: 'UTC', created_at: '', updated_at: '' },
        })
      }
      if (url === '/api/account/teams/team-1/members') {
        return json({
          members: teamMembers.map((m) => ({ ...m, joined_at: '', display_name: m.member_id, avatar_url: null, workspace_role: 'member', email: '' })),
        })
      }
      if (url === '/api/account/teams/team-1/ai-members') return json({ aiMembers: [RILEY, QUILL], workspace_faces: [] })
      if (url === '/api/account/workspace') return json({ members: [], ...viewer })
      if (url.startsWith('/api/account/workflow-states')) return json({ states: [] })
      if (url === '/api/account/flows') return json({ flows: [] })
      return json({})
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => {
    root.render(<TeamsView onOpenTeamBoard={() => {}} initialTeamId="team-1" />)
  })
  await act(async () => {})
}

const menuFor = (name: string) => container.querySelector(`[aria-label="${name} options"]`)

describe('Teams panel: the AI teammate menu', () => {
  it('is hidden from a workspace member who doesn’t lead the team', async () => {
    teamMembers = [{ team_member_id: 'tm-1', member_id: 'm-me', team_role: 'member' }]
    await render()
    expect(container.textContent).toContain('Riley')
    expect(menuFor('Riley')).toBeNull()
    expect(menuFor('Quill')).toBeNull()
  })

  it.each([['owner'], ['admin']])('shows for a workspace %s', async (role) => {
    viewer = { currentRole: role, currentMemberId: 'm-me' }
    await render()
    expect(menuFor('Riley')).not.toBeNull()
    expect(menuFor('Quill')).not.toBeNull()
  })

  it('shows for a lead of this team who is only a member of the workspace', async () => {
    teamMembers = [{ team_member_id: 'tm-1', member_id: 'm-me', team_role: 'lead' }]
    await render()
    expect(menuFor('Riley')).not.toBeNull()
  })

  it('a lead’s role on another member doesn’t count', async () => {
    teamMembers = [{ team_member_id: 'tm-2', member_id: 'm-someone', team_role: 'lead' }]
    await render()
    expect(menuFor('Riley')).toBeNull()
  })
})

describe('Teams panel: a persona or skill the viewer can’t read', () => {
  it('reads "Private persona", and counts every skill', async () => {
    await render()
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Researcher persona · 1 skill')
    expect(text).toContain('Private persona · 2 skills')
  })
})
