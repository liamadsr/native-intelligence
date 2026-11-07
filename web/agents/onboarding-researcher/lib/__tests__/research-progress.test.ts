import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  mergeResearchProgress,
  appendResearchActivity,
  MAX_ACTIVITY_ENTRIES,
  type ResearchActivityEntry,
} from '../research-progress'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A minimal fake supabase client that models one member row's
 * onboarding_progress under optimistic (updated_at) concurrency control.
 *
 *   .select('onboarding_progress, updated_at').eq().eq().maybeSingle()
 *       → the current blob + its updated_at token
 *   .update({ onboarding_progress }).eq().eq().eq('updated_at', tok).select()
 *       → applies the write ONLY if `tok` still matches the row's current
 *         updated_at (CAS). A match returns [{ user_id }] and bumps updated_at
 *         (mirrors the member_updated_at trigger); a stale token returns [].
 *
 * `onConcurrentWrite` lets a test inject a competing write (e.g. a tutorial
 * step) BETWEEN this call's read and its write, so we can prove the CAS retry
 * loop re-reads and preserves the sibling key instead of clobbering it.
 */
function makeFakeClient(
  initial: Record<string, unknown> | null,
  opts: { onConcurrentWrite?: () => void } = {},
) {
  const state = {
    progress: initial,
    updatedAt: initial === null ? '' : 'v0',
    version: 0,
    updated: undefined as unknown,
  }
  let injectOnce = opts.onConcurrentWrite

  const client = {
    from(_table: string) {
      return {
        // read chain
        select(_cols?: string) {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data:
                        state.progress === null
                          ? null
                          : {
                              onboarding_progress: state.progress,
                              updated_at: state.updatedAt,
                            },
                      error: null,
                    }),
                  }
                },
              }
            },
          }
        },
        // write chain: update(...).eq(user).eq(workspace).eq(updated_at, tok).select()
        update(payload: { onboarding_progress: Record<string, unknown> }) {
          // Simulate a competing writer landing after THIS call read the row but
          // before it writes — exactly the race the CAS must survive. Fire once.
          if (injectOnce) {
            const fn = injectOnce
            injectOnce = undefined
            fn()
          }
          const pending = payload.onboarding_progress
          return {
            eq() {
              return {
                eq() {
                  return {
                    eq(_col: string, tok: string) {
                      return {
                        select: async () => {
                          // CAS: only apply when the token still matches.
                          if (tok !== state.updatedAt) {
                            return { data: [], error: null }
                          }
                          state.progress = pending
                          state.updated = pending
                          state.version += 1
                          state.updatedAt = `v${state.version}`
                          return { data: [{ user_id: 'user-1' }], error: null }
                        },
                      }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, state }
}

beforeEach(() => vi.clearAllMocks())

describe('mergeResearchProgress', () => {
  it('deep-merges within research, preserving sibling research fields', async () => {
    const { client, state } = makeFakeClient({
      tutorial: { step_one: true },
      research: { sessionId: 'sess-1', status: 'running', startedAt: 'T0' },
    })

    const merged = await mergeResearchProgress(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      patch: { status: 'done', brief: 'Here is what I learned', finishedAt: 'T1', companyFound: true },
    })

    // returned merged research keeps sessionId + startedAt from before
    expect(merged).toEqual({
      sessionId: 'sess-1',
      startedAt: 'T0',
      status: 'done',
      brief: 'Here is what I learned',
      finishedAt: 'T1',
      companyFound: true,
    })

    // sibling top-level key (tutorial) is untouched
    const written = state.updated as Record<string, unknown>
    expect(written.tutorial).toEqual({ step_one: true })
    expect(written.research).toEqual(merged)
  })

  it('creates research when onboarding_progress has none yet', async () => {
    const { client, state } = makeFakeClient({ tutorial: { a: 1 } })
    const merged = await mergeResearchProgress(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      patch: { status: 'skipped', brief: 'Kept it light', finishedAt: 'T1' },
    })
    expect(merged).toEqual({ status: 'skipped', brief: 'Kept it light', finishedAt: 'T1' })
    expect((state.updated as Record<string, unknown>).tutorial).toEqual({ a: 1 })
  })

  it('returns null when no member row matches', async () => {
    const { client } = makeFakeClient(null)
    const merged = await mergeResearchProgress(client, {
      userId: 'nope',
      workspaceId: 'ws-1',
      patch: { status: 'done', brief: 'x' },
    })
    expect(merged).toBeNull()
  })

  it('does NOT clobber a concurrent tutorial write (CAS retry preserves the sibling key)', async () => {
    // Baseline has no tutorial. A competing writer ticks a tutorial step AFTER
    // this merge reads but BEFORE it writes, bumping updated_at. A plain
    // read-modify-write would splice research onto the STALE (tutorial-less)
    // blob and clobber the step; the CAS loop must lose the first write, re-read
    // the fresh blob, and preserve the tutorial step.
    const { client, state } = makeFakeClient(
      { research: { sessionId: 'sess-1', status: 'running', startedAt: 'T0' } },
      {
        onConcurrentWrite: () => {
          state.progress = {
            ...(state.progress as Record<string, unknown>),
            tutorial: { step_seven: true },
          }
          state.version += 1
          state.updatedAt = `v${state.version}` // invalidates the pending CAS
        },
      },
    )

    const merged = await mergeResearchProgress(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      patch: { status: 'done', brief: 'done', finishedAt: 'T1' },
    })

    // research still merged correctly …
    expect(merged).toEqual({
      sessionId: 'sess-1',
      startedAt: 'T0',
      status: 'done',
      brief: 'done',
      finishedAt: 'T1',
    })
    // … AND the concurrently-written tutorial step survived (not clobbered).
    const written = state.updated as Record<string, unknown>
    expect(written.tutorial).toEqual({ step_seven: true })
    expect(written.research).toEqual(merged)
  })
})

const entry = (callId: string, label = `did ${callId}`): ResearchActivityEntry => ({
  callId,
  toolName: 'web_search',
  label,
})

describe('appendResearchActivity', () => {
  it('appends entries onto an empty activityLog, preserving sibling keys', async () => {
    const { client, state } = makeFakeClient({
      tutorial: { a: 1 },
      research: { sessionId: 'sess-1', status: 'running' },
    })
    const log = await appendResearchActivity(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      entries: [entry('c1'), entry('c2')],
    })
    expect(log).toEqual([entry('c1'), entry('c2')])
    const written = state.updated as Record<string, unknown>
    expect(written.tutorial).toEqual({ a: 1 })
    expect((written.research as Record<string, unknown>).sessionId).toBe('sess-1')
    expect((written.research as Record<string, unknown>).activityLog).toEqual([entry('c1'), entry('c2')])
  })

  it('dedups by callId across appends (no double-insert on replay)', async () => {
    const { client } = makeFakeClient({
      research: { activityLog: [entry('c1')] },
    })
    const log = await appendResearchActivity(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      // c1 already present → skipped; c2 is new.
      entries: [entry('c1'), entry('c2')],
    })
    expect(log).toEqual([entry('c1'), entry('c2')])
  })

  it('makes NO write when every entry is already recorded', async () => {
    const { client, state } = makeFakeClient({
      research: { activityLog: [entry('c1'), entry('c2')] },
    })
    const before = state.version
    const log = await appendResearchActivity(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      entries: [entry('c1'), entry('c2')],
    })
    expect(log).toEqual([entry('c1'), entry('c2')])
    // No CAS write happened (version unchanged) — a pure no-op.
    expect(state.version).toBe(before)
  })

  it('caps the log at MAX_ACTIVITY_ENTRIES', async () => {
    const existing = Array.from({ length: MAX_ACTIVITY_ENTRIES - 1 }, (_, i) => entry(`e${i}`))
    const { client } = makeFakeClient({ research: { activityLog: existing } })
    const log = await appendResearchActivity(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      entries: [entry('new1'), entry('new2'), entry('new3')],
    })
    expect(log).toHaveLength(MAX_ACTIVITY_ENTRIES)
    // The earliest entries are kept; the overflow is dropped from the end.
    expect(log![0]).toEqual(entry('e0'))
  })

  it('returns [] for an empty entries array without touching the DB', async () => {
    const { client, state } = makeFakeClient({ research: {} })
    const log = await appendResearchActivity(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      entries: [],
    })
    expect(log).toEqual([])
    expect(state.updated).toBeUndefined()
  })

  it('returns null when no member row matches', async () => {
    const { client } = makeFakeClient(null)
    const log = await appendResearchActivity(client, {
      userId: 'nope',
      workspaceId: 'ws-1',
      entries: [entry('c1')],
    })
    expect(log).toBeNull()
  })

  it('survives a concurrent sibling write via the CAS retry loop', async () => {
    const { client, state } = makeFakeClient(
      { research: { activityLog: [entry('c1')] } },
      {
        onConcurrentWrite: () => {
          state.progress = {
            ...(state.progress as Record<string, unknown>),
            tutorial: { step_nine: true },
          }
          state.version += 1
          state.updatedAt = `v${state.version}`
        },
      },
    )
    const log = await appendResearchActivity(client, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      entries: [entry('c2')],
    })
    expect(log).toEqual([entry('c1'), entry('c2')])
    const written = state.updated as Record<string, unknown>
    expect(written.tutorial).toEqual({ step_nine: true })
  })
})
