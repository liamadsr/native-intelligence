/**
 * The reminder pass — the 5-minute tick that turns a due public.reminder row
 * into a notification.
 *
 * The invariants under test are the ones that make a reminder trustworthy:
 *   • ONE fire per reminder — the delivered_at CAS is the double-fire guard, so
 *     a lost claim inserts nothing;
 *   • a reminder for a deleted entity is silently consumed, never delivered as
 *     an empty banner — but ONLY when the lookup actually succeeded; a failed
 *     title read must roll the claim back, never cancel (the two look identical
 *     in the title map alone, and cancelling loses a live reminder forever);
 *   • an insert failure ROLLS delivered_at back, so the fire is retried next
 *     tick rather than silently burned (the exact failure mode createNotification
 *     hides by swallowing insert errors — which is why the pass inserts directly);
 *   • EVERY fire-time read is bound to the reminder's OWN workspace. The pass is
 *     the one place in the reminder path running on the service client, so it
 *     re-derives the title, the capture visibility rule, and the recipient member
 *     itself rather than trusting a stamp on the row it is firing. There is no
 *     stored recipient column precisely because an owner-only UPDATE policy
 *     cannot stop a client from pointing one at a co-tenant's inbox.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ recordNoticeEvent: vi.fn(async (..._args: unknown[]) => 1) }))
vi.mock('@/lib/agent-events/notice', () => ({ recordNoticeEvent: hoisted.recordNoticeEvent }))

import { runReminderPass, type DueReminderRow } from '@/lib/reminders/dispatch'

const NOW = new Date('2026-08-06T12:00:00.000Z')

function reminder(overrides: Partial<DueReminderRow> = {}): DueReminderRow {
  return {
    id: 'rem-1',
    workspace_id: 'ws-1',
    user_id: 'user-1',
    entity_type: 'action',
    entity_id: 'act-1',
    remind_at: '2026-08-06T11:58:00.000Z',
    ...overrides,
  }
}

/** The member row the recipient join resolves by default. */
const MEMBERS = [{ id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' }]

interface FakeOptions {
  due: DueReminderRow[]
  /** Entity rows per table, e.g. { actions: [{ id: 'act-1', title: 'Ship it' }] }. */
  entities?: Record<string, Array<Record<string, unknown>>>
  /** member rows the (user_id, workspace_id) recipient join can see. */
  members?: Array<{ id: string; user_id: string; workspace_id: string }>
  /** Fail the recipient join (transient DB failure). */
  memberReadFails?: boolean
  /** Reminder ids whose claim CAS loses (another tick won). */
  claimLost?: string[]
  /** Fail every notification insert. */
  insertFails?: boolean
  /** Entity tables whose title read errors out (transient DB failure). */
  titleReadFails?: string[]
}

interface FakeState {
  inserts: Array<Record<string, unknown>>
  reminderUpdates: Array<{ values: Record<string, unknown>; filters: Record<string, unknown> }>
  /** Every read issued against an entity table, with the filters applied. */
  entityReads: Array<{ table: string; filters: Record<string, unknown> }>
  /** Every table the pass touched, in order. */
  tables: string[]
}

/**
 * Minimal PostgREST-shaped fake: enough chain surface for the pass's five query
 * shapes (due-scan, claim CAS, batched title/recipient reads,
 * notification insert). Follows the hand-rolled-fake style of the sibling cron
 * tests. Entity-table reads honour the recorded `workspace_id` filter so a
 * cross-tenant read is a MISS here exactly as it would be in Postgres.
 */
function mockSupabase(options: FakeOptions): { client: never; state: FakeState } {
  const state: FakeState = { inserts: [], reminderUpdates: [], entityReads: [], tables: [] }
  const claimLost = new Set(options.claimLost ?? [])
  const ENTITY_TABLES = new Set(['actions', 'projects', 'initiative', 'captures', 'document'])

  const client = {
    from(table: string) {
      state.tables.push(table)
      const filters: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {}

      const record = (key: string, value: unknown) => {
        filters[key] = value
        return chain
      }

      Object.assign(chain, {
        select: (_cols?: string) => chain,
        eq: (col: string, value: unknown) => record(col, value),
        is: (col: string, value: unknown) => record(col, value),
        lte: (col: string, value: unknown) => record(`lte:${col}`, value),
        in: (col: string, values: unknown[]) => record(`in:${col}`, values),
        order: () => chain,
        limit: () => chain,
        update(values: Record<string, unknown>) {
          const updateChain: Record<string, unknown> = {}
          Object.assign(updateChain, {
            eq: (col: string, value: unknown) => {
              filters[col] = value
              return updateChain
            },
            is: (col: string, value: unknown) => {
              filters[col] = value
              return updateChain
            },
            select: async () => {
              state.reminderUpdates.push({ values, filters: { ...filters } })
              const id = filters.id as string
              return claimLost.has(id)
                ? { data: [], error: null }
                : { data: [{ id }], error: null }
            },
            // Rollback path awaits the update directly (no .select()).
            then: (resolve: (v: unknown) => void) => {
              state.reminderUpdates.push({ values, filters: { ...filters } })
              return Promise.resolve({ data: null, error: null }).then(resolve)
            },
          })
          return updateChain
        },
        async insert(values: Record<string, unknown>) {
          if (options.insertFails) {
            return { data: null, error: { message: 'check constraint violated' } }
          }
          state.inserts.push(values)
          return { data: null, error: null }
        },
        // The due-scan / batched reads are awaited at the end of the chain.
        then(resolve: (v: unknown) => void) {
          if (options.titleReadFails?.includes(table)) {
            return Promise.resolve({
              data: null,
              error: { message: 'statement timeout' },
            }).then(resolve)
          }
          if (table === 'member' && options.memberReadFails) {
            return Promise.resolve({
              data: null,
              error: { message: 'statement timeout' },
            }).then(resolve)
          }

          let data: unknown
          if (table === 'reminder') {
            data = options.due
          } else if (table === 'member') {
            // The pass reads a (user_id × workspace_id) cross-product and pairs
            // it up itself, so the fake applies both `in` filters honestly.
            const users = (filters['in:user_id'] as string[] | undefined) ?? []
            const workspaces = (filters['in:workspace_id'] as string[] | undefined) ?? []
            data = (options.members ?? MEMBERS).filter(
              (m) => users.includes(m.user_id) && workspaces.includes(m.workspace_id),
            )
          } else {
            const rows = options.entities?.[table] ?? []
            if (ENTITY_TABLES.has(table)) {
              state.entityReads.push({ table, filters: { ...filters } })
              // Postgres would not return a row from another tenant; nor does
              // the fake, so an unscoped read shows up as a leak in the test.
              const ws = filters.workspace_id
              data = rows.filter((r) => r.workspace_id === undefined || r.workspace_id === ws)
            } else {
              data = rows
            }
          }
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      })

      return chain
    },
  }

  return { client: client as never, state }
}

let fake: ReturnType<typeof mockSupabase>

beforeEach(() => {
  fake = mockSupabase({ due: [] })
  hoisted.recordNoticeEvent.mockClear()
})

describe('runReminderPass', () => {
  it('fires a due reminder: one notification, fresh title as the body, no actor', async () => {
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship the reminder pass' }] },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 1, cancelled: 0, lost: 0, errored: 0 })
    expect(fake.state.inserts).toHaveLength(1)
    expect(fake.state.inserts[0]).toMatchObject({
      workspace_id: 'ws-1',
      // recipient is the MEMBER, never the user id — and it is RESOLVED from
      // (user_id, workspace_id) at fire time, never read off the reminder row.
      recipient_id: 'mem-1',
      type: 'reminder',
      title: 'Reminder',
      body: 'Ship the reminder pass',
      target_type: 'action',
      target_id: 'act-1',
      actor_id: null,
      group_key: 'reminder:rem-1',
      metadata: { reminder_id: 'rem-1', remind_at: '2026-08-06T11:58:00.000Z' },
    })
    // Claimed by flipping delivered_at while it was still NULL.
    expect(fake.state.reminderUpdates[0]).toMatchObject({
      values: { delivered_at: NOW.toISOString() },
      filters: { id: 'rem-1', delivered_at: null },
    })
    // The agent hears it too: one event keyed on the notification's own id, titled with what it is about.
    expect(typeof fake.state.inserts[0].id).toBe('string')
    expect(hoisted.recordNoticeEvent).toHaveBeenCalledWith(
      {
        notificationId: fake.state.inserts[0].id,
        workspaceId: 'ws-1',
        recipientMemberId: 'mem-1',
        type: 'reminder',
        title: 'Ship the reminder pass',
        targetType: 'action',
        targetId: 'act-1',
      },
      fake.client,
    )
  })

  it('reads the title from the right column per entity type (name vs title)', async () => {
    fake = mockSupabase({
      due: [
        reminder({ id: 'rem-p', entity_type: 'project', entity_id: 'proj-1' }),
        reminder({ id: 'rem-i', entity_type: 'initiative', entity_id: 'init-1' }),
        reminder({ id: 'rem-d', entity_type: 'document', entity_id: 'doc-1' }),
      ],
      entities: {
        projects: [{ id: 'proj-1', name: 'Reminders' }],
        initiative: [{ id: 'init-1', name: 'Q3 Platform' }],
        document: [{ id: 'doc-1', title: 'Spec' }],
      },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ fired: 3, cancelled: 0, errored: 0 })
    expect(fake.state.inserts.map((i) => i.body)).toEqual(['Reminders', 'Q3 Platform', 'Spec'])
  })

  it('losing the claim CAS inserts nothing (the double-fire guard)', async () => {
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it' }] },
      claimLost: ['rem-1'],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, lost: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(0)
  })

  it('a reminder whose entity is gone is silently cancelled, still consumed', async () => {
    fake = mockSupabase({ due: [reminder()], entities: { actions: [] } })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, cancelled: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(0)
    // delivered_at was claimed and NOT rolled back — it never rescans.
    expect(fake.state.reminderUpdates).toHaveLength(1)
    expect(fake.state.reminderUpdates[0].values).toMatchObject({ delivered_at: NOW.toISOString() })
  })

  it('a FAILED title lookup rolls the claim back and errors — it must never cancel', async () => {
    // The dangerous confusion: a title query that errors returns no rows, which
    // is indistinguishable from "entity deleted" unless the error is tracked.
    // Cancelling here would destroy a live reminder permanently.
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it' }] },
      titleReadFails: ['actions'],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, cancelled: 0, errored: 1 })
    expect(fake.state.inserts).toHaveLength(0)
    // Claim, then rollback guarded on the value THIS tick wrote → next tick retries.
    expect(fake.state.reminderUpdates).toHaveLength(2)
    expect(fake.state.reminderUpdates[1]).toMatchObject({
      values: { delivered_at: null },
      filters: { id: 'rem-1', delivered_at: NOW.toISOString() },
    })
  })

  it('a failing type does not poison reminders of a type that read cleanly', async () => {
    fake = mockSupabase({
      due: [
        reminder({ id: 'rem-a', entity_type: 'action', entity_id: 'act-1' }),
        reminder({ id: 'rem-p', entity_type: 'project', entity_id: 'proj-1' }),
      ],
      entities: {
        actions: [{ id: 'act-1', title: 'Ship it' }],
        projects: [{ id: 'proj-1', name: 'Reminders' }],
      },
      titleReadFails: ['actions'],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 2, fired: 1, cancelled: 0, errored: 1 })
    expect(fake.state.inserts).toHaveLength(1)
    expect(fake.state.inserts[0]).toMatchObject({ body: 'Reminders', target_id: 'proj-1' })
  })

  it('fires for every owner: there is no per-type mute to read', async () => {
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it' }] },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(1)
    expect(fake.state.tables).not.toContain('notification_preference')
  })

  it('rolls delivered_at back when the notification insert fails, so the next tick retries', async () => {
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it' }] },
      insertFails: true,
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, errored: 1 })
    expect(fake.state.inserts).toHaveLength(0)
    expect(hoisted.recordNoticeEvent).not.toHaveBeenCalled()
    // Claim, then rollback guarded on the value THIS tick wrote.
    expect(fake.state.reminderUpdates).toHaveLength(2)
    expect(fake.state.reminderUpdates[1]).toMatchObject({
      values: { delivered_at: null },
      filters: { id: 'rem-1', delivered_at: NOW.toISOString() },
    })
  })

  it('an empty due-scan does no work', async () => {
    const summary = await runReminderPass(fake.client, NOW)
    expect(summary).toEqual({ due: 0, fired: 0, cancelled: 0, lost: 0, errored: 0 })
    expect(fake.state.inserts).toHaveLength(0)
  })
})

