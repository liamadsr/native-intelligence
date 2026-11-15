/**
 * The attempt ledger's writes and reads (../store.ts): a stored try is
 * marked so (an answered error tried once more, a second an ALERT, never a
 * throw); a repeat whose first post is not marked stored names the row it
 * was writing; and a workspace's upload bytes for its daily quota are summed
 * by the database in one call (663).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { claimAttempt, markAttemptStored, uploadBytesSince } from '../store'

afterEach(() => vi.restoreAllMocks())

/** A client whose updates answer `answers` in turn ({ error } or a throw), per table. */
function updates(answers: Record<string, Array<{ error: { message: string } | null } | 'throw'>>) {
  const calls: Array<{ table: string; patch: Record<string, unknown>; id: unknown }> = []
  const from = (table: string) => ({
    update: (patch: Record<string, unknown>) => ({
      eq: async (_col: string, id: unknown) => {
        calls.push({ table, patch, id })
        const next = (answers[table] ?? []).shift() ?? { error: null }
        if (next === 'throw') throw new Error('socket hang up')
        return next
      },
    }),
  })
  return { client: { from } as unknown as SupabaseClient, calls }
}

describe('markAttemptStored', () => {
  it('marks the try stored and notes the form’s last submission', async () => {
    const { client, calls } = updates({})
    await markAttemptStored(client, 'att-1', 'form-1')
    expect(calls.map((c) => [c.table, Object.keys(c.patch), c.id])).toEqual([
      ['data_form_attempt', ['stored_at'], 'att-1'],
      ['data_form', ['last_submitted_at'], 'form-1'],
    ])
  })

  it('an error Supabase answers (not throws) is read and tried once more; that one passing is no ALERT', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, calls } = updates({ data_form_attempt: [{ error: { message: 'deadlock detected' } }, { error: null }] })
    await markAttemptStored(client, 'att-1', 'form-1')
    expect(calls.filter((c) => c.table === 'data_form_attempt')).toHaveLength(2)
    expect(errors).not.toHaveBeenCalled()
  })

  it('two failures are an ALERT, never a throw; the last submission failing only warns', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = updates({ data_form_attempt: [{ error: { message: 'down' } }, 'throw'], data_form: [{ error: { message: 'down' } }] })
    await expect(markAttemptStored(client, 'att-1', 'form-1')).resolves.toBeUndefined()
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('ALERT')])
    expect(String(errors.mock.calls[0][0])).toContain('att-1')
    expect(warns).toHaveBeenCalledOnce()
  })
})

describe('claimAttempt: a repeat of a submission not yet marked stored', () => {
  /** The ledger's update refused by the submission id's unique index, and its read of the first post. */
  function ledger(first: Record<string, unknown> | null) {
    const q = {
      eq: () => q,
      is: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: first, error: null }),
    }
    return {
      from: () => ({
        update: () => ({ eq: async () => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint "data_form_attempt_external_key"' } }) }),
        select: () => q,
      }),
    } as unknown as SupabaseClient
  }
  const args = { attemptId: 'a2', formId: 'f', clientHash: 'c', externalId: 'sub-1', rowId: 'r2' }

  it('names the row its first post was writing, for the caller to look for', async () => {
    expect(await claimAttempt(ledger({ id: 'a1', row_id: 'r1', stored_at: null }), args)).toEqual({ kind: 'repeat', rowId: null, unstoredRowId: 'r1' })
  })

  it('a stored first post is answered with its row, as before; one with no row names none', async () => {
    expect(await claimAttempt(ledger({ id: 'a1', row_id: 'r1', stored_at: '2026-11-15T12:00:00Z' }), args)).toEqual({ kind: 'repeat', rowId: 'r1' })
    expect(await claimAttempt(ledger({ id: 'a1', row_id: null, stored_at: null }), args)).toEqual({ kind: 'repeat', rowId: null, unstoredRowId: null })
    expect(await claimAttempt(ledger(null), args)).toEqual({ kind: 'repeat', rowId: null, unstoredRowId: null })
  })
})

describe("uploadBytesSince a workspace's forms", () => {
  it('is summed by the database in one call, by the workspace and the moment', async () => {
    const rpc = vi.fn(async () => ({ data: '1073741824', error: null }))
    const client = { rpc, from: () => { throw new Error('no row read') } } as unknown as SupabaseClient
    expect(await uploadBytesSince(client, { workspaceId: 'ws-1' }, '2026-11-14T12:00:00.000Z')).toBe(1073741824)
    expect(rpc).toHaveBeenCalledWith('data_form_workspace_upload_bytes', { p_workspace_id: 'ws-1', p_since: '2026-11-14T12:00:00.000Z' })
  })

  it('a sum that can’t be read throws (the caller holds the upload)', async () => {
    const failing = { rpc: vi.fn(async () => ({ data: null, error: { message: 'function does not exist' } })) } as unknown as SupabaseClient
    await expect(uploadBytesSince(failing, { workspaceId: 'ws-1' }, 'x')).rejects.toThrow('data_form_workspace_upload_bytes failed')
    const nonsense = { rpc: vi.fn(async () => ({ data: 'lots', error: null })) } as unknown as SupabaseClient
    await expect(uploadBytesSince(nonsense, { workspaceId: 'ws-1' }, 'x')).rejects.toThrow()
  })
})
