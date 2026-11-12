'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

/**
 * One detail panel for any kind of background work (ACTIVITY-AND-REVIEW-DESIGN
 * §4.2). Opened from the Activity dialog, a notification (target_type
 * 'work_item'), a rail review card and Recently viewed, like every other
 * entity panel — and built on the same shell as the action and capture
 * panels: the breadcrumb above is the header and Back is the close, the 40px
 * toolbar carries the item's verbs, the content column (max 736px) reads top
 * to bottom, and the 289px properties sidebar steps aside when the panel is
 * narrow.
 *
 * The content answers the same questions for every kind, in the same order,
 * from the `output` the item route folds out of the execution rows
 * (src/lib/work/output.ts):
 *
 *   Needs you                the parked question, or the review verbs
 *   What happened            the run's own account, the error, the skip reason
 *   For you                  the cards it surfaced / the drafts it wrote —
 *                            what each proposes, where it stands, its verbs
 *   Delivered                documents, filed actions, PRs, captures — with
 *                            the verb each type implies (openDeliverable)
 *   Everything it looked at  every proposal it decided on, by outcome, with
 *                            its reason (collapsed)
 *   Task / Used / Log        an agent run's brief, resources and terminal
 *   Plan                     the agent's checklist (tracked_job.plan, migration
 *                            331; collapsed once settled)
 *   Steps                    the recorder's phrases (collapsed once settled)
 *
 * Send / Merge never live here (invariant 5): a draft is sent from Mail, a PR
 * merged on GitHub. Accept / Start / Dismiss on a card do — they are the
 * card's own verbs, the same PATCH the rail issues.
 *
 * `embedded` (bots-v4.md "An item opens on its bot's page", Phase 2): the same
 * body as a view inside a bot's page, beside the conversation about the item.
 * No toolbar of its own (Stop and Open run sit under the title), the
 * properties fold into the column (a Details section at its foot, never the
 * window's inspector), and the narrow column's sizes. Its writes name the
 * item's own workspace (the page can show an item from a workspace other than
 * the one on screen). `shown` says whether the page shows it now (a narrow
 * page shows its work or its chat): only then is it stamped opened.
 *
 * A handoff's link ("Delegated by", the rows it handed work to) opens that
 * item where any item opens (useOpenWorkItem): on its own bot's page, else
 * on a card of its own.
 *
 * A local agent's turn (`kind: 'local_agent'`, local-agents contract G): one
 * ledger row per turn, `source.local_agent_session_id` naming the session.
 * The same sections read as for any row, then its conversation: the WHOLE
 * session across its turns (LocalAgentPanel: the transcript, its own Stop,
 * and a box to message it as you, which also answers its question). On a
 * bot's page the conversation is the chat side's (`conversationBeside`), so
 * it isn't drawn twice. Its question has no run to answer through, so it is
 * never "stale" here: the reply box answers it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  CirclePause,
  CircleSlash,
  Clock,
  CornerDownRight,
  Disc,
  ExternalLink,
  Laptop,
  Loader2,
  Mail,
  MessageCircleQuestion,
  RefreshCw,
  Sparkles,
  Square,
  SquareCheckBig,
  Timer,
  User,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { openHrefInWorkspace } from '@/app/account/open-href-in-workspace'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { useNotifications } from '@/app/account/notification-context'
import { ContentTransition } from '@/app/account/(dashboard)/views/transitions'
import { Terminal, WorkResources, WorkTask } from '@/app/account/(dashboard)/views/agent-run-ui'
import { PropertyGroup } from '@/components/views/property-group'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { useRowChanges } from '@/hooks/use-row-changes'
import { chipClass } from '@/lib/views/property-options'
import { RunQuestionSection } from '@/components/agent-run/run-question-section'
import type { PendingInput, WorkResourceRef } from '@/lib/agent-run/types'
import { openDeliverable, type DeliverableContext } from '@/lib/work/open-deliverable'
import {
  labelKey,
  runFrom,
  type AgentRunRow,
  type WorkOutput,
  type WorkOutputCard,
  type WorkOutputDecision,
  type WorkOutputDraft,
  type WorkOutputRef,
} from '@/lib/work/output'
import {
  WORK_STATUS_TEXT,
  deliverableVerb,
  itemLine,
  durationText,
  isPausedFailure,
  kindLabel,
  relativeTime,
  reviewLine,
  stepTimeline,
} from '@/lib/work/presentation'
import { isWorkLive, type WorkDeliverable, type WorkItem, type WorkStatus } from '@/lib/work/types'
import { planBadge, planStepsFrom } from '@/lib/work/plan'
import { PlanChecklist } from '@/components/work/plan-checklist'
import type { HeldContact } from '@/lib/work/held-contacts'
import { questionIsStale, requestStopWaiting } from '@/lib/work/stop-waiting'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'
import { HUBSPOT_HOLD_TITLE, releaseHubspotHold } from '@/components/views/hubspot-hold'
import type { WorkItemRun } from '@/app/api/account/activity/[id]/route'
import { Linkify } from '@/components/ui/linkify'
import { LocalAgentPanel } from '@/components/local-agent/local-agent-panel'
import { localAgentSessionIdOf } from '@/lib/local-agent/transcript-view'
import { questionsOf } from '@/lib/bots/narration'

interface ItemPayload {
  item: WorkItem
  run: WorkItemRun | null
  drafts: DeliverableContext['drafts']
  output?: WorkOutput | null
  /** Contacts this run created that are still held from HubSpot (the tier-2 gate). */
  held_contacts?: HeldContact[]
  /** The row that handed this item its work (row 14), when it is a handoff. */
  parent?: WorkItem | null
  /** The rows this item handed work to, oldest first (row 14). */
  children?: WorkItem[]
  /** The viewer owns the row (only the owner's open stamps it opened). */
  mine?: boolean
}


const KIND_ICONS: Record<string, LucideIcon> = {
  flow_run: Zap,
  skill_run: Sparkles,
  work_run: Boxes,
  coding_run: Boxes,
  email_drafts: Mail,
  extraction: Sparkles,
  triage_reconcile: RefreshCw,
  proposal_age_out: Timer,
  local_agent: Laptop,
}

const CARD_ICONS: Record<string, LucideIcon> = {
  action_card: SquareCheckBig,
  draft_email: Mail,
  question: MessageCircleQuestion,
  work_proposal: Boxes,
}

const REF_ICONS: Record<WorkOutputRef['type'], LucideIcon> = {
  capture: Disc,
  flow: Zap,
  action: SquareCheckBig,
}

