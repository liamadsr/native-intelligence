/**
 * searchEmailsWithContext's related meetings for a known sender.
 *
 * It read capture_participant ordered by a created_at the table never had
 * (it has joined_at), ignored the error, and so an email search never showed
 * a meeting with the sender. The double refuses that column the way PostgREST
 * does. The read runs on the service-role client, so the requester's capture
 * visibility is the fence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingDb } from '@/test/recording-db'
import { withTableSchema } from '@/test/table-schema'

const h = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.client }))
vi.mock('@/lib/crm/contact-visibility', () => ({
  filterVisibleContacts: async (_s: unknown, _u: string, rows: unknown[]) => rows,
}))
vi.mock('../email-search-service', () => ({
  searchEmails: async () => ({
    source: 'provider',
    results: [
      { threadId: 't-1', subject: 'Renewal', from: { name: 'Avery', email: 'Avery@Example.com' }, snippet: '', date: '2026-10-03', isUnread: false, folder: '', matchSource: 'provider' },
    ],
  }),
}))

const { searchEmailsWithContext } = await import('../email-context-service')

const capture = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Meeting ${id}`,
  started_at: '2026-10-02T15:00:00Z',
  user_id: 'user-1',
  visibility: 'workspace',
  is_eval: false,
  notes_owner_out: false,
  cp: [{ external_email: 'avery@example.com' }],
  ...over,
})

let db: ReturnType<typeof recordingDb>

beforeEach(() => {
  db = recordingDb({
    contact: [{ id: 'ct-1', full_name: 'Avery Example', email: 'avery@example.com', relationship_type: 'customer', company: null }],
    captures: [capture('cap-2'), capture('cap-mine', { visibility: 'private' }), capture('cap-theirs', { user_id: 'user-2', visibility: 'private' })],
  })
  h.client = withTableSchema(db.client, ['capture_participant', 'captures'])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('searchEmailsWithContext — related captures', () => {
  it("attaches the sender's meetings the requester may see, newest first", async () => {
    const [result] = await searchEmailsWithContext('user-1', 'ws-1', 'renewal', 10, { requester: 'user-1' })
    expect(result.relatedCaptures).toEqual([
      { id: 'cap-2', title: 'Meeting cap-2', date: '2026-10-02T15:00:00Z' },
      { id: 'cap-mine', title: 'Meeting cap-mine', date: '2026-10-02T15:00:00Z' },
    ])
    const calls = db.calls.captures
    expect(calls).toContainEqual(['eq', 'workspace_id', 'ws-1'])
    expect(calls).toContainEqual(['eq', 'cp.external_email', 'avery@example.com'])
    expect(calls).toContainEqual(['or', 'visibility.eq.workspace,user_id.eq.user-1'])
    expect(calls).toContainEqual(['neq', 'status', 'archived'])
    expect(calls).toContainEqual(['order', 'started_at', { ascending: false, nullsFirst: false }])
    expect(db.calls.capture_participant).toBeUndefined()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('without a requester only workspace-visible meetings come back', async () => {
    const [result] = await searchEmailsWithContext('user-1', 'ws-1', 'renewal', 10)
    expect(result.relatedCaptures).toEqual([{ id: 'cap-2', title: 'Meeting cap-2', date: '2026-10-02T15:00:00Z' }])
    expect(db.calls.captures).toContainEqual(['eq', 'visibility', 'workspace'])
  })

  it("mail the requester sent names no related meetings (the contact is themselves)", async () => {
    const own = recordingDb({
      connected_account: [{ account_email: 'avery@example.com' }],
      contact: [{ id: 'ct-1', full_name: 'Avery Example', email: 'avery@example.com', relationship_type: 'customer', company: null }],
      captures: [capture('cap-2')],
    })
    h.client = withTableSchema(own.client, ['capture_participant', 'captures'])
    const [result] = await searchEmailsWithContext('user-1', 'ws-1', 'renewal', 10, { requester: 'user-1' })
    expect(result.contact).toMatchObject({ id: 'ct-1' })
    expect(result.relatedCaptures).toBeUndefined()
    expect(own.calls.captures).toBeUndefined()
  })
})