// ─── Workspace binding at fire time ─────────────────────────────────────────
//
// The pass runs on the SERVICE client — RLS is off beneath it — and the only
// entity→workspace check anywhere else in the reminder path is the POST route's
// existence probe, which ran once, possibly months ago. So the pass re-derives
// everything under the reminder's OWN workspace_id.

describe('runReminderPass — workspace-scoped entity reads', () => {
  it('scopes the title read to the reminder workspace', async () => {
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it', workspace_id: 'ws-1' }] },
    })

    await runReminderPass(fake.client, NOW)

    expect(fake.state.entityReads).toHaveLength(1)
    expect(fake.state.entityReads[0]).toMatchObject({
      table: 'actions',
      filters: { workspace_id: 'ws-1', 'in:id': ['act-1'] },
    })
  })

  it('cancels when the entity lives in a DIFFERENT workspace than the reminder', async () => {
    // The retarget attack shape: the reminder row claims ws-1, the entity is
    // really in ws-evil. An unscoped `.in('id', …)` would resolve it and put its
    // title into a notification body.
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Secret roadmap', workspace_id: 'ws-evil' }] },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, cancelled: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(0)
  })

  it('reads each (type, workspace) group separately rather than merging ids', async () => {
    // Grouping by entity_type ALONE would issue one query carrying whichever
    // workspace happened to be last, silently unscoping the other.
    fake = mockSupabase({
      due: [
        reminder({ id: 'rem-a', workspace_id: 'ws-1', entity_id: 'act-1' }),
        reminder({ id: 'rem-b', workspace_id: 'ws-2', entity_id: 'act-2' }),
      ],
      entities: {
        actions: [
          { id: 'act-1', title: 'In ws-1', workspace_id: 'ws-1' },
          { id: 'act-2', title: 'In ws-2', workspace_id: 'ws-2' },
        ],
      },
      members: [
        { id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' },
        { id: 'mem-2', user_id: 'user-1', workspace_id: 'ws-2' },
      ],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 2, fired: 2, cancelled: 0, errored: 0 })
    expect(fake.state.entityReads.map((r) => r.filters.workspace_id).sort()).toEqual([
      'ws-1',
      'ws-2',
    ])
    // Each fired into its OWN workspace, addressed to that workspace's member.
    expect(
      fake.state.inserts.map((i) => [i.workspace_id, i.recipient_id, i.body]),
    ).toEqual([
      ['ws-1', 'mem-1', 'In ws-1'],
      ['ws-2', 'mem-2', 'In ws-2'],
    ])
  })

  it('a title read that fails in ONE workspace does not defer the same type in another', async () => {
    // failedTypes is keyed (entity_type, workspace_id), not entity_type alone.
    fake = mockSupabase({
      due: [
        reminder({ id: 'rem-a', workspace_id: 'ws-1', entity_id: 'act-1' }),
        reminder({ id: 'rem-b', workspace_id: 'ws-2', entity_type: 'project', entity_id: 'proj-1' }),
      ],
      entities: {
        actions: [{ id: 'act-1', title: 'Ship it', workspace_id: 'ws-1' }],
        projects: [{ id: 'proj-1', name: 'Reminders', workspace_id: 'ws-2' }],
      },
      members: [
        { id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' },
        { id: 'mem-2', user_id: 'user-1', workspace_id: 'ws-2' },
      ],
      titleReadFails: ['actions'],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 2, fired: 1, cancelled: 0, errored: 1 })
    expect(fake.state.inserts[0]).toMatchObject({ body: 'Reminders', workspace_id: 'ws-2' })
  })
})

