import { describe, it, expect } from 'vitest'
import {
  asanaWriteForBucket,
  bucketForCategory,
  deriveLinearStateMap,
  isCanceledStatusName,
  jiraCategoryForBucket,
  jiraRemoteState,
  jiraTargetForBucket,
  linearBucketForStateType,
  linearRemoteState,
  linearTargetForBucket,
  LIFECYCLE_BUCKETS,
  type LifecycleBucket,
  type LinearStateType,
} from '../lifecycle'

/**
 * Tests for src/lib/tasks/lifecycle.ts — the provider-agnostic mapping layer.
 *
 * The whole category→bucket table is enumerated explicitly rather than
 * spot-checked, because it is the shared trunk EVERY provider adapter inherits:
 *  - backlog AND unstarted both fold to not_started (no provider models the
 *    Dial8 distinction).
 *  - an unknown/absent category degrades to not_started, never throws.
 *  - Asana: done AND canceled both write completed:true (Asana has no cancel).
 *  - the section half is independent of the completion half, and absent/blank
 *    mappings read as null ("don't move").
 *
 * The Jira half below is the SECOND adapter through that trunk, and its job here
 * is to prove the two adapters are genuinely independent: the same bucket drives
 * both, and nothing about adding Jira changed a single Asana expectation above.
 *
 * The Linear half is the THIRD, and it is where the trunk's value shows: its
 * seven-value state type folds onto the same four buckets with no heuristic at
 * all, and again without touching an expectation above it.
 */

describe('bucketForCategory — the full category table', () => {
  const table: Array<[string, LifecycleBucket]> = [
    ['backlog', 'not_started'],
    ['unstarted', 'not_started'],
    ['started', 'in_progress'],
    ['completed', 'done'],
    ['canceled', 'canceled'],
  ]

  for (const [category, bucket] of table) {
    it(`folds '${category}' to '${bucket}'`, () => {
      expect(bucketForCategory(category)).toBe(bucket)
    })
  }

  it('collapses backlog and unstarted onto the SAME bucket', () => {
    expect(bucketForCategory('backlog')).toBe(bucketForCategory('unstarted'))
  })

  it('degrades an unknown category to not_started rather than throwing', () => {
    for (const unknown of ['', 'blocked', 'triage', 'DONE', 'in_progress']) {
      expect(bucketForCategory(unknown)).toBe('not_started')
    }
  })

  it('covers every declared bucket except none — the fold is total', () => {
    const produced = new Set(table.map(([, b]) => b))
    expect([...produced].sort()).toEqual([...LIFECYCLE_BUCKETS].sort())
  })
})

describe('asanaWriteForBucket — completion flag', () => {
  it('writes completed:false for not_started and in_progress', () => {
    expect(asanaWriteForBucket('not_started', null).completed).toBe(false)
    expect(asanaWriteForBucket('in_progress', null).completed).toBe(false)
  })

  it('writes completed:true for done', () => {
    expect(asanaWriteForBucket('done', null).completed).toBe(true)
  })

  it('writes completed:true for canceled — Asana cannot represent a cancel', () => {
    expect(asanaWriteForBucket('canceled', null).completed).toBe(true)
    // Deliberately identical to done: the ONLY way to tell them apart in Asana
    // is the section map.
    expect(asanaWriteForBucket('canceled', null).completed).toBe(
      asanaWriteForBucket('done', null).completed,
    )
  })
})

