'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOnWorkRow } from '@/components/work/agent-work-provider'
import { createLoadRetry, type LoadOutcome } from '@/lib/load-retry'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { upsertWorkRow } from '@/lib/work/patch-rows'
import { laterSettled } from '@/lib/work/presentation'
import type { TeammateAbout } from '@/lib/work/teammate-about'
import type { EntityChip } from '@/lib/work/touch-summary'
import { treeRootId } from '@/lib/work/tree'
import { isWorkLive, type WorkItem } from '@/lib/work/types'

/**
 * One teammate's work, for its bot (docs/plans/bots-v4.md, "A bot's page"):
 * GET /api/account/agent-work?teammate=<id>, kept live off the shell's own
 * `tracked_job` channel (AgentWorkProvider's useOnWorkRow), so it opens no
 * channel of its own.
 *
 *   scope 'all'   its rows (open ones however old, every one it started in the
 *                 last 14 days, and the other rows of each handoff tree it
 *                 worked in), their chips, its roster entry with its role's
 *                 breaker, whether you may Resume, its last finished row, and
 *                 what its About says (its skills, the custom agent it's
 *                 built on, the loops it fronts: `about`).
 *                 The bot's page. The 14 days are by when a run started
 *                 (`created_at`): a run that started before them and
 *                 settled inside them isn't held.
 *   scope 'last'  only its last finished row (`&last=1`, no rows): the
 *                 bubble's "Last finished", there after a reload too.
 *
 * It loads while a consumer is drawn: pass the teammate's id then, and null
 * otherwise (nothing loads, nothing is held, nothing is heard). Another id or
 * scope starts over, and an answer for one it has left is dropped.
 *
 * A pushed row (the payload is the whole row, without its teammate embed) is
 * patched in when it's this teammate's, or in one of the handoff trees held,
 * in its workspace; an own row that settled later becomes its last finished.
 * A row naming a teammate the rows can't name refetches once (debounced, and
 * once per teammate it names), as useAgentWork does; scope 'last' shows no
 * names, so never. A push that lands while a load is in flight is re-applied
 * over its answer. The channel coming up again (`resync`) reloads it: what
 * was pushed in between was missed.
 *
 * The chips stay fresh off the same pushes (there is no `work_touch`
 * channel). A held row that is running and moved on (a new step or status)
 * may have touched a record its chips don't name yet, so it reloads, at most
 * once per CHIP_REFRESH_RUNNING_MS (a run writes its step every couple of
 * seconds, and each reload is the whole read); a held row that just stopped
 * reloads once, CHIP_REFRESH_SETTLED_MS later, for its last touches. A
 * heartbeat alone, or a row already showing its three chips, never does. A
 * chip reload never starts while a load is in flight (it would drop that
 * load's answer): it waits, and goes once that load has landed.
 *
 * A failed load retries by itself (2 s, 8 s, 30 s, then every 2 minutes;
 * `@/lib/load-retry`), and keeps what it held meanwhile, except a 400, 403 or
 * 404: not a teammate you can read (hidden, another workspace's, a private
 * team's, or one you were just taken off), which asking again won't change.
 * What it held then goes too.
 */
export type BotWorkScope = 'all' | 'last'

export interface BotWork {
  /**
   * Its rows, newest first: open ones however old, every one it started in the
   * last 14 days (by `created_at`), and the other rows of its handoff trees.
   * Empty for scope 'last'. Null until an answer for this teammate holds them.
   */
  rows: WorkItem[] | null
  /** Per row, the entities it touched, named. */
  chips: Record<string, EntityChip[]>
  /** Its roster entry, with its role's breaker (scope 'all'). */
  teammate: RosterTeammate | null
  /** You're an owner or admin of its workspace, so Resume is yours to press. */
  mayResume: boolean
  /** The row it settled last: the answer's, or one it settled since. */
  lastFinished: WorkItem | null
  /** Its skills, the custom agent it's built on and the loops it fronts (scope 'all'; empty until then). */
  about: TeammateAbout
  loading: boolean
  /** The last load failed (or the teammate isn't one you can read). */
  failed: boolean
  refresh: () => Promise<void>
}

export const BOT_WORK_URL = '/api/account/agent-work'
const DEBOUNCE_MS = 400
/** A running row's chips reload at most this often (see the hook). */
export const CHIP_REFRESH_RUNNING_MS = 12_000
/** A row that just stopped reloads its chips this long after (see the hook). */
export const CHIP_REFRESH_SETTLED_MS = 2000
/** The chips a row shows at most (touch-summary pickEntityChips). */
const MAX_CHIPS = 3
/** Answers that say it isn't a teammate you can read: final, and what was held goes. */
const NOT_YOURS = new Set([400, 403, 404])

/** The route for one teammate's work, in a scope. */
export function botWorkUrl(teammateId: string, scope: BotWorkScope): string {
  const url = `${BOT_WORK_URL}?teammate=${encodeURIComponent(teammateId)}`
  return scope === 'last' ? `${url}&last=1` : url
}

