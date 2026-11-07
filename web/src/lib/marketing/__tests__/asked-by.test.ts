/**
 * "You asked, we shipped" (marketing M2, P9: asked-by.ts): who asked for the
 * shipped work, through the calls it came from or is linked to, the claims
 * about it and the contacts linked to it; never a member, never someone
 * else's private call; and the drafts kept to exactly those people.
 */
import { describe, it, expect } from 'vitest'
import { askerAddresses, loadAskedBy, onlyToAskers, renderAskedByBlock, renderShippedBlock } from '../asked-by'
import { lensFakeDb } from '@/lib/flows/__tests__/lens-fake-db'

const WS = 'ws-1'
const seed = () => ({
  member: [{ id: 'm-1', workspace_id: WS, user_id: 'u-1', role: 'admin' }],
  team: [
    { id: '7e000000-0000-4000-8000-000000000001', workspace_id: WS, is_private: false },
    { id: '7e000000-0000-4000-8000-000000000009', workspace_id: WS, is_private: true },
  ],
  team_member: [],
  actions: [
    { id: 'a-1', workspace_id: WS, team_id: '7e000000-0000-4000-8000-000000000001', project_id: 'p-1', title: 'Calendar sync', source_capture_id: 'c-1' },
    { id: 'a-2', workspace_id: WS, team_id: '7e000000-0000-4000-8000-000000000001', project_id: 'p-1', title: 'Time zones', source_capture_id: null },
    // A private team's work in the same project: its owner can't see it, so it never counts.
    { id: 'a-3', workspace_id: WS, team_id: '7e000000-0000-4000-8000-000000000009', project_id: 'p-1', title: 'Secret acquisition prep', source_capture_id: 'c-9' },
  ],
  entity_link: [
    // A claim about the project, resting on another call.
    { workspace_id: WS, source_type: 'claim', source_id: 'cl-1', target_type: 'project', target_id: 'p-1' },
    // A contact linked to an action directly.
    { workspace_id: WS, source_type: 'action', source_id: 'a-2', target_type: 'contact', target_id: 'ct-3' },
    // Someone else's private call, linked to the project: never read.
    { workspace_id: WS, source_type: 'capture', source_id: 'c-9', target_type: 'project', target_id: 'p-1' },
  ],
  claim: [{ id: 'cl-1', workspace_id: WS, text: 'Globex needs calendar sync before they roll out' }],
  claim_source: [{ claim_id: 'cl-1', source_type: 'capture', source_id: 'c-2' }],
  captures: [
    { id: 'c-1', workspace_id: WS, title: 'Acme weekly', created_at: '2026-10-02T10:00:00Z', visibility: 'workspace', user_id: 'u-9', is_eval: false },
    { id: 'c-2', workspace_id: WS, title: 'Globex intro', created_at: '2026-10-05T10:00:00Z', visibility: 'private', user_id: 'u-1', is_eval: false },
    { id: 'c-9', workspace_id: WS, title: 'Secret', created_at: '2026-10-06T10:00:00Z', visibility: 'private', user_id: 'u-9', is_eval: false },
  ],
  capture_participant: [
    { capture_id: 'c-1', member_id: null, is_self: false, external_name: 'Dana Whitlock', external_email: null, contact_id: 'ct-1', company: null },
    { capture_id: 'c-1', member_id: 'm-1', is_self: false, external_name: null, external_email: null, contact_id: null, company: null },
    { capture_id: 'c-2', member_id: null, is_self: false, external_name: 'Priya Raman', external_email: 'priya@globex.example', contact_id: null, company: 'Globex' },
    // An outside guest who is really a teammate's address: never written to.
    { capture_id: 'c-2', member_id: null, is_self: false, external_name: 'Sam', external_email: 'sam@dial8.example', contact_id: null, company: null },
    { capture_id: 'c-9', member_id: null, is_self: false, external_name: 'Hidden', external_email: 'hidden@x.example', contact_id: null, company: null },
  ],
  contact: [
    { id: 'ct-1', workspace_id: WS, full_name: 'Dana Whitlock', email: 'dana@acme.example', company_id: 'co-1' },
    { id: 'ct-3', workspace_id: WS, full_name: 'Lee Park', email: 'lee@initech.example', company_id: null },
  ],
  company: [{ id: 'co-1', workspace_id: WS, name: 'Acme' }],
})

const members = async (_ws: string, emails: string[]) => new Map(emails.filter((e) => e === 'sam@dial8.example').map((e) => [e, {}]))

