'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { createLoadRetry, type LoadOutcome } from '@/lib/load-retry'
import {
  markSelfRefetched,
  wasSelfRefetchedRecently,
  repairIdFromRecoveredEvent,
} from '@/lib/supabase/realtime-recovery'
import { toast } from 'sonner'
import type { WorkResourceRef } from '@/lib/agent-run/types'
import { announceAttentionItem } from '@/lib/sounds/triggers'
import { isInWorkspaceSpan } from '@/lib/workspace-span'
import { splitCardsByPlace } from '@/lib/attention/chat-asks'
import type { WorkRunPlace, WorkRunWhere } from '@/lib/attention/work-place'

/**
 * The attention rail's data hook (loop-closure Phase 2, Workstream D).
 *
 * Loads the caller's pending attention cards and keeps them live: a new card
 * produced by a triage-class verdict run appears the instant its row is written,
 * via a postgres_changes subscription on attention_item (migration 167 put the
 * table in the realtime publication). RLS (owner-only select) means the client
 * receives ONLY the user's own cards — across ALL their workspaces, since the
 * rail is a personal queue, not workspace-scoped. We therefore do NOT filter the
 * subscription by member_id (a user has a different member id per workspace);
 * RLS is the fence.
 *
 * accept/dismiss go through PATCH /api/account/attention-items, which is the
 * single source of truth (accept delegates to the shared apply-engine). The card
 * is optimistically removed from the rail; a 409 (already resolved/expired) also
 * removes it — either way it's done. A hard failure re-adds it and toasts.
 *
 * Until a fetch has landed (`loaded`), a failed one retries by itself on the
 * same schedule as useAgentWork (2 s, 8 s, 30 s, then every 2 minutes;
 * `@/lib/load-retry`), and at once when the window comes back into view or
 * focus. Signed out (a 401 twice running), only the long interval, and the
 * window events leave it be. The retries stop with the mount. Once a fetch has
 * landed, a failed refetch leaves the deck as it was and does not retry.
 */

export interface AttentionItem {
  id: string
  workspace_id: string
  member_id: string
  /** 'approval' (A5): a tool call the server holds until the person accepts (src/lib/safety/approvals.ts). */
  kind: 'action_card' | 'draft_email' | 'question' | 'work_proposal' | 'approval'
  title: string
  why: string | null
  payload: AttentionPayload
  proposal_id: string | null
  source_flow_run_id: string | null
  /** The fire that wrote it (dedupe); with `payload.flow_id`, a run with no ledger row's batch key (lib/bots/batch.ts batchKeyOf). */
  run_key?: string | null
  status: string
  expires_at: string | null
  created_at: string
}

/** The server-authored snapshot the card renders + edits (see cardPayload in
 *  verdict-apply.ts). All optional — a card degrades gracefully if a field is
 *  absent. */
export interface AttentionPayload {
  change_type?: string
  entity_type?: string
  /** The resolved target entity id for an update (W-4b). Null/absent on a
   *  target-less action update — the card needs a picker before it can apply. */
  entity_id?: string | null
  title?: string
  display_text?: string
  description?: string | null
  priority?: string | null
  due_date?: string | null
  project_id?: string | null
  assignee_member_id?: string | null
  assignee_ai_member_id?: string | null
  /** The bot that raised it (bots v3 1a), stamped at insert. */
  raised_by_ai_member_id?: string | null
  /** Its workspace's Assistant when nothing names its bot, set where cards are read (lib/work/bot-owner.ts). Never stored. */
  fallback_owner_ai_member_id?: string | null
  capture_id?: string | null
  confidence?: number
  email_to_name?: string | null
  email_to_address?: string | null
  email_subject?: string | null
  email_context?: string | null
  /** Provenance for the card footer ("from <skill> · <capture>"). */
  skill_name?: string | null
  capture_title?: string | null
  /** Stamped by the server after a draft_email accept whose generation FAILED, so
   *  a retry re-fills the SAME shell (WS-2a). Its presence on a draft_email card
   *  means "a draft shell exists — offer Retry". */
  draft_id?: string
  // ── work_proposal fields (Loops v3 — WorkProposalPayload in
  //    src/lib/agent-run/types.ts). Present only on kind='work_proposal' cards. ──
  /** Self-contained instructions for the executor agent. */
  task?: string
  deliverable_hint?: 'email_draft' | 'document' | 'board_update' | 'mixed'
  /** Declared resources the work will draw on — rendered as "Will use" chips. */
  resources?: WorkResourceRef[]
  // ── approval fields (A5; F4 loop steps) ──
  /** A loop step's held call: the card may be edited before it runs. */
  editable?: boolean
  /** An approval card that offers Always allow (approvals.ts NewApproval.alwaysAllow): a connected app's tool its own permission held. */
  always_allow?: boolean
  /** The person's edit of a loop step's inputs (local until Approve sends it). */
  edited_input?: Record<string, unknown>
  /** The held call publishes or reaches people: it always waits for this card. */
  public_content?: boolean
  [key: string]: unknown
}

