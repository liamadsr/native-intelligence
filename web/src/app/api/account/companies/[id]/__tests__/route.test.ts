/**
 * GET /api/account/companies/:id — the company card's recent meetings.
 *
 * It read capture_participant ordered by a created_at the table never had
 * (it has joined_at), ignored the error, and so showed "No captures yet." for
 * every company. The double refuses that column the way PostgREST does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { recordingDb } from '@/test/recording-db'
import { withTableSchema } from '@/test/table-schema'

const h = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: vi.fn() }))
vi.mock('@/lib/crm/delete-companies', () => ({ deleteCompaniesWithContacts: vi.fn() }))

const { GET } = await import('../route')

let db: ReturnType<typeof recordingDb>

beforeEach(() => {
  db = recordingDb({
    company: [{ id: 'co-1', workspace_id: 'ws-1', name: 'Fernhill Studio' }],
    contact: [{ id: 'ct-1', full_name: 'Avery Example' }, { id: 'ct-2', full_name: 'Jordan Sample' }],
    captures: [
      { id: 'cap-2', title: 'Renewal call', ai_summary: 'Renewal terms.', started_at: '2026-10-02T15:00:00Z', status: 'completed', cp: [{ contact_id: 'ct-1' }, { contact_id: 'ct-2' }] },
      { id: 'cap-1', title: 'Kickoff', ai_summary: null, started_at: '2026-09-01T15:00:00Z', status: 'completed', cp: [{ contact_id: 'ct-2' }] },
    ],
  })
  h.client = withTableSchema(
    { ...db.client, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } },
    ['capture_participant', 'captures'],
  )
})

const get = () => GET({} as NextRequest, { params: Promise.resolve({ id: 'co-1' }) })

describe('GET /api/account/companies/:id — recent captures', () => {
  it("lists the meetings with the company's people, newest first, once each", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const { company } = await res.json()
    expect(company.captures).toEqual([
      { id: 'cap-2', title: 'Renewal call', ai_summary: 'Renewal terms.', started_at: '2026-10-02T15:00:00Z', status: 'completed' },
      { id: 'cap-1', title: 'Kickoff', ai_summary: null, started_at: '2026-09-01T15:00:00Z', status: 'completed' },
    ])
  })

  it("reads from captures: in this workspace, joined to the company's contacts, no eval captures, by start time", async () => {
    await get()
    const calls = db.calls.captures
    expect(calls[0]).toEqual(['select', 'id, title, ai_summary, started_at, status, cp:capture_participant!inner(contact_id)'])
    expect(calls).toContainEqual(['eq', 'workspace_id', 'ws-1'])
    expect(calls).toContainEqual(['in', 'cp.contact_id', ['ct-1', 'ct-2']])
    expect(calls).toContainEqual(['neq', 'is_eval', true])
    expect(calls).toContainEqual(['order', 'started_at', { ascending: false, nullsFirst: false }])
    expect(db.calls.capture_participant).toBeUndefined()
  })
})