describe('loadAskedBy', () => {
  it('finds who asked: the call the work came from, a claim’s call, a linked contact; never a member or someone else’s private call', async () => {
    const { client } = lensFakeDb(seed())
    const m = await loadAskedBy(client, { workspaceId: WS, runAsUserId: 'u-1', entity: { kind: 'project', id: 'p-1', title: 'Calendar', description: null }, memberEmails: members })
    expect(m.parts).toEqual(['Calendar sync', 'Time zones'])
    expect(m.askers).toEqual([
      { name: 'Dana Whitlock', email: 'dana@acme.example', company: 'Acme', via: 'on the call "Acme weekly" (Oct 2)', about: null },
      { name: 'Priya Raman', email: 'priya@globex.example', company: 'Globex', via: 'on the call "Globex intro" (Oct 5)', about: 'Globex needs calendar sync before they roll out' },
      { name: 'Lee Park', email: 'lee@initech.example', company: null, via: 'linked to the work', about: null },
    ])
    expect(askerAddresses(m)).not.toContain('hidden@x.example')
  })

  it('the run’s owner not a member: nobody is found (the fence fails closed)', async () => {
    const { client } = lensFakeDb({ ...seed(), member: [] })
    const m = await loadAskedBy(client, { workspaceId: WS, runAsUserId: 'u-1', entity: { kind: 'project', id: 'p-1', title: 'Calendar', description: null }, memberEmails: members })
    expect(m.askers).toEqual([])
  })

  it('nobody asked: the block says return no drafts', async () => {
    const { client } = lensFakeDb({ member: [{ id: 'm-1', workspace_id: WS, user_id: 'u-1', role: 'admin' }], team: [], team_member: [], actions: [{ id: 'a-5', workspace_id: WS, title: 'Refactor', source_capture_id: null }] })
    const m = await loadAskedBy(client, { workspaceId: WS, runAsUserId: 'u-1', entity: { kind: 'action', id: 'a-5', title: 'Refactor', identifier: 'ENG-5' }, memberEmails: members })
    expect(m.askers).toEqual([])
    expect(renderAskedByBlock(m)).toContain('Return an empty list of drafts')
  })
})

describe('the drafts go only to the people who asked', () => {
  it('a draft to anyone else is refused, with the reason', () => {
    const out = onlyToAskers(
      [
        { to: ['dana@acme.example'], cc: [] },
        { to: ['dana@acme.example'], cc: ['boss@acme.example'] },
        { to: ['stranger@evil.example'], cc: [] },
      ],
      ['DANA@acme.example'],
    )
    expect(out.items).toHaveLength(1)
    expect(out.refused).toEqual(['the draft to boss@acme.example: not someone who asked for this', 'the draft to stranger@evil.example: not someone who asked for this'])
  })

  it('a note never names ANOTHER customer (S6); its own recipient’s company is fine', () => {
    const askers = [
      { email: 'dana@acme.example', name: 'Dana Whitlock', company: 'Acme Robotics' },
      { email: 'priya@globex.example', name: 'Priya Raman', company: 'Globex Logistics' },
    ]
    const out = onlyToAskers(
      [
        { to: ['dana@acme.example'], cc: [], subject: 'Calendar sync is live', body: 'Hi Dana, the Acme Robotics rollout can start: calendar sync shipped.' },
        { to: ['dana@acme.example'], cc: [], subject: 'Live', body: 'Hi Dana, Globex Logistics asked for this too, and it shipped.' },
        { to: ['priya@globex.example'], cc: [], subject: 'For Priya', body: 'Dana Whitlock mentioned you on a call.' },
      ],
      askers,
    )
    expect(out.items.map((d) => d.subject)).toEqual(['Calendar sync is live'])
    expect(out.refused).toEqual(['the draft to dana@acme.example: it names another customer', 'the draft to priya@globex.example: it names another customer'])
  })

  it('the block names each person and asks for one email each, nothing sent', () => {
    const block = renderAskedByBlock({ shipped: { kind: 'action', id: 'a-1', title: 'Calendar sync', identifier: 'ENG-42' }, parts: [], askers: [{ name: 'Dana', email: 'dana@acme.example', company: 'Acme', via: 'linked to the work', about: null }] })
    expect(block).toContain('- action: ENG-42 Calendar sync')
    expect(block).toContain('- Dana <dana@acme.example>, Acme: linked to the work')
    expect(block).toContain('Write ONE short email to each person above, only them')
    expect(block).toContain('Nothing is sent')
  })

  it('the launch kit reads only what shipped, never who asked', () => {
    const block = renderShippedBlock({ kind: 'project', id: 'p-1', title: 'Calendar', description: 'Two-way sync with Google and Outlook.' })
    expect(block).toContain('- project: Calendar')
    expect(block).not.toContain('asked')
    expect(block).toContain('Never a customer, a company, a name or a deal')
  })
})