describe('asanaWriteForBucket — section resolution', () => {
  const fullMap = {
    not_started: 's-todo',
    in_progress: 's-doing',
    done: 's-done',
    canceled: 's-cancelled',
  }

  it('returns the mapped section for each bucket', () => {
    for (const bucket of LIFECYCLE_BUCKETS) {
      expect(asanaWriteForBucket(bucket, fullMap).sectionGid).toBe(fullMap[bucket])
    }
  })

  it('returns null for a null section map (unconfigured project)', () => {
    for (const bucket of LIFECYCLE_BUCKETS) {
      expect(asanaWriteForBucket(bucket, null).sectionGid).toBeNull()
    }
  })

  it('returns null for an undefined section map', () => {
    expect(asanaWriteForBucket('done', undefined).sectionGid).toBeNull()
  })

  it('returns null for a bucket explicitly mapped to null ("don\'t move")', () => {
    expect(asanaWriteForBucket('canceled', { ...fullMap, canceled: null }).sectionGid).toBeNull()
  })

  it('returns null for a bucket absent from a partial map', () => {
    expect(asanaWriteForBucket('canceled', { done: 's-done' }).sectionGid).toBeNull()
  })

  it('treats an empty-string gid as unmapped', () => {
    expect(asanaWriteForBucket('done', { done: '' }).sectionGid).toBeNull()
  })

  it('keeps the completion flag independent of the section mapping', () => {
    expect(asanaWriteForBucket('done', null).completed).toBe(true)
    expect(asanaWriteForBucket('done', { done: 's-done' }).completed).toBe(true)
    expect(asanaWriteForBucket('in_progress', { in_progress: 's-doing' }).completed).toBe(false)
  })
})

// ---- Jira adapter ----------------------------------------------------------

describe('jiraTargetForBucket — explicit status mapping', () => {
  const fullMap = {
    not_started: '10000',
    in_progress: '3',
    done: '10001',
    canceled: '10002',
  }

  it('returns the mapped status id for each bucket', () => {
    for (const bucket of LIFECYCLE_BUCKETS) {
      expect(jiraTargetForBucket(bucket, fullMap)).toBe(fullMap[bucket])
    }
  })

  it('returns null for a null/undefined map (unconfigured destination)', () => {
    for (const bucket of LIFECYCLE_BUCKETS) {
      expect(jiraTargetForBucket(bucket, null)).toBeNull()
      expect(jiraTargetForBucket(bucket, undefined)).toBeNull()
    }
  })

  it('returns null for a bucket explicitly mapped to null ("use the category")', () => {
    expect(jiraTargetForBucket('canceled', { ...fullMap, canceled: null })).toBeNull()
  })

  it('returns null for a bucket absent from a partial map', () => {
    expect(jiraTargetForBucket('canceled', { done: '10001' })).toBeNull()
  })

  it('treats an empty-string status id as unmapped', () => {
    expect(jiraTargetForBucket('done', { done: '' })).toBeNull()
  })
})

describe('jiraCategoryForBucket — the 4→3 fold', () => {
  const table: Array<[LifecycleBucket, string]> = [
    ['not_started', 'new'],
    ['in_progress', 'indeterminate'],
    ['done', 'done'],
    ['canceled', 'done'],
  ]

  for (const [bucket, category] of table) {
    it(`folds '${bucket}' to statusCategory '${category}'`, () => {
      expect(jiraCategoryForBucket(bucket)).toBe(category)
    })
  }

  it('COLLIDES done and canceled — Jira has no canceled category', () => {
    // This collision is the entire reason isCanceledStatusName exists: within
    // the done category, the status NAME (or the resolution) is the only signal
    // separating "finished" from "abandoned".
    expect(jiraCategoryForBucket('canceled')).toBe(jiraCategoryForBucket('done'))
  })

  it('emits only the three real statusCategory keys', () => {
    const produced = new Set(LIFECYCLE_BUCKETS.map((b) => jiraCategoryForBucket(b)))
    expect([...produced].sort()).toEqual(['done', 'indeterminate', 'new'])
  })

  it('is total over every bucket the category fold can produce', () => {
    for (const category of ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'nonsense']) {
      expect(['new', 'indeterminate', 'done']).toContain(
        jiraCategoryForBucket(bucketForCategory(category)),
      )
    }
  })
})

