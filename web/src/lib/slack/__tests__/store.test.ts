/**
 * Binding a Slack team (store.ts bindInstallation), as the install's callback
 * uses it: adding the app again to a team live in the same workspace re-binds
 * that row in place, so its people's links (and channel threads, which hang
 * off the row by cascade) are kept; a revoked row here comes back to life with
 * its links; a revoked row of another workspace is replaced; a live row of
 * another workspace is refused. Every id here is made up.
 */
import { describe, expect, it } from 'vitest'
import { bindInstallation, type BindInstallationInput } from '../store'

const TEAM = 'T0MADEUP1'
const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

type Row = Record<string, unknown>

function fakeSvc(existing: Row | null) {
  const calls: Array<{ op: string; payload?: Row; filters: Array<[string, unknown]> }> = []
  const from = () => {
    let op = 'select'
    let payload: Row | undefined
    const filters: Array<[string, unknown]> = []
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push([col, v]), b),
      update: (row: Row) => ((op = 'update'), (payload = row), b),
      delete: () => ((op = 'delete'), b),
      insert: (row: Row) => ((op = 'insert'), (payload = row), b),
      maybeSingle: async () => ({ data: existing, error: null }),
      then: (resolve: (v: unknown) => void) => {
        calls.push({ op, payload, filters })
        resolve({ data: null, error: null })
      },
    }
    return b
  }
  return { svc: { from } as never, calls }
}

const input: BindInstallationInput = {
  teamId: TEAM,
  teamName: 'Acme',
  teamDomain: 'acme',
  enterpriseId: null,
  workspaceId: WS,
  userId: USER,
  botUserId: 'U0BOT0001',
}
const row = (over: Row) => ({ slack_team_id: TEAM, workspace_id: WS, status: 'active', ...over })

describe('bindInstallation', () => {
  it('added again to a team live in this workspace: the row is updated in place, never deleted (its links stay)', async () => {
    const { svc, calls } = fakeSvc(row({}))
    expect(await bindInstallation(svc, input)).toEqual({ ok: true, rebound: false })
    expect(calls.map((c) => c.op)).toEqual(['update'])
    expect(calls[0].filters).toEqual([
      ['slack_team_id', TEAM],
      ['workspace_id', WS],
    ])
    expect(calls[0].payload).toMatchObject({ status: 'active', team_name: 'Acme', bot_user_id: 'U0BOT0001', revoked_at: null })
  })

  it('a revoked row of this workspace comes back to life in place (rebound), links kept', async () => {
    const { svc, calls } = fakeSvc(row({ status: 'revoked' }))
    expect(await bindInstallation(svc, input)).toEqual({ ok: true, rebound: true })
    expect(calls.map((c) => c.op)).toEqual(['update'])
  })

  it('a revoked row of another workspace is replaced; a live one there is refused', async () => {
    const revoked = fakeSvc(row({ workspace_id: OTHER_WS, status: 'revoked' }))
    expect(await bindInstallation(revoked.svc, input)).toEqual({ ok: true, rebound: false })
    expect(revoked.calls.map((c) => c.op)).toEqual(['delete', 'insert'])

    const live = fakeSvc(row({ workspace_id: OTHER_WS }))
    expect(await bindInstallation(live.svc, input)).toEqual({ ok: false, reason: 'other_workspace' })
    expect(live.calls).toEqual([])
  })
})