const DELIVERABLE_TAGS: Record<string, string> = {
  email_draft: 'Draft',
  document: 'Doc',
  action: 'Action',
  capture: 'Capture',
  contact: 'Contact',
  company: 'Company',
  prospect_list: 'List',
  pr: 'PR',
  attention_cards: 'Cards',
  flow_run: 'Run',
  url: 'Link',
  studio_video: 'Video',
}

/** Which resource types a "Used" chip can open, and where. */
/** The resource types that open as a record card. */
const RESOURCE_RECORDS = new Set(['action', 'capture', 'document', 'contact', 'project', 'initiative'])

const CHANGE_VERBS: Record<string, string> = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  send_email: 'Email',
}

/** The order the decision groups read in: what it did first, what it set aside last. */
const OUTCOME_ORDER = ['applied', 'carded', 'staged', 'folded', 'revoked', 'dismissed', 'skipped', 'failed']

const DECISION_ROWS_CAP = 60

function outcomeLabel(outcome: string, kind: string): string {
  switch (outcome) {
    case 'applied':
      return 'Filed'
    case 'carded':
      return kind === 'extraction' ? 'Staged for review' : 'Put in front of you'
    case 'staged':
      return 'Left in the capture'
    case 'folded':
      return 'Folded into existing work'
    case 'revoked':
      return 'Revoked'
    case 'dismissed':
      return 'Dismissed'
    case 'skipped':
      return 'Skipped'
    case 'failed':
      return 'Failed'
    default:
      return outcome
  }
}

function groupDecisions(decisions: readonly WorkOutputDecision[]): Array<[string, WorkOutputDecision[]]> {
  const groups = new Map<string, WorkOutputDecision[]>()
  for (const d of decisions) {
    const list = groups.get(d.outcome) ?? []
    list.push(d)
    groups.set(d.outcome, list)
  }
  const known = OUTCOME_ORDER.filter((o) => groups.has(o))
  const rest = [...groups.keys()].filter((o) => !OUTCOME_ORDER.includes(o))
  return [...known, ...rest].map((o) => [o, groups.get(o) as WorkOutputDecision[]])
}

