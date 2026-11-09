'use client'

/**
 * An ask in the chat (P13; Liam, 2026-10-20: "It's okay for it to ask me
 * questions, but it shouldn't come through the for you channel… approvals
 * are questions too"): an approval or a question, inline in the conversation
 * it belongs to, never in For you.
 *
 *   ChatApprovalCard   a chat turn's held call (the tool result's
 *                      `approval_id`, chat-asks.ts approvalIdOfToolOutput),
 *                      right after the agent's message that raised it: the
 *                      outward gate, mcp_confirm_call, a disconnect or a
 *                      loosened tool (P5), a loop's switch-on, a delete;
 *   ChatAskCard        a `data-ask-card` part the server wrote into the home
 *                      thread for an approval nobody was in a chat to see (a
 *                      loop's parked step, a skill run's staged write, a card
 *                      meant for someone else), with "Open run";
 *   ChatAskCardGroup   a `data-ask-cards` part: one call's (or run's)
 *                      suggestions, batched (home-asks.ts), each card's own
 *                      verbs inline, and "Add all" when every one is a single
 *                      click;
 *   RunQuestionInline  a run parked on a question, under its report in the
 *                      home thread: the run's own picker (QuestionCard,
 *                      RunQuestionSection), answered through its respond route.
 *
 * The live card is the shell's shared source's (AgentWorkProvider:
 * useAttentionItems' `asks`, the same fetch and channel For you's cards use),
 * so there is no read per message: Approve, Edit, Skip and Decline are the
 * full card's own (AttentionCard, surface 'chat') and go through the one
 * person-only door (PATCH /api/account/attention-items). The server's
 * guarantees are untouched: the same tool_approval row, its stored input and
 * hash, run once, only on the owner's own click; the model can never approve.
 * Once the card has left the source (settled here, elsewhere, or expired) it
 * reads what became of it, once (ask-outcome.ts), and says so in one line.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Clock, CornerDownRight, Hourglass, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useOptionalAgentWorkShared } from '@/components/work/agent-work-provider'
import { useOpenOutput } from '@/hooks/use-open-output'
import type { AcceptCorrections, AcceptResult, AttentionItem, UseAttentionItems } from '@/hooks/use-attention-items'
import type { AddedItem, AskCardPartData, AskCardsPartData } from '@/lib/attention/chat-asks'
import { isTargetlessUpdate, isUnsupportedChange } from '@/lib/proposed-changes/derive-ui'
import { normalizeProposedChange } from '@/lib/proposed-changes/appliable-combos'
import { askOutcomeLine, knownAskOutcome, loadAskOutcome, type AskOutcome, type AskRef } from '@/lib/attention/ask-outcome'
import { fullRowFailed, useFullReads } from '@/lib/work/full-rows'
import { isTeammateReportStatus, type TeammateReportPartData, type TeammateReportStatus } from '@/lib/chat/teammate-report'
import { TeammateReportChip } from '@/app/account/(dashboard)/chat/teammate-report-chip'
import { GuestLine } from '@/components/guests/guest-chat-cards'
import { AgentLinkLine } from '@/components/agent-links/agent-link-chat-cards'
import { AttentionCard } from './attention-card'
import { QuestionCard } from './question-card'

const NO_LIST: never[] = []

/** The browser client, made once (the outcome reads share it). */
let browserClient: ReturnType<typeof createClient> | null = null
const client = () => (browserClient ??= createClient())

