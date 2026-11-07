/**
 * shareTargetAllowed: the public share routes' own check (migration 447's
 * rule, read on the service client). A share opens its item only when the item
 * is in the share's workspace, and a private item only from its creator's
 * share.
 */
import { describe, expect, it } from 'vitest'
import { shareTargetAllowed, type ShareTargetRow } from '@/lib/share-target'

type Row = Record<string, unknown>

/**
 * A service client over fixed tables: eq filters, then maybeSingle. A row
 * comes back with only the selected columns, as PostgREST returns it, so a
 * misnamed column reads as missing.
 */
function fakeService(tables: Record<string, Row[]>) {
  const reads: string[] = []
  const client = {
    from(table: string) {
      reads.push(table)
      const filters: [string, unknown][] = []
      let cols: string[] = []
      const chain = {
        select: (list: string) => {
          cols = list.split(',').map((c) => c.trim())
          return chain
        },
        eq: (col: string, value: unknown) => {
          filters.push([col, value])
          return chain
        },
        maybeSingle: async () => {
          const row = (tables[table] ?? []).find((r) => filters.every(([c, v]) => r[c] === v))
          return { data: row ? Object.fromEntries(cols.map((c) => [c, row[c]])) : null, error: null }
        },
      }
      return chain
    },
  }
  return { service: client as never, reads }
}

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

const MEMBERS: Row[] = [
  { id: 'm-ann', user_id: 'u-ann', workspace_id: WS },
  { id: 'm-bob', user_id: 'u-bob', workspace_id: WS },
]

function share(over: Partial<ShareTargetRow>): ShareTargetRow {
  return { workspace_id: WS, shareable_type: 'document', shareable_id: 'doc-1', created_by: 'm-ann', ...over }
}

describe('shareTargetAllowed: documents', () => {
  const tables = {
    document: [
      { id: 'doc-ws', workspace_id: WS, visibility: 'workspace', created_by: 'm-bob' },
      { id: 'doc-ann-private', workspace_id: WS, visibility: 'private', created_by: 'm-ann' },
      { id: 'doc-bob-private', workspace_id: WS, visibility: 'private', created_by: 'm-bob' },
      { id: 'doc-orphan-private', workspace_id: WS, visibility: 'private', created_by: null },
      { id: 'doc-elsewhere', workspace_id: OTHER_WS, visibility: 'workspace', created_by: 'm-zed' },
    ],
    member: MEMBERS,
  }

  it('opens a workspace document from anyone’s share in its workspace', async () => {
    const { service } = fakeService(tables)
    expect(await shareTargetAllowed(service, share({ shareable_id: 'doc-ws' }))).toBe(true)
  })

  it('opens a private document only from its creator’s share', async () => {
    const { service } = fakeService(tables)
    expect(await shareTargetAllowed(service, share({ shareable_id: 'doc-ann-private' }))).toBe(true)
    expect(await shareTargetAllowed(service, share({ shareable_id: 'doc-bob-private' }))).toBe(false)
    expect(await shareTargetAllowed(service, share({ shareable_id: 'doc-orphan-private' }))).toBe(false)
  })

  it('never opens a document in another workspace, or one that is gone', async () => {
    const { service } = fakeService(tables)
    expect(await shareTargetAllowed(service, share({ shareable_id: 'doc-elsewhere' }))).toBe(false)
    expect(await shareTargetAllowed(service, share({ shareable_id: 'doc-missing' }))).toBe(false)
  })
})

describe('shareTargetAllowed: captures', () => {
  const tables = {
    captures: [
      { id: 'cap-ws', workspace_id: WS, visibility: 'workspace', user_id: 'u-bob' },
      { id: 'cap-ann-private', workspace_id: WS, visibility: 'private', user_id: 'u-ann' },
      { id: 'cap-bob-private', workspace_id: WS, visibility: 'private', user_id: 'u-bob' },
      { id: 'cap-elsewhere', workspace_id: OTHER_WS, visibility: 'workspace', user_id: 'u-zed' },
    ],
    member: MEMBERS,
  }
  const cap = (id: string, createdBy = 'm-ann') =>
    share({ shareable_type: 'capture', shareable_id: id, created_by: createdBy })

  it('opens a workspace capture without looking up the creator', async () => {
    const { service, reads } = fakeService(tables)
    expect(await shareTargetAllowed(service, cap('cap-ws'))).toBe(true)
    expect(reads).toEqual(['captures'])
  })

  it('opens a private capture only from its creator’s share (auth user matched through the member row)', async () => {
    const { service } = fakeService(tables)
    expect(await shareTargetAllowed(service, cap('cap-ann-private'))).toBe(true)
    expect(await shareTargetAllowed(service, cap('cap-bob-private'))).toBe(false)
    // A creator that isn't a member of the share's workspace matches no one.
    expect(await shareTargetAllowed(service, cap('cap-ann-private', 'm-unknown'))).toBe(false)
  })

  it('never opens a capture in another workspace, or one that is gone', async () => {
    const { service } = fakeService(tables)
    expect(await shareTargetAllowed(service, cap('cap-elsewhere'))).toBe(false)
    expect(await shareTargetAllowed(service, cap('cap-missing'))).toBe(false)
  })
})

it('refuses any other shareable type without a read', async () => {
  const { service, reads } = fakeService({})
  expect(await shareTargetAllowed(service, share({ shareable_type: 'action' }))).toBe(false)
  expect(reads).toEqual([])
})