describe('isCanceledStatusName — the done-category tie-breaker', () => {
  it('matches the common cancel spellings', () => {
    for (const name of [
      'Cancelled',
      'Canceled',
      'CANCELLED',
      "Won't Do",
      "won't fix",
      'Declined',
      'Rejected',
      'Abandoned',
    ]) {
      expect(isCanceledStatusName(name)).toBe(true)
    }
  })

  it('normalizes the CURLY apostrophe Jira UIs love to insert', () => {
    // A status typed in the Jira admin UI routinely carries U+2019, not '.
    expect(isCanceledStatusName('Won’t Do')).toBe(true)
    expect(isCanceledStatusName('Won‘t Fix')).toBe(true)
  })

  it('tolerates missing apostrophes and odd separators', () => {
    expect(isCanceledStatusName('Wont do')).toBe(true)
    expect(isCanceledStatusName('WONT-FIX')).toBe(true)
  })

  it('matches a cancel word inside a longer name', () => {
    expect(isCanceledStatusName('Rejected by QA')).toBe(true)
    expect(isCanceledStatusName('Cancelled (duplicate)')).toBe(true)
  })

  it('does NOT match ordinary done/open status names', () => {
    for (const name of [
      'Done',
      'Complete',
      'Completed',
      'Closed',
      'To Do',
      'In Progress',
      'In Review',
      'Shipped',
    ]) {
      expect(isCanceledStatusName(name)).toBe(false)
    }
  })

  it('does NOT match on a substring that is not its own word', () => {
    // Whole-word matching is what keeps a bespoke status from being read as a
    // cancel because it happens to contain the letters.
    expect(isCanceledStatusName('Uncancelledish')).toBe(false)
    expect(isCanceledStatusName('Rejectedness')).toBe(false)
  })

  it('is false for empty/absent input rather than throwing', () => {
    expect(isCanceledStatusName(null)).toBe(false)
    expect(isCanceledStatusName(undefined)).toBe(false)
    expect(isCanceledStatusName('')).toBe(false)
    expect(isCanceledStatusName('   ')).toBe(false)
    expect(isCanceledStatusName('---')).toBe(false)
  })
})

/**
 * The READ-BACK fold: a live Jira status → the arguments applyRemoteTaskState
 * takes. This is the piece that keeps the two directions of the sync agreeing
 * about what a status means; when it collapsed to a bare boolean, the echo
 * "corrected" the user's own Jira change (see jira-loop-termination brakes 3+4).
 */
describe('jiraRemoteState — the read-back fold', () => {
  it('folds a plain done status to a completion, with no refinement', () => {
    expect(jiraRemoteState('done', 'Done')).toEqual({ remoteCompleted: true })
    expect(jiraRemoteState('done', 'Erledigt')).toEqual({ remoteCompleted: true })
  })

  it('flags a cancel-NAMED done status as a cancellation', () => {
    // The category cannot express this — Jira has no canceled one — so the name
    // is the only signal, and it travels as a refinement, not as "not done".
    expect(jiraRemoteState('done', "Won't Do")).toEqual({
      remoteCompleted: true,
      remoteCanceled: true,
    })
    expect(jiraRemoteState('done', 'Rejected')).toEqual({
      remoteCompleted: true,
      remoteCanceled: true,
    })
  })

  it('carries the OPEN category through, so a reopen knows where to land', () => {
    expect(jiraRemoteState('indeterminate', 'In Progress')).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'indeterminate' },
    })
    expect(jiraRemoteState('new', 'To Do')).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'new' },
    })
  })

  it('degrades an unknown/absent category to `new` rather than throwing', () => {
    // Same conservative default as bucketForCategory: a status category this
    // build has not heard of must never fail a sweep.
    expect(jiraRemoteState(null, 'Whatever')).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'new' },
    })
    expect(jiraRemoteState('brand-new-enum', null)).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'new' },
    })
  })

  it('never reads a cancel NAME outside the done category', () => {
    // "Cancelled" as an in-progress status would be a bizarre workflow, but the
    // name heuristic must stay scoped to the ambiguity it exists to resolve.
    expect(jiraRemoteState('indeterminate', 'Cancelled')).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'indeterminate' },
    })
  })
})

// ---- Linear adapter --------------------------------------------------------

/**
 * The SEVEN documented values of `WorkflowState.type`, enumerated here rather
 * than spot-checked for the same reason the category table above is: this is the
 * whole contract with Linear, and the value most likely to be missed —
 * `duplicate` — is invisible in any test that only covers "the obvious ones".
 */