interface BotWorkResponse {
  workspace_id?: string
  items?: WorkItem[]
  chips?: Record<string, EntityChip[]>
  teammate?: RosterTeammate | null
  may_resume?: boolean
  last_finished?: WorkItem | null
  skills?: TeammateAbout['skills']
  agent?: TeammateAbout['agent']
  loops?: TeammateAbout['loops']
}

/** What's held for one teammate in one scope. */
interface Held {
  teammateId: string
  scope: BotWorkScope
  workspaceId: string | null
  rows: WorkItem[]
  chips: Record<string, EntityChip[]>
  teammate: RosterTeammate | null
  mayResume: boolean
  lastFinished: WorkItem | null
  about: TeammateAbout
}

const NO_ABOUT: TeammateAbout = { skills: [], agent: null, loops: [] }

function heldFrom(teammateId: string, scope: BotWorkScope, data: BotWorkResponse): Held {
  return {
    teammateId,
    scope,
    workspaceId: typeof data.workspace_id === 'string' ? data.workspace_id : null,
    rows: scope === 'all' && Array.isArray(data.items) ? data.items : [],
    chips: data.chips && typeof data.chips === 'object' ? data.chips : {},
    teammate: data.teammate ?? null,
    mayResume: data.may_resume === true,
    lastFinished: data.last_finished ?? null,
    about: {
      skills: Array.isArray(data.skills) ? data.skills : [],
      agent: data.agent && typeof data.agent === 'object' ? data.agent : null,
      loops: Array.isArray(data.loops) ? data.loops : [],
    },
  }
}

/** Whether a row is one held, or in a handoff tree one held row is in. */
function inHeldTrees(rows: readonly WorkItem[], row: WorkItem): boolean {
  const tree = treeRootId(row)
  return rows.some((r) => r.id === row.id || treeRootId(r) === tree)
}

/**
 * When a pushed row, held before and after, should reload its chips (see the
 * hook), or null: it shows fewer than its three chips, and either it just
 * stopped (CHIP_REFRESH_SETTLED_MS) or it is running and moved on, its step
 * or its status, not just a beat (CHIP_REFRESH_RUNNING_MS).
 */
function chipReloadAfter(before: WorkItem | undefined, row: WorkItem, chips: readonly EntityChip[] | undefined): number | null {
  if (!before || (chips?.length ?? 0) >= MAX_CHIPS) return null
  if (isWorkLive(before.status) && !isWorkLive(row.status)) return CHIP_REFRESH_SETTLED_MS
  if (!isWorkLive(row.status)) return null
  return before.status !== row.status || before.current_step !== row.current_step ? CHIP_REFRESH_RUNNING_MS : null
}

/**
 * A pushed row into what's held (see the hook). `needsTeammate`: it was
 * patched in naming a teammate no held row names.
 */
function applyRow(held: Held, row: WorkItem): { held: Held; needsTeammate: boolean } {
  if (held.workspaceId && row.workspace_id !== held.workspaceId) return { held, needsTeammate: false }
  const own = row.ai_team_member_id === held.teammateId
  let next = held
  let patched = row
  let needsTeammate = false
  if (held.scope === 'all' && (own || inHeldTrees(held.rows, row))) {
    const upserted = upsertWorkRow(held.rows, row)
    patched = upserted.list.find((r) => r.id === row.id) ?? row
    needsTeammate = upserted.needsTeammate
    next = { ...next, rows: upserted.list }
  }
  if (own) {
    // A pushed row carries no teammate embed: it's the one its last finished names.
    const named = patched.teammate || !held.lastFinished?.teammate ? patched : { ...patched, teammate: held.lastFinished.teammate }
    const last = laterSettled(held.lastFinished, named)
    if (last !== held.lastFinished) next = { ...next, lastFinished: last }
  }
  return { held: next, needsTeammate }
}