/** The card is the person's to act on in the chat, its outcome once it's gone. */
function useAsk(ref: AskRef): {
  live: AttentionItem | null
  outcome: AskOutcome | undefined
  /** The person's own click is on its way (the card has left, its answer hasn't come). */
  acting: boolean
  verbs: Pick<UseAttentionItems, 'accept' | 'dismiss'> | null
} {
  const shared = useOptionalAgentWorkShared()
  const attention = shared?.attention ?? null
  const { approvalId, cardId } = ref
  const live = useMemo(
    () =>
      attention?.asks.find((c) => (cardId && c.id === cardId) || (approvalId && (c.payload as { approval_id?: unknown } | null)?.approval_id === approvalId)) ?? null,
    [attention?.asks, approvalId, cardId],
  )
  const [outcome, setOutcome] = useState<AskOutcome | undefined>(() => knownAskOutcome(ref))
  // Pending by its row but not in the source (it arrived after the source's last read): read the source again, once.
  const refetched = useRef(false)
  useEffect(() => {
    if (outcome !== 'waiting' || refetched.current || !attention) return
    refetched.current = true
    void attention.refetch()
  }, [outcome, attention])
  // A read after the person acted, or after the card left on its own (another device, its expiry), is fresh.
  const [version, setVersion] = useState(0)
  // While the person's own click is on its way, nothing is read: the row still says pending.
  const [acting, setActing] = useState(false)
  const wasLive = useRef(false)
  useEffect(() => {
    if (live) wasLive.current = true
    else if (wasLive.current) {
      wasLive.current = false
      setVersion((v) => v + 1)
    }
  }, [live])
  const loaded = attention?.loaded ?? false
  useEffect(() => {
    if (live || !loaded || acting) return
    let on = true
    void loadAskOutcome(client, { approvalId, cardId }, { fresh: version > 0 }).then((o) => {
      if (on) setOutcome(o)
    })
    return () => {
      on = false
    }
  }, [live, loaded, acting, approvalId, cardId, version])
  // The source's verbs, each followed by a fresh read of what it led to.
  const verbs = useMemo(() => {
    if (!attention) return null
    return {
      accept: async (id: string, c?: AcceptCorrections, t?: string | null) => {
        setActing(true)
        try {
          return await attention.accept(id, c, t)
        } finally {
          setActing(false)
          setVersion((v) => v + 1)
        }
      },
      dismiss: async (id: string) => {
        setActing(true)
        try {
          await attention.dismiss(id)
        } finally {
          setActing(false)
          setVersion((v) => v + 1)
        }
      },
    }
  }, [attention])
  return { live, outcome, acting, verbs }
}

/** A chat turn's held call, right after the agent's message (the tool result names it). */
export function ChatApprovalCard({ approvalId }: { approvalId: string }) {
  return <AskBody ask={{ approvalId }} />
}

/**
 * An ask the server wrote into the home thread, with "Open run" when it came
 * from a run, and who asked over it when it is a guest's (guest access: their
 * line opens their conversation) or another person's agent's (agent links:
 * its line opens the two agents' conversation).
 */
export function ChatAskCard({ data }: { data: AskCardPartData }) {
  return (
    <AskBody
      ask={{ approvalId: data.approval_id ?? null, cardId: data.card_id }}
      title={data.title}
      workItemId={data.work_item_id}
      workspaceId={data.workspace_id}
      header={data.agent_link ? <AgentLinkLine link={data.agent_link} /> : data.guest ? <GuestLine guest={data.guest} /> : null}
    />
  )
}

function AskBody({ ask, title, workItemId, workspaceId, header = null }: { ask: AskRef; title?: string; workItemId?: string; workspaceId?: string; header?: ReactNode }) {
  const shared = useOptionalAgentWorkShared()
  const { live, outcome, acting, verbs } = useAsk(ask)
  const editCard = shared?.attention.editCard
  const start = shared?.attention.start
  const noop = useCallback(async (): Promise<AcceptResult> => ({ ok: false }), [])
  if (live && verbs && editCard) {
    return (
      <div data-chat-ask={live.kind} className="flex w-full max-w-[28rem] flex-col gap-1 self-start">
        {header}
        <AttentionCard
          item={live}
          editable={false}
          members={NO_LIST}
          aiMembers={NO_LIST}
          projects={NO_LIST}
          onEdit={editCard}
          onAccept={verbs.accept}
          onStart={start ?? noop}
          onDismiss={verbs.dismiss}
          surface="chat"
        />
        {workItemId && <OpenRun workItemId={workItemId} workspaceId={live.workspace_id || workspaceId || null} title={title ?? live.title} />}
      </div>
    )
  }
  // The person's click on its way: say so, never a stale "waiting".
  if (acting) {
    return (
      <div data-chat-ask-acting="" className="flex w-fit items-center gap-1.5 self-start rounded-xl border border-border/60 bg-background px-3 py-2 text-[11px] text-muted-foreground dark:border-white/10">
        <Loader2 className="h-3 w-3 animate-spin" />
        {title ? `${title.length > 60 ? `${title.slice(0, 59)}…` : title}: on it…` : 'On it…'}
      </div>
    )
  }
  // Not read yet (the source still loading, or the outcome on its way), or
  // pending but not in the source yet (it is being read again): nothing, never a flash.
  if (outcome === undefined || outcome === 'waiting') return null
  const settled = <SettledAsk outcome={outcome} title={title} workItemId={workItemId} workspaceId={workspaceId} />
  return header ? (
    <div className="flex w-fit max-w-full flex-col gap-1 self-start">
      {header}
      {settled}
    </div>
  ) : (
    settled
  )
}

