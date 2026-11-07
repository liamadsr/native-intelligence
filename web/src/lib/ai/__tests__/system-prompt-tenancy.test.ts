/**
 * buildSystemPrompt runs on a SERVICE-ROLE client for every caller (eve chat,
 * skill runs, work runs), so nothing it reads is fenced by RLS:
 *   - client-supplied attachedProjectIds are read only inside the caller's
 *     workspace (options.workspaceId), and not at all without one;
 *   - the "Key contacts" summary drops contacts the user cannot see
 *     (contact_visible_to);
 *   - the member id and the key contacts come from the caller's workspace
 *     (options.workspaceId), not whichever workspace the user joined first.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildSystemPrompt } from '../system-prompt'

type Row = Record<string, unknown>

function fakeSupabase(tables: Record<string, Row[]>, hiddenContacts: string[] = []) {
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let limitN = Infinity
    const run = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r))).slice(0, limitN)
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.order = () => c
    c.eq = (col: string, v: unknown) => (preds.push((r) => r[col] === v), c)
    c.is = (col: string, v: unknown) => (preds.push((r) => (r[col] ?? null) === v), c)
    c.in = (col: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[col])), c)
    c.limit = (n: number) => ((limitN = n), c)
    c.single = async () => ({ data: run()[0] ?? null, error: null })
    c.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve)
    return c
  }
  const rpc = vi.fn(async (_fn: string, args: { p_contact_id: string }) => ({
    data: !hiddenContacts.includes(args.p_contact_id),
    error: null,
  }))
  return { from, rpc } as never
}

const TABLES = {
  member: [{ id: 'm1', user_id: 'u1', workspace_id: 'ws-1', display_name: 'Liam' }],
  projects: [
    { id: 'p-own', workspace_id: 'ws-1', name: 'OwnProject', description: 'mine' },
    { id: 'p-foreign', workspace_id: 'ws-other', name: 'ForeignProject', description: 'secret roadmap' },
  ],
  contact: [
    { id: 'c-shared', workspace_id: 'ws-1', full_name: 'Shared Person', relationship_strength: 'strong', merged_into_contact_id: null },
    { id: 'c-private', workspace_id: 'ws-1', full_name: 'Private Person', relationship_strength: 'warm', merged_into_contact_id: null },
  ],
}

describe('buildSystemPrompt tenancy on a service-role client', () => {
  it('reads attached projects only inside the caller workspace', async () => {
    const prompt = await buildSystemPrompt(
      'u1',
      fakeSupabase(TABLES),
      { attachedProjectIds: ['p-own', 'p-foreign'] },
      { webAccess: 'never', workspaceId: 'ws-1' },
    )
    expect(prompt).toContain('OwnProject')
    expect(prompt).not.toContain('ForeignProject')
    expect(prompt).not.toContain('secret roadmap')
  })

  it('renders no attached-projects block when every attached id is another workspace’s', async () => {
    const prompt = await buildSystemPrompt('u1', fakeSupabase(TABLES), { attachedProjectIds: ['p-foreign'] }, {
      webAccess: 'never',
      workspaceId: 'ws-1',
    })
    expect(prompt).not.toContain('Attached projects')
    expect(prompt).not.toContain('ForeignProject')
  })

  it("drops another member's private contact from Key contacts", async () => {
    const prompt = await buildSystemPrompt('u1', fakeSupabase(TABLES, ['c-private']), undefined, {
      webAccess: 'never',
      workspaceId: 'ws-1',
    })
    expect(prompt).toContain('Shared Person')
    expect(prompt).not.toContain('Private Person')
  })

  // A user in two workspaces has a member row in each. The row listed first
  // used to win, so a chat in ws-1 could name ws-other's member id (the
  // assignee for "assign it to me") and ws-other's contacts.
  const TWO_WORKSPACES = {
    ...TABLES,
    member: [
      { id: 'm-other', user_id: 'u1', workspace_id: 'ws-other', display_name: 'Liam' },
      { id: 'm1', user_id: 'u1', workspace_id: 'ws-1', display_name: 'Liam' },
    ],
    contact: [
      ...TABLES.contact,
      { id: 'c-other', workspace_id: 'ws-other', full_name: 'Other Workspace Person', relationship_strength: 'strong', merged_into_contact_id: null },
    ],
  }

  it("names the caller workspace's member row and contacts, not another workspace's", async () => {
    const prompt = await buildSystemPrompt('u1', fakeSupabase(TWO_WORKSPACES), undefined, {
      webAccess: 'never',
      workspaceId: 'ws-1',
    })
    expect(prompt).toContain("User's workspace member ID: m1 ")
    expect(prompt).not.toContain('m-other')
    expect(prompt).toContain('Shared Person')
    expect(prompt).not.toContain('Other Workspace Person')
  })

  it('names no member id and no contacts when the user is not a member of the caller workspace', async () => {
    const prompt = await buildSystemPrompt('u1', fakeSupabase(TWO_WORKSPACES), undefined, {
      webAccess: 'never',
      workspaceId: 'ws-3',
    })
    expect(prompt).not.toContain('member ID')
    expect(prompt).not.toContain('Key contacts')
  })

  it('each workspace gets its own member row and contacts, whichever row is listed first', async () => {
    const other = await buildSystemPrompt('u1', fakeSupabase(TWO_WORKSPACES), undefined, {
      webAccess: 'never',
      workspaceId: 'ws-other',
    })
    expect(other).toContain("User's workspace member ID: m-other ")
    expect(other).toContain('Other Workspace Person')
    expect(other).not.toContain('Shared Person')
    const reversed = { ...TWO_WORKSPACES, member: [...TWO_WORKSPACES.member].reverse() }
    const own = await buildSystemPrompt('u1', fakeSupabase(reversed), undefined, {
      webAccess: 'never',
      workspaceId: 'ws-1',
    })
    expect(own).toContain("User's workspace member ID: m1 ")
    expect(own).not.toContain('Other Workspace Person')
  })
})