describe('linearBucketForStateType — the full 7-value fold', () => {
  const table: Array<[LinearStateType, LifecycleBucket]> = [
    ['triage', 'not_started'],
    ['backlog', 'not_started'],
    ['unstarted', 'not_started'],
    ['started', 'in_progress'],
    ['completed', 'done'],
    ['canceled', 'canceled'],
    ['duplicate', 'canceled'],
  ]

  it.each(table)('folds %s → %s', (type, bucket) => {
    expect(linearBucketForStateType(type)).toBe(bucket)
  })

  it('covers all SEVEN documented types — none forgotten', () => {
    expect(table).toHaveLength(7)
  })

  /**
   * The one fold a reader is most likely to get wrong. An issue closed as a
   * duplicate is ABANDONED work, not finished work: folding it to `done` would
   * complete the Dial8 action and tell the team the work shipped.
   */
  it('folds duplicate onto CANCELED, alongside canceled — not onto done', () => {
    expect(linearBucketForStateType('duplicate')).toBe('canceled')
    expect(linearBucketForStateType('duplicate')).toBe(linearBucketForStateType('canceled'))
    expect(linearBucketForStateType('duplicate')).not.toBe(linearBucketForStateType('completed'))
  })

  it('collapses all THREE open types onto not_started', () => {
    const open = (['triage', 'backlog', 'unstarted'] as const).map(linearBucketForStateType)
    expect(new Set(open)).toEqual(new Set(['not_started']))
  })

  /**
   * The deliberate divergence from bucketForCategory, which defaults an unknown
   * value to `not_started`. That function folds OUR schema, where an unknown
   * value is build skew. This one folds THEIRS, where an unknown value means
   * Linear shipped a type this build has never seen — and quietly calling it
   * "not started" would let the read-back reopen work a user just closed.
   */
  it('returns NULL for an unknown or absent type rather than defaulting', () => {
    expect(linearBucketForStateType('shipped')).toBeNull()
    expect(linearBucketForStateType('')).toBeNull()
    expect(linearBucketForStateType(null)).toBeNull()
    expect(linearBucketForStateType(undefined)).toBeNull()
  })

  it('is case-sensitive — Linear sends lowercase and nothing else is a type', () => {
    expect(linearBucketForStateType('Started')).toBeNull()
    expect(linearBucketForStateType('COMPLETED')).toBeNull()
  })
})

describe('linearRemoteState — derived from the TYPE, never from the name', () => {
  it('reads a completed state as done', () => {
    expect(linearRemoteState('completed')).toEqual({ remoteCompleted: true })
  })

  it('reads BOTH canceled and duplicate as closed-but-abandoned', () => {
    const abandoned = { remoteCompleted: true, remoteCanceled: true }
    expect(linearRemoteState('canceled')).toEqual(abandoned)
    expect(linearRemoteState('duplicate')).toEqual(abandoned)
  })

  it('reads a started state as open + indeterminate', () => {
    expect(linearRemoteState('started')).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'indeterminate' },
    })
  })

  it('reads the three open types as open + new', () => {
    for (const type of ['triage', 'backlog', 'unstarted'] as const) {
      expect(linearRemoteState(type)).toEqual({
        remoteCompleted: false,
        remoteHint: { category: 'new' },
      })
    }
  })

  it('reads an unknown type conservatively as open', () => {
    // Callers are expected to check linearBucketForStateType FIRST and skip
    // applying at all; if one doesn't, "still open" is the reading that cannot
    // close an action Linear never closed.
    expect(linearRemoteState('shipped')).toEqual({
      remoteCompleted: false,
      remoteHint: { category: 'new' },
    })
    expect(linearRemoteState(null)).toMatchObject({ remoteCompleted: false })
  })

  /**
   * The point of the whole adapter. jiraRemoteState has to run
   * isCanceledStatusName over a human status NAME to separate the two halves of
   * Jira's `done` category. Linear names both outcomes in the type, so the name
   * is never consulted — which is why a Linear team whose DONE state is called
   * "Rejected" is read correctly here and would be misread by the Jira heuristic.
   */
  it('does NOT consult the state name — a done state named "Rejected" reads as DONE', () => {
    // The name the Jira heuristic would flag as a cancellation…
    expect(isCanceledStatusName('Rejected')).toBe(true)
    // …changes nothing here, because only the type is consulted.
    expect(linearRemoteState('completed')).toEqual({ remoteCompleted: true })
    expect(linearRemoteState('completed')).not.toHaveProperty('remoteCanceled')
  })
})

