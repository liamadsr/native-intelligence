/**
 * Tests for the archive_capture executor (GEN-134) — the flow-native capture
 * archive. Guards: no-triggering-capture no-op, workspace scoping, demo skip,
 * idempotent already-archived, not-found skip, read/update error paths.
 *
 * Mocks getServiceClient so the executor's captures read (.maybeSingle) and
 * update (.eq chain) resolve to fixtures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The executor imports getServiceClient from '@/lib/admin' — mock it.
const state: {
  capture: { id: string; status: string | null; metadata: { demo?: boolean } | null } | null
  readError: string | null
  updateError: string | null
  updated: Array<{ status: string }>
  updateFilters: Record<string, unknown>
} = {
  capture: null,
  readError: null,
  updateError: null,
  updated: [],
  updateFilters: {},
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'captures') throw new Error(`unexpected table ${table}`)
      // Distinguish the read chain (.select…maybeSingle) from the update chain
      // (.update…eq…eq resolved as a thenable).
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = (patch: { status: string }) => {
        state.updated.push(patch)
        const upd: Record<string, unknown> = {}
        upd.eq = (col: string, val: unknown) => {
          state.updateFilters[col] = val
          return upd
        }
        upd.then = (res: (r: unknown) => unknown) =>
          Promise.resolve({
            error: state.updateError ? { message: state.updateError } : null,
          }).then(res)
        return upd
      }
      chain.eq = () => chain
      chain.maybeSingle = () =>
        Promise.resolve({
          data: state.capture,
          error: state.readError ? { message: state.readError } : null,
        })
      return chain
    },
  }),
}))

const { createArchiveCaptureExecutor } = await import('../archive-capture')
import type { FlowAction, TriggerContext } from '../types'

const action = { id: 'archive-1', type: 'archive_capture', config: {} } as FlowAction
const trigger: TriggerContext = {
  type: 'capture_processed',
  entity_type: null,
  from_status_id: null,
  to_status_id: null,
  fired_at: '2026-07-02T12:00:00.000Z',
}
function ctx(capture: { id: string; title: string | null } | null) {
  return { entity: null, trigger, appBaseUrl: 'https://nativeintelligence.dev', capture }
}

beforeEach(() => {
  state.capture = null
  state.readError = null
  state.updateError = null
  state.updated = []
  state.updateFilters = {}
})

const exec = createArchiveCaptureExecutor({ workspaceId: 'w-1' })

describe('archive_capture executor', () => {
  it('no-ops (success) when the fire carries no capture', async () => {
    const r = await exec(action, ctx(null))
    expect(r.status).toBe('success')
    expect(r.archived_capture_id).toBeNull()
    expect(state.updated).toHaveLength(0)
    expect(r.response_body_preview).toMatch(/nothing to archive/i)
  })

  it('archives an eligible capture and reports its id', async () => {
    state.capture = { id: 'cap-1', status: 'completed', metadata: null }
    const r = await exec(action, ctx({ id: 'cap-1', title: 'Junk' }))
    expect(r.status).toBe('success')
    expect(r.archived_capture_id).toBe('cap-1')
    expect(state.updated).toEqual([{ status: 'archived' }])
    // Scoped to the flow's workspace on the UPDATE.
    expect(state.updateFilters.workspace_id).toBe('w-1')
    expect(state.updateFilters.id).toBe('cap-1')
  })

  it('never archives a demo / onboarding capture', async () => {
    state.capture = { id: 'cap-1', status: 'completed', metadata: { demo: true } }
    const r = await exec(action, ctx({ id: 'cap-1', title: 'Demo' }))
    expect(r.status).toBe('success')
    expect(r.archived_capture_id).toBeNull()
    expect(state.updated).toHaveLength(0)
    expect(r.response_body_preview).toMatch(/demo/i)
  })

  it('is idempotent: already-archived → success no-op, no redundant write', async () => {
    state.capture = { id: 'cap-1', status: 'archived', metadata: null }
    const r = await exec(action, ctx({ id: 'cap-1', title: 'x' }))
    expect(r.status).toBe('success')
    expect(r.archived_capture_id).toBe('cap-1')
    expect(state.updated).toHaveLength(0)
  })

  it('skips (success) when the capture is not in this workspace', async () => {
    state.capture = null // not found under workspace_id filter
    const r = await exec(action, ctx({ id: 'cap-x', title: 'Elsewhere' }))
    expect(r.status).toBe('success')
    expect(r.archived_capture_id).toBeNull()
    expect(state.updated).toHaveLength(0)
    expect(r.response_body_preview).toMatch(/not found/i)
  })

  it('fails on a capture read error (never silently succeeds)', async () => {
    state.readError = 'connection reset'
    const r = await exec(action, ctx({ id: 'cap-1', title: 'x' }))
    expect(r.status).toBe('failed')
    expect(r.error_message).toMatch(/read failed/i)
    expect(state.updated).toHaveLength(0)
  })

  it('fails on an update error', async () => {
    state.capture = { id: 'cap-1', status: 'completed', metadata: null }
    state.updateError = 'write conflict'
    const r = await exec(action, ctx({ id: 'cap-1', title: 'x' }))
    expect(r.status).toBe('failed')
    expect(r.error_message).toMatch(/archive failed/i)
  })
})