/** "Sep 20" for a date-only value (kept in the calendar day it names) or an instant. */
function shortDate(value: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "4m ago", "just now", or "on Sep 10" once relativeTime falls back to a date. */
function agoText(iso: string | null): string {
  const rel = relativeTime(iso)
  if (!rel) return ''
  if (rel === 'now') return 'just now'
  return /^\d+[mhd]$/.test(rel) ? `${rel} ago` : `on ${rel}`
}

function dateTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export interface WorkItemDetailPanelProps {
  itemId: string
  /** Part of the detail renderer's contract; the breadcrumb's Back closes the
   *  panel, so the panel draws no close control of its own. */
  onClose?: () => void
  /** Inside a bot's page (Phase 2): no toolbar of its own, the properties in the column, the narrow column's sizes. */
  embedded?: boolean
  /** Whether the page shows it now (a narrow bot's page shows its work or its chat): only then is it stamped opened. */
  shown?: boolean
  /** The item as loaded, whenever it changes (null until it has); `failed` once it couldn't be. A bot's page finds the item's chat from it. */
  onItem?: (item: WorkItem | null, failed: boolean) => void
  /** The host draws the item's conversation beside this panel (a bot's page): a local agent's isn't drawn here too. */
  conversationBeside?: boolean
}

/** A mounted panel can be in a background browser/desktop window. */
function useForegroundDocument(): boolean {
  const [foreground, setForeground] = useState(false)
  useEffect(() => {
    let focused = document.hasFocus()
    const sync = () => setForeground(focused && !document.hidden)
    const onFocus = () => {
      focused = true
      sync()
    }
    const onBlur = () => {
      focused = false
      sync()
    }
    sync()
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])
  return foreground
}

export function WorkItemDetailPanel({ itemId, embedded = false, shown = true, onItem, conversationBeside = false }: WorkItemDetailPanelProps) {
  const openWorkItemWhereItOpens = useOpenWorkItem()
  const activeWorkspaceId = useWorkspaceId()
  // On screen: on a bot's page, the part of the page it's in shown.
  const drawn = shown
  const foreground = useForegroundDocument()
  const [data, setData] = useState<ItemPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [decisionsOpen, setDecisionsOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null)
  const [planOpen, setPlanOpen] = useState<boolean | null>(null)
  const [logOpen, setLogOpen] = useState<boolean | null>(null)
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const propertiesVisible = usePropertiesVisible(panelBodyRef)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/account/activity/${itemId}`, { cache: 'no-store' })
      if (!res.ok) {
        setError(res.status === 404 ? 'This work item is no longer available.' : 'Could not load this work item.')
        return
      }
      setData((await res.json()) as ItemPayload)
      setError(null)
    } catch {
      setError('Could not load this work item.')
    }
  }, [itemId])

  useEffect(() => {
    void load()
  }, [load])

  // The owner opening the item makes it no longer new (migration 295): its
  // teammate's bot stops calling for it. Stamped when the panel holds the row
  // unopened, whatever its status; fire-and-forget (the panel never waits on
  // it, and a failed stamp only leaves the bot calling); never for a row the
  // viewer doesn't own (`mine`). The realtime UPDATE then carries `opened_at`
  // to the shell's ledger channel.
  //
  // "Opened" is since the row last started waiting on you: the recorder clears
  // the stamp on every move into needs_input / needs_review. When that lands
  // while the panel is visible (a pushed row shows it unopened again), the user
  // is looking at it, so it is stamped again. Hidden tabs and
  // background apps retain new work until the panel is visible in front again.
  // One stamp per stretch unopened:
  // `stampedRef` holds the item from the moment its stamp is sent and lets go
  // only once the panel holds the row stamped. So a stamp that fails or lands
  // nothing, and every push while one is in flight, never sends another; a
  // re-arm after a held stamp sends exactly one.
  const stampedRef = useRef<string | null>(null)
  const heldItem = data && data.item.id === itemId ? data.item : null
  const mine = data?.mine === true
  // The item as held, for a host that builds on it (a bot's page: the item's chat).
  const onItemRef = useRef(onItem)
  onItemRef.current = onItem
  const loadFailed = !!error && !heldItem
  useEffect(() => {
    onItemRef.current?.(heldItem, loadFailed)
  }, [heldItem, loadFailed])
  useEffect(() => {
    if (!heldItem) return
    if (heldItem.opened_at) {
      if (stampedRef.current === itemId) stampedRef.current = null
      return
    }
    if (!mine || !drawn || !foreground || stampedRef.current === itemId) return
    stampedRef.current = itemId
    void fetch(`/api/account/activity/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'opened' }),
    })
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json().catch(() => null)) as { opened_at?: string | null } | null
        const openedAt = body?.opened_at
        if (!openedAt) return
        setData((cur) =>
          cur && cur.item.id === itemId && !cur.item.opened_at ? { ...cur, item: { ...cur.item, opened_at: openedAt } } : cur,
        )
      })
      .catch(() => {})
  }, [heldItem, mine, itemId, drawn, foreground])

  // Opening the item reads its notices (bots v3 1b), even one that landed
  // after an earlier open had stamped it (a verdict run opened while it ran,
  // whose digest came later): with the row already stamped, the same
  // idempotent `opened` PATCH is sent once for the unread notices the window
  // holds for it, and the server reads them (the realtime UPDATE clears them).
  // The window holds only the workspace on screen's notices, so an item from
  // another one (a bot's page shows any workspace's items, Phase 2) sends it
  // once per open whatever the window holds: the server reads every unread
  // notice for the item (markItemNoticesRead). A bot's notices count here
  // too (bots-v4 Phase 4c): the window holds
  // them (`botNotices`), and opening the item is what reads them.
  const { notifications, botNotices } = useNotifications()
  const unreadNotices = useMemo(
    () =>
      [...notifications, ...botNotices]
        .filter((n) => !n.is_read && n.target_type === 'work_item' && n.target_id === itemId)
        .map((n) => n.id)
        .sort()
        .join(','),
    [notifications, botNotices, itemId],
  )
  const noticesReadRef = useRef<string | null>(null)
  const alreadyOpened = !!heldItem?.opened_at
  // From another workspace than the one on screen: the window doesn't hold its notices.
  const otherWorkspace = !!heldItem && !!activeWorkspaceId && heldItem.workspace_id !== activeWorkspaceId
  const noticesKey = otherWorkspace ? `${itemId}:other-workspace` : unreadNotices ? `${itemId}:${unreadNotices}` : null
  useEffect(() => {
    if (!alreadyOpened || !noticesKey || !mine || !drawn || !foreground) return
    if (noticesReadRef.current === noticesKey) return
    noticesReadRef.current = noticesKey
    void fetch(`/api/account/activity/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'opened' }),
    }).catch(() => {})
  }, [alreadyOpened, noticesKey, mine, itemId, drawn, foreground])

  const item = data?.item ?? null
  const output = data?.output ?? null
  const live = !!item && isWorkLive(item.status)

  // Live without polling (plan 1.2): the row itself on `tracked_job id=eq.<item>`
  // (owner RLS; the full row carries status, current_step and progress.steps),
  // patched in place. Only a status transition — or a teammate the panel has not
  // resolved — refetches, because that is when the folded output changes.
  const dataRef = useRef(data)
  dataRef.current = data
  useRowChanges<WorkItem>({
    table: 'tracked_job',
    filter: `id=eq.${itemId}`,
    onRow: (row) => {
      const prev = dataRef.current
      if (!prev) return
      const refold =
        prev.item.status !== row.status || (row.ai_team_member_id ?? null) !== (prev.item.ai_team_member_id ?? null)
      setData((cur) => (cur ? { ...cur, item: { ...row, teammate: cur.item.teammate ?? null } } : cur))
      if (refold) void load()
    },
    onResync: () => void load(),
  })
  // …its handoffs on `tracked_job parent_id=eq.<item>` (row 14): a child's
  // status moves under the parent without the parent's row changing. A child
  // the panel has not loaded yet refetches (its teammate comes with the load).
  useRowChanges<WorkItem>({
    table: 'tracked_job',
    filter: `parent_id=eq.${itemId}`,
    onRow: (row) => {
      const prev = dataRef.current
      if (!prev) return
      const known = (prev.children ?? []).find((c) => c.id === row.id)
      if (!known) {
        void load()
        return
      }
      setData((cur) =>
        cur
          ? { ...cur, children: (cur.children ?? []).map((c) => (c.id === row.id ? { ...row, teammate: c.teammate ?? null } : c)) }
          : cur,
      )
    },
    onResync: () => void load(),
  })
  // …and its run on `agent_run id=eq.<run>`: the log tail and the parked
  // question move there without the item row changing.
  useRowChanges<AgentRunRow>({
    table: 'agent_run',
    filter: item?.agent_run_id ? `id=eq.${item.agent_run_id}` : null,
    onRow: (row) => {
      setData((cur) => {
        if (!cur) return cur
        return {
          ...cur,
          run: cur.run
            ? { ...cur.run, status: row.status, pr_url: row.pr_url ?? null, pending_input: row.pending_input ?? null }
            : cur.run,
          output: cur.output && cur.output.run ? { ...cur.output, run: runFrom(row) } : cur.output,
        }
      })
    },
    onResync: () => void load(),
  })

  const foreignWorkspaceId =
    activeWorkspaceId && item && item.workspace_id !== activeWorkspaceId ? item.workspace_id : null
  const nav = useMemo(
    () => ({ workspaceId: item?.workspace_id ?? activeWorkspaceId ?? '', foreignWorkspaceId }),
    [item?.workspace_id, activeWorkspaceId, foreignWorkspaceId],
  )

  // The tier-2 gate for contacts (Sequence step 2, plan A.1): releasing the
  // HubSpot push hold on a contact this run created is the person's explicit
  // approval; Mark reviewed alone never releases one.
  const heldContacts = data?.held_contacts ?? []
  const releaseHeld = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      setBusy(ids.length === 1 ? `release:${ids[0]}` : 'release:all')
      try {
        const results = await Promise.all(ids.map((id) => releaseHubspotHold(id, data?.item.workspace_id ?? null)))
        const failed = results.filter((ok) => !ok).length
        if (failed === 0) toast(ids.length === 1 ? 'Released — syncing to HubSpot' : `Released ${ids.length} contacts — syncing to HubSpot`)
        else toast.error(failed === ids.length ? 'Could not release the hold' : `Could not release ${failed} of ${ids.length}`)
        await load()
      } finally {
        setBusy(null)
      }
    },
    [load, data?.item.workspace_id],
  )

  const review = useCallback(
    async (action: 'reviewed' | 'dismiss') => {
      setBusy(action)
      try {
        const res = await fetch(`/api/account/activity/${itemId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (!res.ok) throw new Error('request failed')
        await load()
      } catch {
        toast.error('Could not update this work item')
      } finally {
        setBusy(null)
      }
    },
    [itemId, load],
  )

  const stopWaiting = useCallback(async () => {
    setBusy('stop_waiting')
    try {
      if (await requestStopWaiting(itemId)) await load()
    } finally {
      setBusy(null)
    }
  }, [itemId, load])

  const stop = useCallback(async () => {
    if (!item?.agent_run_id) return
    setBusy('stop')
    try {
      // A run with a tracked action stops through the action's route; one
      // without (an auto-attempted run) through the run-scoped route.
      const url = item.source?.action_id
        ? `/api/account/actions/${item.source.action_id}/agent-runs/${item.agent_run_id}/cancel`
        : `/api/account/agent-runs/${item.agent_run_id}/cancel`
      // The run's own workspace: the cancel routes scope to the header's, and
      // a bot's page can show an item from a workspace that isn't on screen.
      const res = await fetch(url, { method: 'POST', headers: { 'x-workspace-id': item.workspace_id } })
      if (!res.ok) throw new Error('request failed')
      toast('Stopping the run')
      await load()
    } catch {
      toast.error('Could not stop this run')
    } finally {
      setBusy(null)
    }
  }, [item, load])

  /** A card's own verbs — the same PATCH the rail issues, so the rail's live
   *  subscription drops the card the moment it settles here. */
  const resolveCard = useCallback(
    async (card: WorkOutputCard, action: 'accept' | 'start' | 'dismiss') => {
      setBusy(`card:${card.id}`)
      try {
        const res = await fetch('/api/account/attention-items', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: card.id, action }),
        })
        if (res.ok) {
          toast(action === 'dismiss' ? 'Card dismissed' : action === 'start' ? 'Work started' : 'Accepted')
          await load()
          return
        }
        const detail = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
        if (res.status === 409 && detail.code === 'UPDATE_TARGET_UNRESOLVED') {
          toast.error('Pick the action this updates first', { description: 'Open the card on the rail to choose it.' })
          return
        }
        if (res.status === 409) {
          // Already settled elsewhere — the reload shows where it landed.
          await load()
          return
        }
        toast.error(detail.error || 'Could not update the card')
      } catch {
        toast.error('Could not update the card')
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  /** A record (or a page) it names, as a card in the chat, in the item's own workspace. */
  const openEntity = useCallback(
    (target: OpenTarget) => void openTarget(target, { from: 'work-item', workspaceId: foreignWorkspaceId }),
    [foreignWorkspaceId],
  )

  /** Another work item (a handoff's parent or child), where any item opens: on its bot's page, else on a card of its own. */
  const openWorkItem = useCallback(
    (other: WorkItem) => {
      openWorkItemWhereItOpens(other.id, [], {
        workspaceId: other.workspace_id,
        title: other.title,
        // Its teammate: the row's, else its embed's (a pushed row carries the id, a loaded one both).
        teammateId: other.ai_team_member_id ?? other.teammate?.id ?? null,
      })
    },
    [openWorkItemWhereItOpens],
  )

  const openRef = useCallback(
    (ref: WorkOutputRef) => {
      switch (ref.type) {
        case 'capture':
          openEntity({ type: 'capture', id: ref.id, title: ref.label })
          return
        case 'action':
          openEntity({ type: 'action', id: ref.id, title: ref.identifier || ref.label })
          return
        case 'flow':
          openEntity({ type: 'flow', id: ref.id, title: ref.label, runId: item?.flow_run_id ?? null })
          return
      }
    },
    [openEntity, item?.flow_run_id],
  )

  const openRun = useCallback(() => {
    if (!item) return
    if (item.agent_run_id) {
      const target = agentRunTarget({
        id: item.agent_run_id,
        action_id: (item.source?.action_id as string | undefined) ?? null,
        title: item.title,
      })
      if (target.kind === 'card') openEntity(target.target)
      else void openHrefInWorkspace(item.workspace_id, target.url, activeWorkspaceId)
      return
    }
    const flowId = item.source?.flow_id as string | undefined
    if (flowId) openEntity({ type: 'flow', id: flowId, title: item.title, runId: item.flow_run_id ?? null })
  }, [item, openEntity, activeWorkspaceId])

  const openResource = useCallback(
    (r: WorkResourceRef) => {
      if (!RESOURCE_RECORDS.has(r.type) || !r.id) return
      openEntity({ type: r.type, id: r.id, title: r.label } as OpenTarget)
    },
    [openEntity],
  )

  const open = useCallback(
    async (d: WorkDeliverable) => {
      // A cards row only reaches Delivered when the cards could not be shown
      // inline; opening it here goes to the run that surfaced them, not back
      // to this panel.
      const ctx: DeliverableContext = d.type === 'attention_cards' ? { drafts: data?.drafts } : { drafts: data?.drafts, itemId }
      const ok = await openDeliverable(d, ctx, nav)
      if (!ok) toast('Nothing to open for this deliverable')
    },
    [data?.drafts, itemId, nav],
  )

  // ── Derived content ──────────────────────────────────────────────────

  const steps = item ? stepTimeline(item) : []
  // The agent's plan (its own column, patched live with the row).
  const planSteps = item ? planStepsFrom(item.plan) : null
  const pendingInput =
    item?.status === 'needs_input' && data?.run?.status === 'needs_input' && data.run.pending_input
      ? (data.run.pending_input as PendingInput)
      : null
  const needsReview = item?.status === 'needs_review'
  // A local agent's turn: its session, whose conversation (and reply box) this panel holds.
  const localSessionId = item ? localAgentSessionIdOf(item) : null
  // A question nobody can answer any more: its run is gone (deleted with its
  // action) or no longer parked on it. It offers Stop waiting (stop-waiting.ts).
  // A local agent's has no run: its reply box answers it.
  const staleQuestion = !!data && !localSessionId && questionIsStale(item, data.run ? data.run.status : null)
  const localQuestion =
    localSessionId && item?.status === 'needs_input' ? (questionsOf(item.needs)[0]?.text ?? 'It needs your answer to go on.') : null
  const paused = item ? isPausedFailure(item) : false
  const canStop = live && !!item?.agent_run_id
  const canOpenRun = !!item && (!!item.agent_run_id || (!!item.source?.flow_id && !!item.flow_run_id))

  const cards = output?.cards ?? []
  const drafts = output?.drafts ?? []
  const decisions = output?.decisions ?? []
  const run = output?.run ?? null
  const pendingCards = cards.filter((c) => c.status === 'pending').length

  // Deliverables shown inline (cards, drafts) don't repeat under Delivered.
  const inlineDraftIds = useMemo(() => new Set((output?.drafts ?? []).map((d) => d.id)), [output?.drafts])
  const delivered = (item?.deliverables ?? []).filter((d) => {
    if (d.type === 'attention_cards' && cards.length > 0) return false
    if (d.type === 'email_draft' && inlineDraftIds.has(d.id)) return false
    return true
  })
  const draftDeliverables = useMemo(() => {
    const map = new Map<string, WorkDeliverable>()
    for (const d of item?.deliverables ?? []) if (d.type === 'email_draft') map.set(d.id, d)
    return map
  }, [item?.deliverables])

  // The run's own account first; the ledger's settle line when that's all there is.
  const narrative = output?.narrative ?? null
  const summary = item?.result_summary ?? null
  const whatHappened = narrative ?? (item && (item.status === 'done' || needsReview) ? summary : null)
  const subline = narrative && summary && summary !== narrative ? summary : null
  const errorText = item && (item.status === 'failed' || item.status === 'canceled') ? (output?.error ?? item.error_message) : null
  const showWhatHappened = !!(whatHappened || errorText || item?.skip_reason || output?.verdict_missing || (output?.cards_overflow ?? 0) > 0)

  const started = item ? (item.started_at ?? item.created_at) : null
  const timing = !item
    ? ''
    : live
      ? `${durationText(started)} so far`
      : item.finished_at
        ? `${agoText(item.finished_at)} · ${durationText(started, item.finished_at)}`
        : agoText(item.created_at)

  const stepsShown = stepsOpen ?? live
  const planShown = planOpen ?? live
  const logShown = logOpen ?? live
  const KindIcon = item ? (KIND_ICONS[item.kind] ?? Sparkles) : Sparkles

  // Its properties: the window's inspector, or embedded (a bot's page) the
  // column's Details.
  const properties = item ? (
    <>
      <PropertyGroup title="Properties">
        <PropertyRow icon={<StatusIcon status={item.status} paused={paused} className="h-4 w-4" />}>
          {paused ? 'Paused' : WORK_STATUS_TEXT[item.status]}
        </PropertyRow>
        <PropertyRow icon={<KindIcon className="h-4 w-4 shrink-0" />}>{kindLabel(item.kind)}</PropertyRow>
        {item.teammate?.name && (
          <PropertyRow icon={<Boxes className="h-4 w-4 shrink-0" />} title={item.teammate.is_system ? 'A built-in loop' : 'An AI teammate'}>
            {item.teammate.name}
          </PropertyRow>
        )}
        {item.actor !== 'loop' && (
          <PropertyRow icon={item.actor === 'agent' ? <Boxes className="h-4 w-4 shrink-0" /> : <User className="h-4 w-4 shrink-0" />}>
            {item.actor === 'agent' ? 'Run by an agent' : item.actor === 'user' ? 'Started by you' : 'System'}
          </PropertyRow>
        )}
        {started && (
          <PropertyRow icon={<Clock className="h-4 w-4 shrink-0" />} title={started}>
            {dateTime(started)}
          </PropertyRow>
        )}
        {started && (live || item.finished_at) && (
          <PropertyRow icon={<Timer className="h-4 w-4 shrink-0" />}>
            {live ? `${durationText(started)} so far` : durationText(started, item.finished_at)}
          </PropertyRow>
        )}
        {item.reviewed_at && (
          <PropertyRow icon={<Check className="h-4 w-4 shrink-0" />} title={item.reviewed_at}>
            {item.progress?.review === 'dismissed'
              ? 'Dismissed'
              : item.progress?.review === 'expired'
                ? 'Expired unreviewed'
                : 'Reviewed'}{' '}
            {agoText(item.reviewed_at)}
          </PropertyRow>
        )}
      </PropertyGroup>
      {output && output.context.length > 0 && (
        <PropertyGroup title="Source">
          {output.context.map((ref) => {
            const Icon = REF_ICONS[ref.type]
            return (
              <button
                key={`${ref.type}-${ref.id}`}
                type="button"
                onClick={() => openRef(ref)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-sm transition-colors hover:bg-muted/50"
                title={ref.label}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {ref.type === 'action' && ref.identifier ? (
                    <span className="mr-1.5 text-muted-foreground">{ref.identifier}</span>
                  ) : null}
                  {ref.label}
                </span>
              </button>
            )
          })}
        </PropertyGroup>
      )}
    </>
  ) : null

  // Embedded (a bot's page): the item's verbs under its title, no toolbar.
  const inlineVerbs =
    embedded && item && (canStop || canOpenRun) ? (
      <div data-work-item-verbs="" className="flex flex-wrap items-center gap-1.5 pt-1">
        {canStop && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void stop()} disabled={busy !== null}>
            {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            Stop
          </Button>
        )}
        {canOpenRun && (
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" onClick={openRun}>
            {item.agent_run_id ? <Boxes className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
            {item.agent_run_id ? 'Open run' : 'Run history'}
          </Button>
        )}
      </div>
    ) : null

  return (
    <div className="relative flex h-full flex-col" data-work-item-panel={embedded ? 'embedded' : 'panel'}>
      {/* Sub-header toolbar — the item's verbs, at the height every panel shares. Embedded: under the title instead. */}
      {!embedded && (
        <WindowActions className="flex h-10 shrink-0 items-center justify-end gap-1 px-3">
          {canStop && (
            <PreferenceActionButton
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => void stop()}
              disabled={busy !== null}
            >
              {busy === 'stop' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Stop
            </PreferenceActionButton>
          )}
          {canOpenRun && item && (
            <PreferenceActionButton
              label={item.agent_run_id ? 'Open run' : 'Run history'}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={openRun}
              title={item.agent_run_id ? 'Open run' : 'Run history'}
              aria-label={item.agent_run_id ? 'Open run' : 'Run history'}
            >
              {item.agent_run_id ? <Boxes className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
            </PreferenceActionButton>
          )}
        </WindowActions>
      )}

      <ContentTransition contentKey={itemId} className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">{error}</div>
          </div>
        ) : !item ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : (
          <div ref={panelBodyRef} className="flex flex-1 min-h-0 justify-center">
            {/* Left: what the run did. Embedded: the whole column. */}
            <div className={cn('w-full min-w-0', !embedded && 'max-w-[736px] mx-auto')}>
              <ScrollArea className="h-full">
                <div className={embedded ? 'px-4 pb-8 space-y-6' : 'px-8 pb-28 space-y-8'}>
                  {/* Title + status line. pt-6 lines the title up with the sidebar's group header. */}
                  <div className={cn('space-y-2', embedded ? 'pt-4' : 'pt-6')}>
                    <h1 className={cn('font-semibold leading-snug', embedded ? 'text-lg' : 'text-2xl')}>{item.title}</h1>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusIcon status={item.status} paused={paused} className="h-3.5 w-3.5" />
                        <span className={statusTone(item.status, paused)}>{paused ? 'Paused' : WORK_STATUS_TEXT[item.status]}</span>
                      </span>
                      <span aria-hidden>·</span>
                      <span title={item.created_at}>{timing}</span>
                      {live && item.current_step ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-foreground/80">{item.current_step}</span>
                        </>
                      ) : null}
                    </div>
                    {inlineVerbs}
                    {data?.parent ? (
                      <button
                        type="button"
                        onClick={() => openWorkItem(data.parent!)}
                        className="flex max-w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
                        data-testid="delegated-by"
                      >
                        <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">
                          Delegated by <span className="font-medium text-foreground/80">{handedBy(data.parent)}</span>
                          {' · '}
                          {data.parent.title}
                        </span>
                      </button>
                    ) : null}
                  </div>

                  {/* Needs you — the parked question (the run's own answer form) or the review verbs. */}
                  {pendingInput && data?.run ? (
                    <RunQuestionSection runId={data.run.id} pendingInput={pendingInput} onResumed={() => void load()} />
                  ) : null}
                  {localQuestion && (
                    <div data-local-agent-question="" className="space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        <MessageCircleQuestion className="h-3.5 w-3.5" />
                        Needs you
                      </p>
                      <p className="whitespace-pre-wrap text-sm">{localQuestion}</p>
                      <p className="text-xs text-muted-foreground">
                        {conversationBeside ? 'Answer it in the conversation with your Mac.' : 'Answer it in the conversation below.'}
                      </p>
                    </div>
                  )}
                  {staleQuestion && (
                    <div data-stale-question="" className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        <Clock className="h-3.5 w-3.5" />
                        Needs you
                      </p>
                      <p className="text-sm">It asked a question, but the run that asked it is gone or has moved on, so it can&apos;t be answered.</p>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void stopWaiting()} disabled={busy !== null}>
                        {busy === 'stop_waiting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        Stop waiting
                      </Button>
                    </div>
                  )}
                  {needsReview && (
                    <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        <Clock className="h-3.5 w-3.5" />
                        Needs you
                      </p>
                      <p className="text-sm">{reviewLine(item)}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void review('reviewed')} disabled={busy !== null}>
                          {busy === 'reviewed' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Mark reviewed
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void review('dismiss')} disabled={busy !== null}>
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* A local agent's conversation, the whole session's (unless the page draws it beside). */}
                  {localSessionId && !conversationBeside && (
                    <section data-work-item-local-agent={localSessionId} className="space-y-3">
                      <SectionHeading>Conversation</SectionHeading>
                      <div className="flex h-[min(560px,65vh)] min-h-[320px] flex-col">
                        <LocalAgentPanel key={localSessionId} sessionId={localSessionId} />
                      </div>
                    </section>
                  )}

                  {/* Handoffs (row 14): what this item handed to teammates, live. */}
                  {(data?.children?.length ?? 0) > 0 && (
                    <HandoffsSection
                      items={data!.children!}
                      waiting={item.status === 'waiting_on_child'}
                      onOpen={openWorkItem}
                    />
                  )}

                  {/* Held from HubSpot — contacts this run created; releasing is the approval. */}
                  {heldContacts.length > 0 && (
                    <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3" data-testid="held-contacts">
                      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        <CirclePause className="h-3.5 w-3.5" />
                        Held from HubSpot
                      </p>
                      <p className="text-sm">
                        {heldContacts.length === 1 ? 'A contact this run created is' : `${heldContacts.length} contacts this run created are`} not
                        pushed to HubSpot until you release {heldContacts.length === 1 ? 'it' : 'them'}.
                      </p>
                      <ul className="space-y-1">
                        {heldContacts.map((c) => (
                          <li key={c.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs">
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate text-left text-foreground/80 hover:underline"
                              title={HUBSPOT_HOLD_TITLE}
                              onClick={() => openEntity({ type: 'contact', id: c.id, title: c.full_name || c.email || 'Contact' })}
                            >
                              {c.full_name || c.email || 'Contact'}
                              {c.email && c.full_name ? <span className="text-muted-foreground"> · {c.email}</span> : null}
                            </button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 gap-1 px-2 text-[11px]"
                              onClick={() => void releaseHeld([c.id])}
                              disabled={busy !== null}
                            >
                              {busy === `release:${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              Release
                            </Button>
                          </li>
                        ))}
                      </ul>
                      {heldContacts.length > 1 && (
                        <Button
                          size="sm"
                          className="h-7 gap-1.5 text-xs"
                          onClick={() => void releaseHeld(heldContacts.map((c) => c.id))}
                          disabled={busy !== null}
                        >
                          {busy === 'release:all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Release all
                        </Button>
                      )}
                    </div>
                  )}

                  {/* What happened — in the run's own words. */}
                  {showWhatHappened && (
                    <section className="space-y-3">
                      <SectionHeading>What happened</SectionHeading>
                      {whatHappened && (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85"><Linkify text={whatHappened} /></p>
                      )}
                      {subline && <p className="text-xs text-muted-foreground">{subline}</p>}
                      {output?.verdict_missing && (
                        <p className="text-xs text-muted-foreground">The run ran out of steps before deciding — nothing was applied.</p>
                      )}
                      {errorText &&
                        (paused ? (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="leading-relaxed">Paused: AI usage limit reached</span>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="select-text whitespace-pre-wrap leading-relaxed">{errorText}</span>
                          </div>
                        ))}
                      {item.skip_reason && <p className="text-sm text-muted-foreground">{item.skip_reason}</p>}
                      {(output?.cards_overflow ?? 0) > 0 && (
                        <p className="text-xs text-muted-foreground">
                          +{output!.cards_overflow} more left in the capture beyond the card cap
                        </p>
                      )}
                    </section>
                  )}

                  {/* For you — what it proposes, where each stands, and its verbs. */}
                  {(cards.length > 0 || drafts.length > 0) && (
                    <section className="space-y-3">
                      <SectionHeading count={pendingCards > 0 ? `${pendingCards} waiting` : undefined}>For you</SectionHeading>
                      <ul className="space-y-2">
                        {cards.map((card) => (
                          <li key={card.id}>
                            <CardRow card={card} busy={busy !== null} onResolve={resolveCard} />
                          </li>
                        ))}
                        {drafts.map((draft) => (
                          <li key={draft.id}>
                            <DraftRow draft={draft} deliverable={draftDeliverables.get(draft.id) ?? null} onOpen={open} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Delivered — with the verb each type implies. */}
                  {delivered.length > 0 && (
                    <section className="space-y-3">
                      <SectionHeading>Delivered</SectionHeading>
                      <ul className="space-y-1">
                        {delivered.map((d, i) => (
                          <li key={`${d.type}-${d.id}-${i}`}>
                            <button
                              type="button"
                              onClick={() => void open(d)}
                              className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                            >
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {DELIVERABLE_TAGS[d.type] ?? d.type}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-foreground/80">{output?.labels[labelKey(d)] ?? d.label}</span>
                              {d.resolved_at ? <Check className="h-3 w-3 shrink-0 text-emerald-500" /> : null}
                              <span className="shrink-0 text-[10px] text-primary">{deliverableVerb(d)}</span>
                              {d.type === 'pr' || d.type === 'url' ? <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/60" /> : null}
                            </button>
                            {/* A Studio export's file: downloaded straight from the app (its own link, the person's session). */}
                            {d.type === 'studio_video' && typeof d.url === 'string' && d.url.startsWith('/api/account/studio/file/') ? (
                              <a href={d.url} download className="mt-1 inline-block px-2.5 text-[11px] text-primary hover:underline">
                                Download the MP4
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Everything it looked at — every proposal, by outcome, with its reason. */}
                  {decisions.length > 0 && (
                    <Disclosure
                      label="Everything it looked at"
                      count={decisions.length}
                      open={decisionsOpen}
                      onToggle={() => setDecisionsOpen((v) => !v)}
                    >
                      <div className="space-y-4">
                        {groupDecisions(decisions).map(([outcome, rows]) => (
                          <div key={outcome} className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">
                              {outcomeLabel(outcome, item.kind)} <span className="opacity-70">({rows.length})</span>
                            </p>
                            <ul className="divide-y divide-border/50">
                              {rows.slice(0, DECISION_ROWS_CAP).map((d, i) => (
                                <li key={`${d.proposal_id}-${i}`} className="py-1.5 text-xs">
                                  <p className="text-foreground/80">{d.title}</p>
                                  {(d.reason || d.detail) && (
                                    <p className="text-muted-foreground">{d.reason || d.detail}</p>
                                  )}
                                </li>
                              ))}
                              {rows.length > DECISION_ROWS_CAP && (
                                <li className="py-1.5 text-xs text-muted-foreground">+{rows.length - DECISION_ROWS_CAP} more</li>
                              )}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </Disclosure>
                  )}

                  {/* An agent run's brief, resources and terminal. */}
                  {run && (run.task || run.resources.length > 0) && (
                    <section className="space-y-3">
                      <WorkTask task={run.task} />
                      <WorkResources resources={run.resources} onOpen={openResource} />
                    </section>
                  )}
                  {run?.log_tail && (
                    <Disclosure label="Log" open={logShown} onToggle={() => setLogOpen(!logShown)}>
                      <Terminal log={run.log_tail} sandboxId={run.sandbox_id} live={live} logRef={logRef} onScroll={() => {}} />
                    </Disclosure>
                  )}

                  {/* Plan — the agent's checklist for this job, above its steps. */}
                  {planSteps && (
                    <Disclosure label="Plan" count={planBadge(planSteps)} open={planShown} onToggle={() => setPlanOpen(!planShown)}>
                      <div data-work-item-plan="">
                        <PlanChecklist steps={planSteps} live={live} />
                      </div>
                    </Disclosure>
                  )}

                  {/* Steps — the recorder's phrases, never the raw log. */}
                  {steps.length > 0 && (
                    <Disclosure label="Steps" count={steps.length} open={stepsShown} onToggle={() => setStepsOpen(!stepsShown)}>
                      <div className="relative space-y-0">
                        <div className="absolute left-[9px] top-3 bottom-3 w-px bg-border" />
                        {steps.map((s, i) => {
                          const last = i === steps.length - 1
                          return (
                            <div key={`${s.at}-${i}`} className="relative flex items-start gap-3 py-1.5">
                              <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                                {last && live ? (
                                  <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-500" />
                                ) : (
                                  <Circle className="h-2 w-2 text-muted-foreground/60" fill="currentColor" />
                                )}
                              </div>
                              <p className={cn('text-xs', last && live ? 'text-foreground' : 'text-muted-foreground')}>
                                {s.text}
                                <span className="text-muted-foreground/70" title={s.at}>
                                  {' '}
                                  · {relativeTime(s.at)}
                                </span>
                              </p>
                            </div>
                          )
                        })}
                      </div>
                    </Disclosure>
                  )}

                  {/* Embedded: its properties fold into the column. */}
                  {embedded && (
                    <Disclosure label="Details" open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)}>
                      <div data-work-item-details="" className="space-y-3 [&_[data-properties-heading]]:hidden">
                        {properties}
                      </div>
                    </Disclosure>
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Right: properties sidebar, the way every entity panel has one. Embedded: in the column (Details, above). */}
            {!embedded && (
              <WindowProperties title={item.title || 'Agent work'} fallbackVisible={propertiesVisible}>
                <div className="p-4 space-y-4">{properties}</div>
              </WindowProperties>
            )}
          </div>
        )}
      </ContentTransition>
    </div>
  )
}

// ─── Pieces ────────────────────────────────────────────────────────────────

function SectionHeading({ children, count }: { children: React.ReactNode; count?: string }) {
  return (
    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
      {children}
      {count ? <span className="ml-1.5 text-[10px] normal-case tracking-normal opacity-70">{count}</span> : null}
    </p>
  )
}

/** A collapsible section: the same heading, with a chevron. */
function Disclosure({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string
  /** A count beside the label, or a short badge ("3/5"). */
  count?: number | string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} />
        {label}
        {count != null ? <span className="text-[10px] normal-case tracking-normal opacity-70">{count}</span> : null}
      </button>
      {open && children}
    </section>
  )
}

function PropertyRow({ icon, children, title }: { icon: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground" title={title}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function CardRow({
  card,
  busy,
  onResolve,
}: {
  card: WorkOutputCard
  busy: boolean
  onResolve: (card: WorkOutputCard, action: 'accept' | 'start' | 'dismiss') => void
}) {
  const Icon = CARD_ICONS[card.kind] ?? MessageCircleQuestion
  const pending = card.status === 'pending'
  const facts: string[] = []
  if (card.change_type && card.entity_type) facts.push(`${CHANGE_VERBS[card.change_type] ?? card.change_type} ${card.entity_type}`)
  if (card.priority && card.priority !== 'none') facts.push(`${card.priority} priority`)
  if (card.due_date) facts.push(`due ${shortDate(card.due_date)}`)
  if (card.email_to) facts.push(`to ${card.email_to}`)
  const primary: { action: 'accept' | 'start'; label: string } =
    card.kind === 'work_proposal'
      ? { action: 'start', label: 'Start' }
      : card.kind === 'draft_email'
        ? { action: 'accept', label: 'Draft email' }
        : card.kind === 'question'
          ? { action: 'accept', label: 'Got it' }
          : { action: 'accept', label: 'Accept' }
  return (
    // `ph-no-capture`: an email card's title, why and brief; session replay blocks it.
    <div className={cn('ph-no-capture space-y-2 rounded-lg border p-3', pending ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/60 bg-card/50')}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-snug">{card.title}</p>
          {card.why && <p className="text-xs text-muted-foreground">{card.why}</p>}
          {card.detail && <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80"><Linkify text={card.detail} /></p>}
          {facts.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {facts.map((f) => (
                <span key={f} className={chipClass}>
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
        {!pending && <CardStatus status={card.status} at={card.resolved_at} />}
      </div>
      {pending && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onResolve(card, primary.action)} disabled={busy}>
            {primary.label}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onResolve(card, 'dismiss')} disabled={busy}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}

function CardStatus({ status, at }: { status: string; at: string | null }) {
  const when = at ? ` · ${agoText(at)}` : ''
  if (status === 'accepted') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400" title={at ?? undefined}>
        <Check className="h-3 w-3" />
        Accepted{when}
      </span>
    )
  }
  return (
    <span className="shrink-0 text-[11px] text-muted-foreground" title={at ?? undefined}>
      {status === 'dismissed' ? 'Dismissed' : status === 'expired' ? 'Expired' : status}
      {when}
    </span>
  )
}

function DraftRow({
  draft,
  deliverable,
  onOpen,
}: {
  draft: WorkOutputDraft
  deliverable: WorkDeliverable | null
  onOpen: (d: WorkDeliverable) => void
}) {
  const sent = draft.status === 'sent'
  const discarded = draft.status === 'dismissed'
  const pending = !sent && !discarded
  return (
    // `ph-no-capture`: the draft's recipients, subject and snippet; session replay blocks it.
    <div className={cn('ph-no-capture space-y-2 rounded-lg border p-3', pending ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/60 bg-card/50')}>
      <div className="flex items-start gap-2">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-snug">{draft.subject ?? deliverable?.label ?? 'Draft'}</p>
          {draft.to.length > 0 && <p className="text-xs text-muted-foreground">To {draft.to.join(', ')}</p>}
          {draft.snippet && <p className="text-xs leading-relaxed text-foreground/80">{draft.snippet}</p>}
        </div>
        {!pending && (
          <span className={cn('shrink-0 text-[11px]', sent ? 'inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
            {sent ? <Check className="h-3 w-3" /> : null}
            {sent ? 'Sent' : 'Discarded'}
          </span>
        )}
      </div>
      {deliverable && (
        <div className="pl-6">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onOpen(deliverable)}>
            {deliverableVerb(deliverable)}
          </Button>
        </div>
      )}
    </div>
  )
}

function statusTone(status: WorkStatus, paused: boolean): string {
  if (paused || status === 'needs_input' || status === 'needs_review') return 'text-amber-700 dark:text-amber-400'
  if (status === 'running' || status === 'queued' || status === 'waiting_on_child') return 'text-blue-600 dark:text-blue-400'
  if (status === 'done') return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'failed') return 'text-destructive'
  return 'text-muted-foreground'
}

/** Where an agent run's execution detail opens: the tracked action's Cloud-run
 *  view (a card) when there is an action, else the standalone run page. Pure. */
export type AgentRunOpenTarget =
  | { kind: 'card'; target: OpenTarget }
  | { kind: 'url'; url: string }

export function agentRunTarget(run: {
  id: string
  action_id: string | null
  action_identifier?: string | null
  title: string
}): AgentRunOpenTarget {
  if (run.action_id) {
    return { kind: 'card', target: { type: 'action', id: run.action_id, title: run.action_identifier || run.title, section: 'cloud' } }
  }
  return { kind: 'url', url: `/account/agent-runs/${run.id}` }
}

export function StatusIcon({ status, paused, className }: { status: WorkStatus; paused?: boolean; className?: string }) {
  const c = cn('h-3 w-3 shrink-0', className)
  if (paused) return <AlertTriangle className={cn(c, 'text-amber-500')} />
  switch (status) {
    case 'needs_input':
      return <MessageCircleQuestion className={cn(c, 'animate-pulse text-amber-500')} />
    case 'needs_review':
      return <Clock className={cn(c, 'text-amber-500')} />
    case 'running':
      return <Loader2 className={cn(c, 'animate-spin text-blue-500')} />
    case 'queued':
    case 'waiting_on_child':
      return <Clock className={cn(c, 'text-blue-500')} />
    case 'done':
      return <CheckCircle2 className={cn(c, 'text-emerald-500')} />
    case 'failed':
      return <XCircle className={cn(c, 'text-destructive')} />
    case 'skipped':
      return <CircleSlash className={cn(c, 'text-muted-foreground')} />
    case 'canceled':
      return <XCircle className={cn(c, 'text-muted-foreground')} />
  }
}

/** Who handed an item its work: the parent's teammate, by name and role. */
function handedBy(parent: WorkItem): string {
  const mate = parent.teammate
  if (!mate) return 'a teammate'
  const role = mate.role && isWorkRole(mate.role) ? WORK_ROLE_LABELS[mate.role] : null
  return role && mate.name && mate.name !== role ? `${mate.name} (${role})` : mate.name || role || 'a teammate'
}

/**
 * The rows an item handed work to (row 14), each with its live status and a
 * link: "Waiting on" while the item is parked on them, "Handed off" after.
 */
function HandoffsSection({
  items,
  waiting,
  onOpen,
}: {
  items: WorkItem[]
  waiting: boolean
  onOpen: (item: WorkItem) => void
}) {
  return (
    <div
      className={cn(
        'space-y-2 rounded-xl border p-3',
        waiting ? 'border-blue-500/30 bg-blue-500/5' : 'border-border/60 bg-muted/20',
      )}
      data-testid="handoffs"
    >
      <p
        className={cn(
          'flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide',
          waiting ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground',
        )}
      >
        <CornerDownRight className="h-3.5 w-3.5" />
        {waiting ? 'Waiting on' : 'Handed off'}
      </p>
      <ul className="space-y-1">
        {items.map((child) => {
          const mate = child.teammate
          const role = mate?.role && isWorkRole(mate.role) ? WORK_ROLE_LABELS[mate.role] : null
          return (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => onOpen(child)}
                className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-xs hover:bg-muted/40"
              >
                <StatusIcon status={child.status} className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground/90">{child.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {mate?.name || role || 'Teammate'}
                    {role && mate?.name && mate.name !== role ? ` · ${role}` : ''}
                    {' · '}
                    {itemLine(child)}
                  </span>
                </span>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