export interface AcceptCorrections {
  project_id?: string | null
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  due_date?: string | null
  assignee_member_id?: string | null
  assignee_ai_member_id?: string | null
  /** C2a: a post card's Typefully button (its own click is the approval). Sent as the body's `publish`. */
  publish?: 'now' | 'next_free_slot'
  /** An approval card's Always allow: runs it once, then that tool runs without a card. Sent as the body's `always_allow`. */
  always_allow?: true
}

/** What accept resolves to — carries the created entity id (so the caller can
 *  chain a follow-up like starting an assigned agent) plus the receipt fields the
 *  rail renders (WS-1c/2a). */
export interface AcceptResult {
  ok: boolean
  entity_id?: string | null
  /** Terminal status the server reported. 'draft_ready' = a draft_email accept
   *  whose shell was filled (WS-2a); 'started' = a work_proposal Start that
   *  dispatched a work run; 'accepted'/'dismissed' otherwise. */
  status?: 'accepted' | 'dismissed' | 'draft_ready' | 'started'
  /** Kind the accept produced — the proposal's entity_type, or 'email_draft'.
   *  For a Start it's 'action' (the tracked action filed at Start). */
  entity_kind?: string
  /** Human identifier of a created/updated action (e.g. 'GEN-42'), when present. */
  identifier?: string
  /** The work run dispatched by a Start (status 'started') — the drill-in handle. */
  agent_run_id?: string
  /** Filled draft id (draft_ready), or the shell id stamped on a generation
   *  failure — the retry key. */
  draft_id?: string
  /** True when accept failed because outreach-draft generation failed (HTTP 502).
   *  The backing proposal stays applied and the card is re-added PENDING, so the
   *  UI keeps it visible and offers "Retry draft" rather than treating it as a
   *  hard failure. (WS-2a) */
  draftGenerationFailed?: boolean
  /** True when accept failed because the update has no resolvable target action
   *  (HTTP 409 UPDATE_TARGET_UNRESOLVED). The card is re-added PENDING so the UI
   *  can open an action picker and retry with target_entity_id (W-4c) — NOT a hard
   *  failure. */
  needsTarget?: boolean
  /** C2a: what Typefully took ("Added to your Typefully queue…"), for the receipt. */
  message?: string
  /** An Always allow accept: true when the tool now runs without a card (false: approved once only). */
  always_allowed?: boolean
  /** A Start in the place picked on the card: where it runs, for the receipt. */
  where?: WorkRunWhere
}

export interface UseAttentionItems {
  /** For you's cards: delivered work (P13, src/lib/attention/chat-asks.ts). */
  items: AttentionItem[]
  /**
   * The chat's cards: approvals and questions, rendered inline in the
   * conversation they belong to (chat-ask-card.tsx). Same store, same verbs;
   * never in For you, its counts or the bots' badges.
   */
  asks: AttentionItem[]
  isLoading: boolean
  /**
   * A fetch has landed: `items` is the deck as the server had it (live changes
   * on top). False until then, and a failed fetch never makes it true, so an
   * empty deck after a failure isn't read as "no cards" (the bots wait on it).
   * While it's false, a failed fetch retries (see the hook's comment).
   */
  loaded: boolean
  /** Locally patch a card's payload (property edits before accept). */
  editCard: (id: string, patch: Partial<AttentionPayload>) => void
  /** Accept a card. `targetEntityId` (W-4c) rescues a target-less update by naming
   *  the action to update — retried after the picker resolves. */
  accept: (
    id: string,
    corrections?: AcceptCorrections,
    targetEntityId?: string | null,
  ) => Promise<AcceptResult>
  /** Start a work_proposal card — dispatches a work run (PATCH action 'start'),
   *  or runs it in the place picked on the card (`runIn`, work-place.ts).
   *  Same optimistic-removal/error-restore discipline as accept. */
  start: (id: string, runIn?: WorkRunPlace | null) => Promise<AcceptResult>
  dismiss: (id: string) => Promise<void>
  refetch: () => Promise<void>
}