describe('linearTargetForBucket', () => {
  const fullMap = {
    not_started: { id: 's-todo', name: 'Todo' },
    in_progress: { id: 's-doing', name: 'In Progress' },
    done: { id: 's-done', name: 'Done' },
    canceled: { id: 's-cancelled', name: 'Canceled' },
  }

  it.each(LIFECYCLE_BUCKETS)('reads the mapped state id for %s', (bucket) => {
    expect(linearTargetForBucket(fullMap, bucket)).toBe(fullMap[bucket].id)
  })

  it.each(LIFECYCLE_BUCKETS)('returns null for %s with no map at all', (bucket) => {
    expect(linearTargetForBucket(null, bucket)).toBeNull()
    expect(linearTargetForBucket(undefined, bucket)).toBeNull()
    expect(linearTargetForBucket({}, bucket)).toBeNull()
  })

  it('returns null for an ABSENT bucket — the team has no such state', () => {
    // The ordinary case, not an error: Linear does not guarantee a team has a
    // canceled-type state.
    const { canceled: _canceled, ...noCancel } = fullMap
    expect(linearTargetForBucket(noCancel, 'canceled')).toBeNull()
    expect(linearTargetForBucket(noCancel, 'done')).toBe('s-done')
  })

  it('treats a blank or missing id as unmapped', () => {
    expect(linearTargetForBucket({ done: { id: '', name: 'Done' } }, 'done')).toBeNull()
    expect(
      linearTargetForBucket(
        { done: { name: 'Done' } as unknown as { id: string; name: string } },
        'done',
      ),
    ).toBeNull()
  })
})