describe('runReminderPass — capture visibility at fire time', () => {
  it('delivers a workspace-visible capture', async () => {
    fake = mockSupabase({
      due: [reminder({ entity_type: 'capture', entity_id: 'cap-1' })],
      entities: {
        captures: [
          { id: 'cap-1', title: 'Standup', workspace_id: 'ws-1', visibility: 'workspace', user_id: 'someone-else' },
        ],
      },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ fired: 1, cancelled: 0 })
    expect(fake.state.inserts[0]).toMatchObject({ body: 'Standup' })
  })

  it('cancels when the capture went PRIVATE after the reminder was set', async () => {
    // Migration 223: "Only me" means only me. The set-time probe let this
    // through when the capture was still workspace-visible; the owner has since
    // flipped it, and the title must not leak out through a notification body.
    fake = mockSupabase({
      due: [reminder({ entity_type: 'capture', entity_id: 'cap-1' })],
      entities: {
        captures: [
          { id: 'cap-1', title: 'Comp planning', workspace_id: 'ws-1', visibility: 'private', user_id: 'someone-else' },
        ],
      },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, cancelled: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(0)
    // Consumed, not rolled back — it must not retry every tick forever.
    expect(fake.state.reminderUpdates).toHaveLength(1)
  })

  it("still delivers a private capture to its OWN creator", async () => {
    fake = mockSupabase({
      due: [reminder({ entity_type: 'capture', entity_id: 'cap-1' })],
      entities: {
        captures: [
          { id: 'cap-1', title: 'My notes', workspace_id: 'ws-1', visibility: 'private', user_id: 'user-1' },
        ],
      },
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ fired: 1, cancelled: 0 })
    expect(fake.state.inserts[0]).toMatchObject({ body: 'My notes' })
  })

  it('does NOT leak a private capture title to a co-tenant with a reminder on the same capture', async () => {
    // Both members set a reminder on cap-1 while it was workspace-visible; the
    // creator then flipped it private. In one tick both fire: the creator's must
    // deliver, the co-tenant's must silently cancel — the title must never reach
    // user-2's inbox. Regression guard for the per-entity vs per-recipient key.
    fake = mockSupabase({
      due: [
        reminder({ id: 'rem-owner', user_id: 'user-1', entity_type: 'capture', entity_id: 'cap-1' }),
        reminder({ id: 'rem-cotenant', user_id: 'user-2', entity_type: 'capture', entity_id: 'cap-1' }),
      ],
      entities: {
        captures: [
          { id: 'cap-1', title: 'Comp planning', workspace_id: 'ws-1', visibility: 'private', user_id: 'user-1' },
        ],
      },
      members: [
        { id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' },
        { id: 'mem-2', user_id: 'user-2', workspace_id: 'ws-1' },
      ],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 2, fired: 1, cancelled: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(1)
    expect(fake.state.inserts[0]).toMatchObject({ recipient_id: 'mem-1', body: 'Comp planning' })
    // The co-tenant's member id never appears as a notification recipient.
    expect(fake.state.inserts.some((i) => i.recipient_id === 'mem-2')).toBe(false)
  })
})

describe('runReminderPass — recipient resolution', () => {
  it('resolves the recipient by (user_id, workspace_id), not off the reminder row', async () => {
    // Same user, two workspaces, two member rows. The reminder is stamped ws-2,
    // so only the ws-2 member may receive it.
    fake = mockSupabase({
      due: [reminder({ workspace_id: 'ws-2' })],
      entities: { actions: [{ id: 'act-1', title: 'Ship it', workspace_id: 'ws-2' }] },
      members: [
        { id: 'mem-ws1', user_id: 'user-1', workspace_id: 'ws-1' },
        { id: 'mem-ws2', user_id: 'user-1', workspace_id: 'ws-2' },
      ],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ fired: 1 })
    expect(fake.state.inserts[0]).toMatchObject({
      workspace_id: 'ws-2',
      recipient_id: 'mem-ws2',
    })
  })

  it('cancels when the owner is no longer a member of the workspace', async () => {
    // The user left W between setting the reminder and it firing. There is no
    // inbox to deliver into, so it is consumed silently — exactly like a
    // deleted entity, and never delivered to some other member.
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it', workspace_id: 'ws-1' }] },
      members: [],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, cancelled: 1, errored: 0 })
    expect(fake.state.inserts).toHaveLength(0)
    expect(fake.state.reminderUpdates).toHaveLength(1)
  })

  it('a FAILED recipient lookup rolls the claim back — it must never cancel', async () => {
    // Same trap as the title lookup: an errored read returns no rows, which is
    // indistinguishable from "left the workspace" unless the error is tracked.
    fake = mockSupabase({
      due: [reminder()],
      entities: { actions: [{ id: 'act-1', title: 'Ship it', workspace_id: 'ws-1' }] },
      memberReadFails: true,
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 1, fired: 0, cancelled: 0, errored: 1 })
    expect(fake.state.inserts).toHaveLength(0)
    expect(fake.state.reminderUpdates).toHaveLength(2)
    expect(fake.state.reminderUpdates[1]).toMatchObject({
      values: { delivered_at: null },
      filters: { id: 'rem-1', delivered_at: NOW.toISOString() },
    })
  })

  it('sends each reminder to the member RESOLVED in its own workspace', async () => {
    // One user, a member in each workspace: each reminder goes to the member
    // row of the workspace it was set in, never the user's other one.
    fake = mockSupabase({
      due: [
        reminder({ id: 'rem-a', workspace_id: 'ws-1', entity_id: 'act-1' }),
        reminder({ id: 'rem-b', workspace_id: 'ws-2', entity_id: 'act-2' }),
      ],
      entities: {
        actions: [
          { id: 'act-1', title: 'In ws-1', workspace_id: 'ws-1' },
          { id: 'act-2', title: 'In ws-2', workspace_id: 'ws-2' },
        ],
      },
      members: [
        { id: 'mem-ws1', user_id: 'user-1', workspace_id: 'ws-1' },
        { id: 'mem-ws2', user_id: 'user-1', workspace_id: 'ws-2' },
      ],
    })

    const summary = await runReminderPass(fake.client, NOW)

    expect(summary).toMatchObject({ due: 2, fired: 2 })
    expect(fake.state.inserts).toHaveLength(2)
    expect(fake.state.inserts[0]).toMatchObject({ recipient_id: 'mem-ws1', body: 'In ws-1' })
    expect(fake.state.inserts[1]).toMatchObject({ recipient_id: 'mem-ws2', body: 'In ws-2' })
  })
})