/** The corrections an accept sends: the card's own properties, as its full card sends them (use-attention-card-verbs.ts). */
function correctionsOf(card: AttentionItem): AcceptCorrections {
  const p = card.payload ?? {}
  return {
    project_id: p.project_id ?? null,
    priority: (p.priority as AcceptCorrections['priority']) ?? undefined,
    due_date: p.due_date ?? null,
    assignee_member_id: p.assignee_member_id ?? null,
    assignee_ai_member_id: p.assignee_ai_member_id ?? null,
  }
}

/** A card one click settles from a list: a suggested change Native Intelligence can apply, with its target, run by no agent. */
function oneClick(card: AttentionItem): boolean {
  const p = card.payload ?? {}
  return card.kind === 'action_card' && !isTargetlessUpdate(p) && !isUnsupportedChange(p) && !p.assignee_ai_member_id
}

/**
 * One call's (or run's) suggestions in the home thread (`data-ask-cards`,
 * home-asks.ts): each still waiting as its own full card, with its own verbs
 * (Add / Dismiss, Start / Skip, Draft email); "Add all" when two or more wait
 * and every one is a single click; once settled, one quiet line. No read of
 * its own: the live cards are the shared source's `asks`.
 */
export function ChatAskCardGroup({ data }: { data: AskCardsPartData }) {
  const shared = useOptionalAgentWorkShared()
  const attention = shared?.attention ?? null
  const live = useMemo(() => {
    const byId = new Map((attention?.asks ?? []).map((c) => [c.id, c]))
    return data.card_ids.flatMap((id) => {
      const card = byId.get(id)
      return card ? [card] : []
    })
  }, [attention?.asks, data.card_ids])
  const [addingAll, setAddingAll] = useState(false)
  const noop = useCallback(async (): Promise<AcceptResult> => ({ ok: false }), [])
  const added = data.added ?? []
  if (!attention || !attention.loaded) return null
  const handled = data.card_ids.length - live.length
  if (live.length === 0) {
    if (added.length) return <AddedList added={added} workspaceId={data.workspace_id} />
    return (
      <div data-chat-ask-group-settled="" className="flex w-fit items-center gap-1.5 self-start rounded-xl border border-border/60 bg-background px-3 py-2 text-[11px] text-muted-foreground dark:border-white/10">
        <Check className="h-3 w-3 shrink-0" />
        {data.card_ids.length === 1 ? 'Handled.' : `All ${data.card_ids.length} handled.`}
      </div>
    )
  }
  const all = live.length >= 2 && live.every(oneClick)
  const allAdd = all && live.every((c) => normalizeProposedChange(c.payload ?? {}).change_type === 'create')
  const acceptAll = async () => {
    setAddingAll(true)
    try {
      for (const card of live) await attention.accept(card.id, correctionsOf(card))
    } finally {
      setAddingAll(false)
    }
  }
  return (
    <div data-chat-ask-group="" className="flex w-full max-w-[28rem] flex-col gap-2 self-start">
      {added.length > 0 && <AddedList added={added} workspaceId={data.workspace_id} />}
      {live.map((card) => (
        <div key={card.id} data-chat-ask={card.kind}>
          <AttentionCard
            item={card}
            editable={false}
            members={NO_LIST}
            aiMembers={NO_LIST}
            projects={NO_LIST}
            onEdit={attention.editCard}
            onAccept={attention.accept}
            onStart={attention.start ?? noop}
            onDismiss={attention.dismiss}
            surface="chat"
          />
        </div>
      ))}
      <div className="flex items-center gap-2 pl-1">
        {all && (
          <button
            type="button"
            data-chat-ask-accept-all=""
            onClick={() => void acceptAll()}
            disabled={addingAll}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-foreground px-3 text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {addingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            {allAdd ? `Add all ${live.length}` : `Accept all ${live.length}`}
          </button>
        )}
        {handled > 0 && <span className="text-[11px] text-muted-foreground">{handled} handled</span>}
      </div>
    </div>
  )
}

/**
 * What a call's run added on its own (Triage's existing gate), each with its
 * Undo: the capture's own undo route (the action is deleted, its suggestion
 * goes back to the call), in the change's own workspace (the route checks the
 * person is in it), whatever workspace is on screen. An item with no call has
 * no Undo here (its record page has the usual delete).
 *
 * Undone survives a reload: it is read off the change itself, once, when the
 * list mounts (no longer applied, or applied again as something else: this
 * item is gone), one read for the list.
 */
function AddedList({ added, workspaceId }: { added: readonly AddedItem[]; workspaceId: string }) {
  const [state, setState] = useState<Record<string, 'undoing' | 'undone' | 'failed'>>({})
  const ids = added.map((a) => a.change_id).join(',')
  useEffect(() => {
    if (!ids) return
    let on = true
    void (async () => {
      try {
        const { data, error } = await client().from('proposed_change').select('id, status, result_entity_id').in('id', ids.split(','))
        if (!on || error) return
        const rows = new Map(((data ?? []) as Array<{ id: string; status: string | null; result_entity_id: string | null }>).map((r) => [r.id, r]))
        const undone: Record<string, 'undone'> = {}
        for (const item of added) {
          const row = rows.get(item.change_id)
          if (row && (row.status !== 'applied' || row.result_entity_id !== item.entity_id)) undone[item.change_id] = 'undone'
        }
        if (Object.keys(undone).length) setState((s) => ({ ...undone, ...s }))
      } catch {
        // Unread: each keeps its Undo (the route refuses one already undone, and says so).
      }
    })()
    return () => {
      on = false
    }
    // `ids` names the items; `added` is the same list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])
  const undo = async (item: AddedItem) => {
    if (!item.capture_id) return
    setState((s) => ({ ...s, [item.change_id]: 'undoing' }))
    try {
      const res = await fetch(`/api/account/captures/${item.capture_id}/proposed-changes/${item.change_id}/undo`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workspaceId ? { workspace_id: workspaceId } : {}),
      })
      setState((s) => ({ ...s, [item.change_id]: res.ok ? 'undone' : 'failed' }))
    } catch {
      setState((s) => ({ ...s, [item.change_id]: 'failed' }))
    }
  }
  return (
    <ul data-chat-ask-added="" className="flex w-fit max-w-full flex-col gap-1 self-start rounded-xl border border-border/60 bg-background px-3 py-2 dark:border-white/10">
      {added.map((item) => {
        const st = state[item.change_id]
        const label = item.identifier ?? (item.title ? item.title : item.entity_type === 'action' ? 'An action' : 'An item')
        return (
          <li key={item.change_id} data-chat-ask-added-item={item.change_id} className="flex min-w-0 items-center gap-2 text-xs">
            {st === 'undone' ? <X className="h-3 w-3 shrink-0 text-muted-foreground" /> : <Check className="h-3 w-3 shrink-0 text-foreground/70" />}
            <span className={cn('min-w-0 truncate', st === 'undone' ? 'text-muted-foreground line-through' : 'text-foreground/85')}>
              {st === 'undone' ? `${label}: undone` : `Added ${label}`}
            </span>
            {item.capture_id && st !== 'undone' && (
              <button
                type="button"
                data-chat-ask-undo=""
                onClick={() => void undo(item)}
                disabled={st === 'undoing'}
                className="shrink-0 rounded-md px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {st === 'undoing' ? 'Undoing…' : st === 'failed' ? 'Try undo again' : 'Undo'}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const OUTCOME_ICON: Record<AskOutcome, typeof Check> = {
  approved: Check,
  failed: X,
  declined: X,
  expired: Clock,
  answered: Check,
  dismissed: X,
  waiting: Hourglass,
  theirs: Hourglass,
}

/** A settled ask, in one quiet line under what it was. */
function SettledAsk({ outcome, title, workItemId, workspaceId }: { outcome: AskOutcome; title?: string; workItemId?: string; workspaceId?: string }) {
  const Icon = OUTCOME_ICON[outcome]
  return (
    <div data-chat-ask-settled={outcome} className="flex w-fit max-w-full flex-col gap-0.5 self-start rounded-xl border border-border/60 bg-background px-3 py-2 dark:border-white/10">
      {title && <span className="line-clamp-2 text-xs font-medium text-foreground/80">{title}</span>}
      <span className={cn('flex items-center gap-1.5 text-[11px]', outcome === 'approved' || outcome === 'answered' ? 'text-foreground/70' : 'text-muted-foreground')}>
        <Icon className="h-3 w-3 shrink-0" />
        {askOutcomeLine(outcome)}
      </span>
      {workItemId && <OpenRun workItemId={workItemId} workspaceId={workspaceId ?? null} title={title ?? null} />}
    </div>
  )
}

/** "Open run": its item, beside its run's chat, where the run carries on. */
function OpenRun({ workItemId, workspaceId, title }: { workItemId: string; workspaceId: string | null; title: string | null }) {
  const openOutput = useOpenOutput()
  return (
    <button
      type="button"
      data-chat-ask-open-run=""
      onClick={() => void openOutput({ workItemId, workspaceId, title: title ?? 'Run', output: null })}
      className="inline-flex w-fit items-center gap-1 self-start rounded-md px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CornerDownRight className="h-3 w-3" />
      Open run
    </button>
  )
}

/** What a question's report says now, off its row's status: answered when it went on, else the row's own state. */
export function rowNow(status: string): 'answered' | TeammateReportStatus | undefined {
  if (status === 'running' || status === 'queued' || status === 'done') return 'answered'
  return isTeammateReportStatus(status) ? status : undefined
}

/**
 * A run's question under its report in the home thread: while the run waits,
 * its own picker (QuestionCard: the run's parked question, answered through
 * its respond route); once answered (or gone), the report's chip, saying so.
 */
export function RunQuestionInline({ data, metadata, joined }: { data: TeammateReportPartData; metadata?: unknown; joined?: boolean }) {
  const shared = useOptionalAgentWorkShared()
  const row = useMemo(() => shared?.work.rows?.find((r) => r.id === data.work_item_id) ?? null, [shared?.work.rows, data.work_item_id])
  const waiting = row?.status === 'needs_input'
  const rows = useMemo(() => (waiting && row ? [row] : []), [waiting, row])
  const reads = useFullReads(rows)
  // Not waiting: "Answered" only when the row is held and moved on past it;
  // its own status when it settled another way; the plain chip when not held.
  if (!shared || !row || !waiting) return <TeammateReportChip data={data} metadata={metadata} joined={joined} now={row ? rowNow(row.status) : undefined} />
  const read = reads.get(row.id) ?? null
  // Until its read lands (or failed: the card's Answer then opens the item), the chip.
  if (!read && !fullRowFailed(row)) return <TeammateReportChip data={data} metadata={metadata} joined={joined} />
  return (
    <div data-chat-ask="run_question" className="flex w-full max-w-[28rem] flex-col self-start">
      <QuestionCard row={row} read={read} teammateId={row.ai_team_member_id ?? ''} onAnswered={shared.work.answered} />
    </div>
  )
}