/**
 * `channel` / `announce`: every mount needs its OWN channel name, because
 * supabase-js hands back the same channel object for a repeated topic, so two
 * mounts sharing `attention-rail` would let either unmount tear the other's
 * subscription down. The dashboard shell holds one mount (AgentWorkProvider,
 * a name unique to it) that the bots, their bubbles and their pages all read.
 * A second mount showing the same cards passes `announce: false`, so a card
 * arriving live plays its sound once, not once per mount.
 */
export function useAttentionItems(opts: { channel?: string; announce?: boolean } = {}): UseAttentionItems {
  const channelName = opts.channel ?? 'attention-rail'
  const announce = opts.announce ?? true
  // Every pending card (For you's and the chat's): split on the way out.
  const [items, setItems] = useState<AttentionItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  // Guards against a realtime INSERT racing the initial fetch to a duplicate.
  const seenIds = useRef<Set<string>>(new Set())
  // The retries until a fetch lands (see fetchItems).
  const liveRef = useRef(false)
  const loadedRef = useRef(false)
  const inFlight = useRef(0)
  const [retry] = useState(() => createLoadRetry(() => void fetchItemsRef.current()))

  const upsert = useCallback((incoming: AttentionItem[], replace: boolean) => {
    setItems((prev) => {
      const next = replace ? [] : [...prev]
      const byId = new Map(next.map((i) => [i.id, i]))
      for (const it of incoming) {
        byId.set(it.id, it)
        seenIds.current.add(it.id)
      }
      // Newest first.
      return Array.from(byId.values()).sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      )
    })
  }, [])

  const fetchItems = useCallback(async () => {
    setIsLoading(true)
    inFlight.current += 1
    let outcome: LoadOutcome = 'network'
    try {
      const res = await fetch('/api/account/attention-items')
      if (res.ok) {
        const data = await res.json()
        const fetched = [...((data.items ?? []) as AttentionItem[]), ...((data.asks ?? []) as AttentionItem[])]
        seenIds.current = new Set(fetched.map((i) => i.id))
        upsert(fetched, true)
        loadedRef.current = true
        setLoaded(true)
        outcome = 'ok'
      } else {
        outcome = res.status
      }
    } catch {
      // Silent — the rail just stays empty; a later realtime insert still lands.
    } finally {
      inFlight.current -= 1
      setIsLoading(false)
      // Silent either way: a fetched card never plays (only a live INSERT
      // does). Until one lands, a failure tries again on the shared schedule,
      // because the bots wait on `loaded`.
      if (liveRef.current) {
        if (outcome === 'ok') retry.reset()
        else if (!loadedRef.current) retry.failed(outcome)
      }
    }
  }, [upsert, retry])

  // The retries belong to this mount. Declared before the first fetch, so the
  // mount is live by the time that fetch settles.
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
      retry.cancel()
    }
  }, [retry])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // A fetch that never landed also retries the moment the window is back in
  // view or focus (both fire on a return: the second finds the first in
  // flight). Not while signed out: the long interval is enough.
  useEffect(() => {
    const retryNow = () => {
      if (loadedRef.current || inFlight.current > 0) return
      if (retry.signedOut) return
      if (document.visibilityState === 'hidden') return
      retry.cancel()
      void fetchItemsRef.current()
    }
    window.addEventListener('focus', retryNow)
    document.addEventListener('visibilitychange', retryNow)
    return () => {
      window.removeEventListener('focus', retryNow)
      document.removeEventListener('visibilitychange', retryNow)
    }
  }, [retry])

  const removeLocal = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
    seenIds.current.delete(id)
  }, [])

  // A card that lapses while it is on screen (an approval's 24 h wait, a
  // groomed card's horizon) leaves at its expiry, not at the next fetch: ONE
  // timer, for the soonest expires_at, re-armed when the items change.
  useEffect(() => {
    let soonest = Infinity
    for (const it of items) {
      const at = it.expires_at ? Date.parse(it.expires_at) : NaN
      if (Number.isFinite(at) && at < soonest) soonest = at
    }
    if (!Number.isFinite(soonest)) return
    // setTimeout holds at most 2^31-1 ms; a later expiry re-arms on the next change.
    const delay = Math.min(Math.max(0, soonest - Date.now()) + 50, 2 ** 31 - 1)
    const timer = setTimeout(() => {
      const now = Date.now()
      setItems((prev) => {
        const live = prev.filter((it) => !it.expires_at || !(Date.parse(it.expires_at) <= now))
        return live.length === prev.length ? prev : live
      })
    }, delay)
    return () => clearTimeout(timer)
  }, [items])

  // Latest fetch fn, held in a ref so the realtime effect can call it on
  // recovery without listing it as a dep (which would re-subscribe the channel).
  const fetchItemsRef = useRef(fetchItems)
  fetchItemsRef.current = fetchItems

  // Realtime: new cards + cross-device resolves. No member filter — RLS delivers
  // only the caller's own rows, across every workspace they belong to.
  //  • INSERT: a fresh card. Add it (unless already-expired/non-pending, defensive).
  //  • UPDATE: a card resolved on ANOTHER device/tab (status pending→accepted/
  //    dismissed/expired). Drop it here so the rail doesn't show a card the user
  //    already handled elsewhere. (migration 167 set REPLICA IDENTITY FULL so the
  //    UPDATE row carries the id.) (Adversarial review: cross-device staleness.)
  //    An UPDATE that lands BACK ON status='pending' is a server-side REVERT (a
  //    Start whose post-CAS step failed reverts the card accepted→pending): UPSERT
  //    it so the rail re-shows the card here and on every other device. (WS Start
  //    compensation — approved work that silently failed becomes retryable again.)
  useEffect(() => {
    let hadFailure = false
    // The dedup key is the FULL channel name — see markSelfRefetched.
    const CHANNEL = channelName
    const supabase = createClient()
    const channel = supabase
      .channel(CHANNEL)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'attention_item' },
        (payload) => {
          const row = payload.new as AttentionItem
          if (row.status !== 'pending') return
          if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return
          if (seenIds.current.has(row.id)) return
          upsert([row], false)
          // A card arriving live is an agent needing the user. Only here: the
          // fetches (mount, catch-up) and a revert UPDATE below stay silent.
          // And only for a card the app is showing: with "Show all workspaces"
          // off, another workspace's card is held but not on screen, so it
          // makes no sound either (lib/workspace-span).
          if (announce && isInWorkspaceSpan(row.workspace_id)) announceAttentionItem(row)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'attention_item' },
        (payload) => {
          const row = payload.new as AttentionItem
          if (row.status === 'pending') {
            // Revert (or any pending re-write) — re-show it unless it's expired.
            if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
              removeLocal(row.id)
              return
            }
            upsert([row], false)
          } else {
            removeLocal(row.id)
          }
        },
      )
      // On a successful (re)subscribe after a prior failure, refetch — INSERT/
      // UPDATE events during the gap were lost (mirrors use-realtime-entities.ts).
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && hadFailure) {
          hadFailure = false
          markSelfRefetched(CHANNEL)
          void fetchItemsRef.current()
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          hadFailure = true
        }
      })

    // Also catch up when the app-wide entities channel recovers (its socket and
    // ours can drop independently).
    //
    // Skipped when this channel ALREADY caught up moments ago: one real repair
    // knocks every channel at once, so our own re-SUBSCRIBE refetch and the
    // entities channel's fan-out are two signals about the SAME gap. Refetching
    // twice was pure waste in the measured wake storm. A fan-out with no recent
    // self-refetch (our socket stayed up while the entities one died) still
    // refetches — the catch-up guarantee is untouched.
    const onRecovered = (event: Event) => {
      if (wasSelfRefetchedRecently(CHANNEL, repairIdFromRecoveredEvent(event))) return
      void fetchItemsRef.current()
    }
    window.addEventListener('ni:realtime-recovered', onRecovered)

    return () => {
      window.removeEventListener('ni:realtime-recovered', onRecovered)
      supabase.removeChannel(channel)
    }
  }, [upsert, removeLocal, channelName, announce])

  const editCard = useCallback((id: string, patch: Partial<AttentionPayload>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, payload: { ...it.payload, ...patch } } : it)),
    )
  }, [])

  const resolve = useCallback(
    async (
      id: string,
      action: 'accept' | 'dismiss' | 'start',
      corrections?: AcceptCorrections,
      targetEntityId?: string | null,
      runIn?: WorkRunPlace | null,
    ): Promise<AcceptResult> => {
      const snapshot = items.find((it) => it.id === id)
      // A loop step's card the person edited (F4): Approve runs what it shows.
      const editedInput =
        action === 'accept' && snapshot?.kind === 'approval' && snapshot.payload?.editable === true && snapshot.payload.edited_input
          ? snapshot.payload.edited_input
          : undefined
      // Optimistic removal.
      removeLocal(id)
      const { publish, always_allow: alwaysAllow, ...rest } = corrections ?? {}
      try {
        const res = await fetch('/api/account/attention-items', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            action,
            ...(corrections && !publish && !alwaysAllow ? { corrections: rest } : {}),
            ...(publish ? { publish } : {}),
            ...(alwaysAllow ? { always_allow: true } : {}),
            ...(targetEntityId ? { target_entity_id: targetEntityId } : {}),
            ...(editedInput ? { edited_input: editedInput } : {}),
            ...(action === 'start' && runIn ? { run_in: runIn } : {}),
          }),
        })
        if (res.ok) {
          const data = await res.json().catch(() => ({}))
          return {
            ok: true,
            entity_id: data?.entity_id ?? null,
            status: data?.status,
            entity_kind: data?.entity_kind,
            identifier: data?.identifier,
            draft_id: data?.draft_id,
            agent_run_id: data?.agent_run_id,
            ...(typeof data?.message === 'string' ? { message: data.message } : {}),
            ...(typeof data?.always_allowed === 'boolean' ? { always_allowed: data.always_allowed } : {}),
            ...(data?.where && typeof data.where === 'object' ? { where: data.where as WorkRunWhere } : {}),
          }
        }
        const err = await res.json().catch(() => ({}))
        // A target-less update (W-4c): the server refused the one-click apply
        // because the update names no resolvable action. The proposal is pending
        // again (the route reverted the claim) — re-add the card so the UI can open
        // an action picker and retry with target_entity_id. NOT a hard failure.
        if (res.status === 409 && err?.code === 'UPDATE_TARGET_UNRESOLVED') {
          if (snapshot) upsert([snapshot], false)
          return { ok: false, needsTarget: true }
        }
        // 409 = already resolved/expired → it's gone anyway, keep it removed.
        // A Start in a place that refused it (the Mac offline, no GitHub…) is a
        // 409 too, with its own code: the server put the card back, so it's a
        // hard failure below (shown again, with the reason).
        const placeRefused = action === 'start' && runIn && err?.code !== 'ALREADY_RESOLVED' && err?.code !== 'EXPIRED'
        if (res.status === 409 && !placeRefused) return { ok: false }
        // Draft generation failed (WS-2a): the send_email proposal is applied and
        // its email_draft shell exists, so the card is still PENDING server-side —
        // re-add it (with the shell's draft_id merged so a retry re-fills the SAME
        // shell) and let the card offer "Retry draft". Not a hard failure.
        if (res.status === 502 && err?.code === 'DRAFT_GENERATION_FAILED') {
          const draftId = typeof err?.draft_id === 'string' ? err.draft_id : undefined
          if (snapshot) {
            upsert(
              [draftId ? { ...snapshot, payload: { ...snapshot.payload, draft_id: draftId } } : snapshot],
              false,
            )
          }
          toast.error('Couldn’t draft the email', {
            description: err?.error || 'Try again.',
          })
          return { ok: false, draftGenerationFailed: true, draft_id: draftId }
        }
        // Hard failure — put it back and surface the reason.
        if (snapshot) upsert([snapshot], false)
        const failLabel =
          action === 'start'
            ? 'Could not start'
            : action === 'accept'
              ? 'Could not accept'
              : 'Could not dismiss'
        toast.error(failLabel, {
          description: err?.error || 'Something went wrong',
        })
        return { ok: false }
      } catch (e) {
        if (snapshot) upsert([snapshot], false)
        toast.error('Network error', {
          description: e instanceof Error ? e.message : undefined,
        })
        return { ok: false }
      }
    },
    [items, removeLocal, upsert],
  )

  const accept = useCallback(
    (id: string, corrections?: AcceptCorrections, targetEntityId?: string | null) =>
      resolve(id, 'accept', corrections, targetEntityId),
    [resolve],
  )
  const start = useCallback((id: string, runIn?: WorkRunPlace | null) => resolve(id, 'start', undefined, undefined, runIn), [resolve])
  const dismiss = useCallback(async (id: string) => {
    await resolve(id, 'dismiss')
  }, [resolve])

  // For you's half and the chat's (the bots and the counts read `items` only).
  const { forYou, asks } = useMemo(() => splitCardsByPlace(items), [items])
  return useMemo(
    () => ({ items: forYou, asks, isLoading, loaded, editCard, accept, start, dismiss, refetch: fetchItems }),
    [forYou, asks, isLoading, loaded, editCard, accept, start, dismiss, fetchItems],
  )
}