describe('deriveLinearStateMap', () => {
  const FULL = [
    { id: 's-triage', name: 'Triage', type: 'triage', position: 0 },
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 1 },
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 2 },
    { id: 's-doing', name: 'In Progress', type: 'started', position: 3 },
    { id: 's-done', name: 'Done', type: 'completed', position: 4 },
    { id: 's-cancelled', name: 'Canceled', type: 'canceled', position: 5 },
  ]

  it('derives all four buckets from a fully-equipped team', () => {
    expect(deriveLinearStateMap(FULL)).toEqual({
      not_started: { id: 's-todo', name: 'Todo' },
      in_progress: { id: 's-doing', name: 'In Progress' },
      done: { id: 's-done', name: 'Done' },
      canceled: { id: 's-cancelled', name: 'Canceled' },
    })
  })

  /**
   * The preference order matters: `unstarted` ("Todo") is where a team expects
   * queued work, and `backlog`/`triage` are parking lots. A pushed action landing
   * in Triage instead of Todo is the difference between work someone picks up
   * and work nobody sees.
   */
  it('prefers unstarted over backlog over triage for not_started', () => {
    expect(deriveLinearStateMap(FULL).not_started).toEqual({ id: 's-todo', name: 'Todo' })

    const noUnstarted = FULL.filter((s) => s.type !== 'unstarted')
    expect(deriveLinearStateMap(noUnstarted).not_started).toEqual({
      id: 's-backlog',
      name: 'Backlog',
    })

    const triageOnly = FULL.filter((s) => s.type === 'triage')
    expect(deriveLinearStateMap(triageOnly).not_started).toEqual({
      id: 's-triage',
      name: 'Triage',
    })
  })

  /**
   * The common real-world team shape, and the reason a bucket is ABSENT rather
   * than null: the echo has to be able to tell "this team cannot express
   * canceled" (decline) from "canceled is mapped to nothing" (which would read
   * as a configuration bug).
   */
  it('OMITS a bucket the team has no state for — a team with no canceled state', () => {
    const noCancel = FULL.filter((s) => s.type !== 'canceled')
    const map = deriveLinearStateMap(noCancel)

    expect(map).not.toHaveProperty('canceled')
    expect(linearTargetForBucket(map, 'canceled')).toBeNull()
    // …and the other three are unaffected.
    expect(map.done).toEqual({ id: 's-done', name: 'Done' })
  })

  /**
   * `duplicate` is a legitimate READ signal (an issue someone closed as a
   * duplicate folds to canceled) but must NEVER be a write target: marking a
   * Dial8 action's issue as a duplicate of nothing is a claim about the
   * customer's backlog that Dial8 has no basis to make.
   */
  it('NEVER picks a duplicate-type state as a write target', () => {
    const withDuplicate = [
      ...FULL.filter((s) => s.type !== 'canceled'),
      { id: 's-dupe', name: 'Duplicate', type: 'duplicate', position: 6 },
    ]
    const map = deriveLinearStateMap(withDuplicate)

    // The canceled bucket stays EMPTY rather than borrowing the duplicate state.
    expect(map).not.toHaveProperty('canceled')
    expect(JSON.stringify(map)).not.toContain('s-dupe')
  })

  it('breaks a same-type tie on the LOWEST position — Linear board order', () => {
    const twoTodos = [
      { id: 's-ready', name: 'Ready', type: 'unstarted', position: 5 },
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 2 },
    ]
    expect(deriveLinearStateMap(twoTodos).not_started).toEqual({ id: 's-todo', name: 'Todo' })
  })

  it('sorts a state with NO position LAST rather than as zero', () => {
    // `undefined` must not outrank a real position just because it isn't a
    // number — otherwise an unpositioned state silently wins every tie.
    const mixed = [
      { id: 's-nopos', name: 'No position', type: 'unstarted' },
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 9 },
    ]
    expect(deriveLinearStateMap(mixed).not_started).toEqual({ id: 's-todo', name: 'Todo' })
  })

  it('picks the only candidate even when it has no position', () => {
    const single = [{ id: 's-todo', name: 'Todo', type: 'unstarted' }]
    expect(deriveLinearStateMap(single).not_started).toEqual({ id: 's-todo', name: 'Todo' })
  })

  it('returns an EMPTY map for a team with no usable states', () => {
    expect(deriveLinearStateMap([])).toEqual({})
    // A type this build has never heard of can never be a write target.
    expect(deriveLinearStateMap([{ id: 's-x', name: 'X', type: 'shipped' }])).toEqual({})
  })

  it('ignores states with no id — they cannot be written to', () => {
    const map = deriveLinearStateMap([
      { name: 'Todo', type: 'unstarted', position: 0 },
      { id: '', name: 'Blank', type: 'unstarted', position: 1 },
      { id: 's-todo', name: 'Real Todo', type: 'unstarted', position: 2 },
    ])
    expect(map.not_started).toEqual({ id: 's-todo', name: 'Real Todo' })
  })

  it('falls back to the id when a state has no name — never an empty label', () => {
    const map = deriveLinearStateMap([{ id: 's-todo', type: 'unstarted', position: 0 }])
    expect(map.not_started).toEqual({ id: 's-todo', name: 's-todo' })
  })

  it('is PURE — the settings save and the states route can never disagree', () => {
    // Both call this same function on the same input, which is the entire
    // reason the derived map shown read-only in settings matches what a push
    // actually does.
    expect(deriveLinearStateMap(FULL)).toEqual(deriveLinearStateMap([...FULL].reverse()))
  })
})

describe('lifecycle — the three adapters are independent', () => {
  it('reads the SAME bucket into three unrelated provider writes', () => {
    const bucket = bucketForCategory('canceled')
    // Asana: a boolean, computed offline.
    expect(asanaWriteForBucket(bucket, { canceled: 's-cancelled' })).toEqual({
      completed: true,
      sectionGid: 's-cancelled',
    })
    // Jira: a target status id (or nothing) — the write itself is a transition
    // lookup that can only happen against a live issue.
    expect(jiraTargetForBucket(bucket, { canceled: '10002' })).toBe('10002')
    expect(jiraCategoryForBucket(bucket)).toBe('done')
    // Linear: a state id, settable directly — no transition graph, and no name
    // heuristic needed to know this bucket means abandoned rather than finished.
    expect(
      linearTargetForBucket({ canceled: { id: 's-cancelled', name: 'Canceled' } }, bucket),
    ).toBe('s-cancelled')
  })
})
