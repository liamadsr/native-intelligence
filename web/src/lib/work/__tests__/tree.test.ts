/**
 * tree.ts + partitionWorkTrees — a handoff's row under the row that handed it
 * the work (Part 5 row 14): the forest, when a child is reviewed with its root,
 * the subtree summary, and the lanes.
 */
import { describe, it, expect } from 'vitest'
import type { WorkItem } from '../types'
import {
  buildWorkForest,
  descendantsOf,
  foldsIntoRoot,
  rowsOf,
  subtreeSummary,
  treeRootId,
} from '../tree'
import { partitionWorkTrees } from '../presentation'

let seq = 0
function row(over: Partial<WorkItem> & { id: string }): WorkItem {
  seq += 1
  return {
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: over.id,
    status: 'done',
    actor: 'agent',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: null,
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: `2026-09-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: null,
    deadline_at: null,
    parent_id: null,
    root_id: null,
    depth: 0,
    ...over,
  } as WorkItem
}
const researcher = { id: 'tm-r', name: 'Researcher', is_system: false, system_key: null, role: 'researcher' }

describe('buildWorkForest', () => {
  it('nests a child under its parent, a grandchild under its child, and keeps the roots in order', () => {
    const root = row({ id: 'root' })
    const child = row({ id: 'child', parent_id: 'root', root_id: 'root', depth: 1 })
    const grand = row({ id: 'grand', parent_id: 'child', root_id: 'root', depth: 2 })
    const other = row({ id: 'other' })
    const forest = buildWorkForest([grand, other, root, child])
    expect(forest.map((t) => t.item.id)).toEqual(['other', 'root'])
    const tree = forest.find((t) => t.item.id === 'root')!
    expect(tree.children.map((t) => t.item.id)).toEqual(['child'])
    expect(tree.children[0].children.map((t) => t.item.id)).toEqual(['grand'])
    expect(rowsOf(tree).map((r) => r.id)).toEqual(['root', 'child', 'grand'])
    expect(descendantsOf(tree).map((r) => r.id)).toEqual(['child', 'grand'])
  })

  it('a child whose parent is not loaded nests under its root, and one with neither is its own root', () => {
    const root = row({ id: 'root' })
    const grand = row({ id: 'grand', parent_id: 'gone', root_id: 'root', depth: 2 })
    const orphan = row({ id: 'orphan', parent_id: 'aged-out', root_id: 'aged-out', depth: 1 })
    const forest = buildWorkForest([root, grand, orphan])
    expect(forest.map((t) => t.item.id)).toEqual(['root', 'orphan'])
    expect(forest[0].children.map((t) => t.item.id)).toEqual(['grand'])
  })

  it('siblings are oldest first, and a malformed cycle never nests a row under itself', () => {
    const root = row({ id: 'root' })
    const b = row({ id: 'b', parent_id: 'root', root_id: 'root' })
    const a = row({ id: 'a', parent_id: 'root', root_id: 'root', created_at: '2026-09-28T00:00:00.000Z' })
    expect(buildWorkForest([root, b, a])[0].children.map((t) => t.item.id)).toEqual(['a', 'b'])
    const x = row({ id: 'x', parent_id: 'y' })
    const y = row({ id: 'y', parent_id: 'x' })
    const forest = buildWorkForest([x, y])
    expect(forest.flatMap(rowsOf).map((r) => r.id).sort()).toEqual(['x', 'y'])
  })

  it('treeRootId is the root for a child and the row itself for a root', () => {
    expect(treeRootId(row({ id: 'c', root_id: 'r' }))).toBe('r')
    expect(treeRootId(row({ id: 'r' }))).toBe('r')
  })
})

describe('foldsIntoRoot', () => {
  const child = (status: WorkItem['status']) => row({ id: 'c', parent_id: 'r', root_id: 'r', status })
  it('a child waiting on review is reviewed with a root that is still working or waiting on the person', () => {
    for (const rootStatus of ['queued', 'running', 'waiting_on_child', 'needs_input', 'needs_review']) {
      expect(foldsIntoRoot(child('needs_review'), () => rootStatus)).toBe(true)
    }
  })
  it('stands alone once its root settled some other way, or when the root is unknown', () => {
    for (const rootStatus of ['done', 'failed', 'canceled', 'skipped']) {
      expect(foldsIntoRoot(child('needs_review'), () => rootStatus)).toBe(false)
    }
    expect(foldsIntoRoot(child('needs_review'), () => undefined)).toBe(false)
  })
  it('a question never folds, and neither does a root', () => {
    expect(foldsIntoRoot(child('needs_input'), () => 'running')).toBe(false)
    expect(foldsIntoRoot(row({ id: 'r', status: 'needs_review' }), () => 'running')).toBe(false)
  })
})

describe('subtreeSummary', () => {
  it('names the one teammate, counts several, and counts refusals apart', () => {
    const root = row({ id: 'r' })
    const c1 = row({ id: 'c1', parent_id: 'r', root_id: 'r', teammate: researcher })
    expect(subtreeSummary(buildWorkForest([root, c1])[0])).toBe('Handed to Researcher')
    const c2 = row({ id: 'c2', parent_id: 'r', root_id: 'r' })
    const refused = row({ id: 'c3', parent_id: 'r', root_id: 'r', status: 'skipped' })
    expect(subtreeSummary(buildWorkForest([root, c1, c2, refused])[0])).toBe('2 handoffs · 1 refused')
    expect(subtreeSummary(buildWorkForest([root, refused])[0])).toBe('1 refused')
    expect(subtreeSummary(buildWorkForest([root])[0])).toBeNull()
  })
})

describe('partitionWorkTrees', () => {
  it('a tree sits in its root’s lane, with its handoffs under it', () => {
    const root = row({ id: 'r', status: 'waiting_on_child', started_at: '2026-09-29T01:00:00.000Z' })
    const child = row({ id: 'c', parent_id: 'r', root_id: 'r', status: 'running' })
    const out = partitionWorkTrees([child, root])
    expect(out.running.map((t) => t.item.id)).toEqual(['r'])
    expect(out.running[0].children.map((t) => t.item.id)).toEqual(['c'])
    expect(out.needsYou).toEqual([])
    expect(out.recent).toEqual([])
  })

  it('a child waiting on review under a working root folds into it; after the root fails it stands in Needs you', () => {
    const child = row({ id: 'c', parent_id: 'r', root_id: 'r', status: 'needs_review', finished_at: '2026-09-29T01:00:00.000Z' })
    const working = partitionWorkTrees([row({ id: 'r', status: 'running' }), child])
    expect(working.needsYou).toEqual([])
    expect(working.running[0].children[0].item.id).toBe('c')

    const failed = partitionWorkTrees([row({ id: 'r', status: 'failed', finished_at: '2026-09-29T02:00:00.000Z' }), child])
    expect(failed.recent.map((t) => t.item.id)).toEqual(['r'])
    expect(failed.needsYou.map((t) => t.item.id)).toEqual(['c'])
  })

  it('a child’s question shows in Needs you on its own while its root waits on it', () => {
    const out = partitionWorkTrees([
      row({ id: 'r', status: 'waiting_on_child' }),
      row({ id: 'c', parent_id: 'r', root_id: 'r', status: 'needs_input' }),
    ])
    expect(out.needsYou.map((t) => t.item.id)).toEqual(['c'])
    expect(out.running.map((t) => t.item.id)).toEqual(['r'])
  })

  it('a root waiting on review carries its folded child in Needs you, once', () => {
    const out = partitionWorkTrees([
      row({ id: 'r', status: 'needs_review' }),
      row({ id: 'c', parent_id: 'r', root_id: 'r', status: 'needs_review' }),
    ])
    expect(out.needsYou.map((t) => t.item.id)).toEqual(['r'])
    expect(out.needsYou[0].children.map((t) => t.item.id)).toEqual(['c'])
  })
})
