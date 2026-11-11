/**
 * GET /api/account/contacts/:id/captures — a contact's meetings.
 *
 * It read capture_participant ordered by a created_at the table never had
 * (it has joined_at), so every call answered 500. The double refuses that
 * column the way PostgREST does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { recordingDb } from '@/test/recording-db'
import { withTableSchema } from '@/test/table-schema'

const h = vi.hoisted(() => ({ client: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

const { GET } = await import('../route')

let db: ReturnType<typeof recordingDb>

beforeEach(() => {
  db = recordingDb({
    contact: [{ id: 'ct-1' }],
    captures: [
      { id: 'cap-2', title: 'Renewal call', ai_summary: 'Renewal terms.', started_at: '2026-10-02T15:00:00Z', ended_at: null, status: 'completed', ai_processed: true, cp: [{ contact_id: 'ct-1' }] },
    ],
  })
  h.client = withTableSchema(
    { ...db.client, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } },
    ['capture_participant', 'captures'],
  )
})

describe('GET /api/account/contacts/:id/captures', () => {
  it("answers the contact's meetings, newest first, from the captures side", async () => {
    const res = await GET({} as NextRequest, { params: Promise.resolve({ id: 'ct-1' }) })
    expect(res.status).toBe(200)
    expect((await res.json()).captures).toEqual([
      { id: 'cap-2', title: 'Renewal call', ai_summary: 'Renewal terms.', started_at: '2026-10-02T15:00:00Z', ended_at: null, status: 'completed', ai_processed: true },
    ])
    const calls = db.calls.captures
    expect(calls).toContainEqual(['eq', 'workspace_id', 'ws-1'])
    expect(calls).toContainEqual(['eq', 'cp.contact_id', 'ct-1'])
    expect(calls).toContainEqual(['neq', 'is_eval', true])
    expect(calls).toContainEqual(['order', 'started_at', { ascending: false, nullsFirst: false }])
    expect(calls).toContainEqual(['limit', 50])
  })
})