export function useBotWork(teammateId: string | null, opts: { scope?: BotWorkScope } = {}): BotWork {
  const scope = opts.scope ?? 'all'
  const onWorkRow = useOnWorkRow()
  const [held, setHeld] = useState<Held | null>(null)
  const heldRef = useRef<Held | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  // What's asked now, for a load or a retry that starts later.
  const asked = useRef({ teammateId, scope })
  asked.current = { teammateId, scope }
  // The newest load's number: an older load's answer is dropped, and so is one
  // for a teammate or scope it has since left (the effects bump it).
  const loadSeq = useRef(0)
  const inFlight = useRef(0)
  const pushedDuringLoad = useRef(new Map<string, WorkItem>())
  const refetchedFor = useRef(new Set<string>())
  const [retry] = useState(() => createLoadRetry(() => void refreshRef.current()))
  // The chips' reload (see the doc): its timer, when it's due, and the wait
  // to go with once the load in flight has landed (null: none waiting).
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chipDue = useRef(0)
  const chipAfterLoad = useRef<number | null>(null)
  const cancelChips = useCallback(() => {
    if (chipTimer.current) clearTimeout(chipTimer.current)
    chipTimer.current = null
    chipAfterLoad.current = null
  }, [])
  // A reload `wait` ms from now, unless one is due sooner. One that comes due
  // while a load is in flight waits for it to land.
  const scheduleChips = useCallback((wait: number) => {
    const due = Date.now() + wait
    if (chipTimer.current && chipDue.current <= due) return
    if (chipTimer.current) clearTimeout(chipTimer.current)
    chipDue.current = due
    chipTimer.current = setTimeout(() => {
      chipTimer.current = null
      if (inFlight.current > 0) {
        chipAfterLoad.current = Math.min(chipAfterLoad.current ?? wait, wait)
        return
      }
      void refreshRef.current()
    }, wait)
  }, [])

  const hold = useCallback((next: Held | null) => {
    heldRef.current = next
    setHeld(next)
  }, [])

  const settle = useCallback(
    (outcome: LoadOutcome) => {
      if (outcome === 'ok') {
        retry.reset()
        setFailed(false)
        return
      }
      setFailed(true)
      if (typeof outcome === 'number' && NOT_YOURS.has(outcome)) retry.cancel()
      else retry.failed(outcome)
    },
    [retry],
  )

  const refresh = useCallback(async () => {
    const { teammateId: id, scope: wanted } = asked.current
    if (!id) return
    const seq = ++loadSeq.current
    const latest = () => seq === loadSeq.current
    inFlight.current += 1
    setLoading(true)
    let outcome: LoadOutcome | null = null
    try {
      const res = await fetch(botWorkUrl(id, wanted), { cache: 'no-store' })
      if (!latest()) return
      if (!res.ok) {
        // No longer one you can read (taken off its private team, say): what
        // was held from an earlier answer goes with it.
        if (NOT_YOURS.has(res.status)) hold(null)
        outcome = res.status
        return
      }
      const data = (await res.json()) as BotWorkResponse
      if (!latest()) return
      // A push that landed while this load was in flight is newer than the
      // answer's read of that row.
      let next = heldFrom(id, wanted, data)
      for (const row of pushedDuringLoad.current.values()) next = applyRow(next, row).held
      hold(next)
      outcome = 'ok'
    } catch {
      if (latest()) outcome = 'network'
    } finally {
      inFlight.current -= 1
      if (inFlight.current === 0) {
        pushedDuringLoad.current.clear()
        setLoading(false)
        // A chip reload that came due meanwhile goes now that nothing is in flight.
        const wait = chipAfterLoad.current
        chipAfterLoad.current = null
        if (wait !== null && asked.current.teammateId === id) scheduleChips(wait)
      }
      if (outcome !== null) settle(outcome)
    }
  }, [hold, settle, scheduleChips])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // The shell's channel: each row it pushes, and a reload when it comes up again.
  useEffect(() => {
    if (!teammateId) return
    let debounce: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void refreshRef.current(), DEBOUNCE_MS)
    }
    const off = onWorkRow((event) => {
      if (event.type === 'resync') {
        bump()
        return
      }
      const row = event.row
      if (inFlight.current > 0) pushedDuringLoad.current.set(row.id, row)
      const now = heldRef.current
      if (!now || now.teammateId !== teammateId || now.scope !== scope) return
      const before = now.scope === 'all' ? now.rows.find((r) => r.id === row.id) : undefined
      const { held: next, needsTeammate } = applyRow(now, row)
      if (next !== now) hold(next)
      const chipWait = next.rows.some((r) => r.id === row.id) ? chipReloadAfter(before, row, now.chips[row.id]) : null
      if (chipWait !== null) scheduleChips(chipWait)
      const unnamed = row.ai_team_member_id
      if (needsTeammate && unnamed && !refetchedFor.current.has(unnamed)) {
        refetchedFor.current.add(unnamed)
        bump()
      }
    })
    return () => {
      off()
      if (debounce) clearTimeout(debounce)
      cancelChips()
    }
  }, [teammateId, scope, onWorkRow, hold, scheduleChips, cancelChips])

  // The load, and again for another teammate or scope (what was held goes).
  useEffect(() => {
    hold(null)
    setFailed(false)
    pushedDuringLoad.current.clear()
    refetchedFor.current.clear()
    retry.reset()
    if (!teammateId) return
    void refreshRef.current()
    return () => {
      loadSeq.current += 1
      retry.cancel()
    }
  }, [teammateId, scope, retry, hold])

  const current = held && held.teammateId === teammateId && held.scope === scope ? held : null
  return useMemo(
    () => ({
      rows: current?.rows ?? null,
      chips: current?.chips ?? {},
      teammate: current?.teammate ?? null,
      mayResume: current?.mayResume ?? false,
      lastFinished: current?.lastFinished ?? null,
      about: current?.about ?? NO_ABOUT,
      loading,
      failed,
      refresh,
    }),
    [current, loading, failed, refresh],
  )
}
