// @vitest-environment jsdom
/**
 * THE PROVIDER'S POST-MOUNT HYDRATE.
 *
 * `initialComments` seeds useState exactly once, so a caller that mounts the
 * provider BEFORE its comments fetch resolves (the capture panel renders the
 * editor immediately instead of gating the body on the fetch) hands the server
 * list in later — via the same prop. The hydrate effect merges those arrivals
 * BY ID. Two behaviors are load-bearing:
 *
 *  - SERVER ROWS LAND. A provider mounted with [] shows the server's comments
 *    once they arrive; a refreshed row (same id) replaces its older copy.
 *  - OPTIMISTIC LOCAL COMMENTS SURVIVE. A comment added in this session can be
 *    absent from an older server snapshot resolving after it — hydrating that
 *    snapshot must merge around it, never clobber it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { InlineCommentProvider, useInlineComments } from '../inline-comment-context'
import type { CommentAPI, CommentIdentity, UnifiedComment } from '../types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const identity: CommentIdentity = {
  mode: 'authenticated',
  memberId: 'm-1',
  displayName: 'Liam',
  avatarUrl: null,
}

function makeComment(id: string, overrides: Partial<UnifiedComment> = {}): UnifiedComment {
  return {
    id,
    content: `content ${id}`,
    author_name: 'Liam',
    author_avatar: null,
    author_id: 'm-1',
    author_email: null,
    parent_id: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    // Anchored — only anchored top-level comments surface in ctx.comments.
    anchor_text: `anchor ${id}`,
    anchor_prefix: '',
    anchor_suffix: '',
    anchor_section: 'capture',
    anchor_occurrence: 0,
    is_resolved: false,
    ...overrides,
  }
}

describe('InlineCommentProvider hydrate', () => {
  let container: HTMLDivElement
  let root: Root
  // The freshest context value, captured by the probe on every render.
  let ctx: ReturnType<typeof useInlineComments> | null = null

  function Probe() {
    ctx = useInlineComments()
    return null
  }

  const api: CommentAPI = {
    postComment: vi.fn(async (body: Record<string, unknown>) =>
      makeComment('c-local', { content: body.content as string, anchor_text: body.anchor_text as string }),
    ),
    resolveComment: vi.fn(async () => true),
  }

  function render(initialComments: UnifiedComment[]) {
    act(() => {
      root.render(
        h(InlineCommentProvider, { initialComments, identity, api, children: h(Probe) }),
      )
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    ctx = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('seeds from initialComments at mount', () => {
    render([makeComment('c-1')])
    expect(ctx!.comments.map((c) => c.id)).toEqual(['c-1'])
  })

  it('hydrates server comments that arrive after mount (empty seed)', () => {
    render([])
    expect(ctx!.comments).toEqual([])

    render([makeComment('c-1'), makeComment('c-2')])
    expect(ctx!.comments.map((c) => c.id).sort()).toEqual(['c-1', 'c-2'])
  })

  it('replaces an existing row by id on hydrate', () => {
    render([makeComment('c-1', { content: 'old' })])
    render([makeComment('c-1', { content: 'new' })])
    expect(ctx!.comments).toHaveLength(1)
    expect(ctx!.comments[0].content).toBe('new')
  })

  it('ignores a hydrate whose rows are value-identical fresh clones (no re-render loop)', () => {
    // The share page maps a NEW array (new row objects) every render — a
    // reference-based merge would see every row as changed and loop forever.
    const createdAt = '2026-08-04T00:00:00.000Z'
    render([makeComment('c-1', { created_at: createdAt })])
    const before = ctx!.comments
    render([makeComment('c-1', { created_at: createdAt })])
    // Same state reference ⇒ the derived comments memo kept its identity too.
    expect(ctx!.comments).toBe(before)
  })

  it('keeps an optimistically-added local comment absent from the server snapshot', async () => {
    render([])

    // Optimistic add: select a range, post a comment through the ctx API.
    act(() => {
      ctx!.setSelectionState({
        text: 'selected',
        prefix: '',
        suffix: '',
        section: 'capture',
        occurrenceIndex: 0,
        rect: {} as DOMRect,
      })
    })
    await act(async () => {
      await ctx!.addInlineComment('local note')
    })
    expect(ctx!.comments.map((c) => c.id)).toEqual(['c-local'])

    // An older server snapshot (fetched before the add) resolves now — it must
    // merge around the local comment, not clobber it.
    render([makeComment('c-1')])
    expect(ctx!.comments.map((c) => c.id).sort()).toEqual(['c-1', 'c-local'])
  })

  // ── Local mutations vs stale re-hydrates ──────────────────────────────────
  // The callers' initialComments are FROZEN snapshots (the capture panel's
  // rawInlineComments is fetched once at mount; the share page maps a server
  // prop), so any re-derivation of the prop AFTER a local mutation — e.g. an
  // identity change from a workspace-cache refresh() rebuilding the mapped
  // array — replays stale rows. Locally-mutated ids must be excluded from the
  // merge: deleted rows never resurrect, edited/resolved rows keep the local copy.

  it('does not resurrect a locally-deleted comment on a later stale hydrate', async () => {
    render([makeComment('c-1'), makeComment('c-2')])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))

    await act(async () => {
      await ctx!.deleteComment('c-1')
    })
    expect(ctx!.comments.map((c) => c.id)).toEqual(['c-2'])

    // Identity churn re-derives the frozen snapshot → re-hydrate. c-1 must
    // stay gone; a genuinely new row (c-3) still lands.
    render([makeComment('c-1'), makeComment('c-2'), makeComment('c-3')])
    expect(ctx!.comments.map((c) => c.id).sort()).toEqual(['c-2', 'c-3'])
  })

  it('does not resurrect the ONLY comment after deleting it (wholesale-adopt path)', async () => {
    // Deleting the last comment leaves prev empty — the hydrate's "adopt the
    // incoming list wholesale" fast path must filter mutated ids too.
    render([makeComment('c-1')])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))

    await act(async () => {
      await ctx!.deleteComment('c-1')
    })
    expect(ctx!.comments).toEqual([])

    render([makeComment('c-1')])
    expect(ctx!.comments).toEqual([])
  })

  it('keeps a local edit when a stale snapshot re-hydrates', async () => {
    render([makeComment('c-1', { content: 'original' })])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ comment: { body: 'edited locally', edited_at: '2026-08-04T00:00:01Z' } }),
      })),
    )

    await act(async () => {
      await ctx!.editComment('c-1', 'edited locally')
    })
    expect(ctx!.comments[0].content).toBe('edited locally')

    // The stale snapshot still carries the pre-edit row — it must not win.
    render([makeComment('c-1', { content: 'original' })])
    expect(ctx!.comments[0].content).toBe('edited locally')
    expect(ctx!.comments[0].edited_at).toBe('2026-08-04T00:00:01Z')
  })

  it('keeps a local resolve when a stale snapshot re-hydrates', async () => {
    render([makeComment('c-1', { is_resolved: false })])

    await act(async () => {
      await ctx!.resolveComment('c-1', true)
    })
    expect(ctx!.comments[0].is_resolved).toBe(true)

    render([makeComment('c-1', { is_resolved: false })])
    expect(ctx!.comments[0].is_resolved).toBe(true)
  })
})
