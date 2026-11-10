'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { parseISO } from 'date-fns'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight,
  Check,
  Circle,
  Flag,
  Folder,
  Boxes,
  GitPullRequest,
  Loader2,
  Mail,
  MessageCircle,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SmartText } from './smart-text'
import { ActionTargetPicker } from './action-target-picker'
import { PushToTrackerMenu } from '@/components/tasks/push-to-tracker-menu'
import {
  ActionPlatformIcon,
  type PlatformLink,
} from '@/components/tasks/action-platform-icon'
import {
  defaultLens,
  PropertyLensSwitcher,
  TaskLens,
  useActionLinkProviders,
} from '@/components/tasks/task-lens'
import { isLensProvider } from '@/lib/tasks/task-lens'
import { onEntityUpdated } from '@/lib/entity-events'
import { deriveButtonLabel, derivePendingReason, isTargetlessUpdate, isUnsupportedChange } from '@/lib/proposed-changes/derive-ui'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import type { TrustPolicy } from '@/lib/proposed-changes/trust-policy'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'
import {
  PropertyPill as SharedPropertyPill,
  type PropertyPillProps,
} from '@/components/views/properties'
import { Linkify } from '@/components/ui/linkify'

// ── Shared constants ────────────────────────────────────────────

const PROJECT_STATUSES = [
  { value: 'planning', label: 'Planning' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const MILESTONE_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
]

// ── PropertyPill ────────────────────────────────────────────────

/**
 * This card's binding of the shared pill. The `proposal` variant reproduces the
 * DOM this file used to build inline (h-7, shadow-sm, 80px label, 200px popover,
 * `error` outline) — see components/views/properties/property-pill.tsx.
 */
function PropertyPill(props: Omit<PropertyPillProps, 'variant'>) {
  return <SharedPropertyPill {...props} variant="proposal" />
}

// ── Required field validation ───────────────────────────────────

export type RequiredField = 'project' | 'assignee' | 'status' | 'entity'

/**
 * Returns the set of property fields that are missing but required for this change to apply.
 * Pass `knownProjectIds` so we can detect when entity_id points to a project not in the dropdown.
 */
export function getMissingRequiredFields(
  change: ProposedChange,
  knownProjectIds?: Set<string>,
): Set<RequiredField> {
  const missing = new Set<RequiredField>()
  const key = `${change.change_type}:${change.entity_type}`

  switch (key) {
    case 'create:milestone':
      if (!change.project_id) missing.add('project')
      break
    case 'update:project':
      // entity_id must be set AND resolve to a known project
      if (!change.entity_id || (knownProjectIds && !knownProjectIds.has(change.entity_id))) {
        missing.add('project')
      }
      break
    case 'update:action':
    case 'update:milestone':
    case 'delete:action':
      if (!change.entity_id) missing.add('entity')
      break
    case 'assign:action':
      // entity_id is validated server-side at apply time; no UI picker exists to set it,
      // so blocking the button here would permanently disable it with no escape hatch.
      if (!change.assignee_member_id) missing.add('assignee')
      break
  }

  return missing
}

/**
 * Whether an applied proposal can be undone from the UI. Only `create:*` applies
 * spawned a fresh entity we can delete; `update`/`assign` mutated pre-existing
 * data we can't reverse without recorded prior state. Mirrors the guard in the
 * undo route, so the button never offers an action the server will reject.
 */
export function canUndoChange(change: ProposedChange): boolean {
  return change.status === 'applied' && change.change_type === 'create'
}

/**
 * Entity types that have a standalone detail panel we can open. Decisions and
 * milestones live inside their parent (capture / project) and aren't openable on
 * their own, so applied proposals for those get no "open" affordance.
 */
const OPENABLE_ENTITY_TYPES = new Set(['action', 'project', 'contact'])

/** Whether an applied proposal points at an openable entity. */
export function getOpenableEntity(
  change: ProposedChange,
): { entityType: string; entityId: string } | null {
  if (change.status !== 'applied' || !change.result_entity_id) return null
  if (!OPENABLE_ENTITY_TYPES.has(change.entity_type)) return null
  return { entityType: change.entity_type, entityId: change.result_entity_id }
}

// ── ProposalCard ────────────────────────────────────────────────

interface ProposalCardProps {
  change: ProposedChange
  /**
   * Accept the proposal. Resolves to the id of the entity it created when the
   * caller knows it (the apply route returns `entity_id`) — that's what lets the
   * "Push to…" menu confirm a still-suggested item and then push the very action
   * it just created, without scraping for it afterwards. Callers that don't need
   * that (read-only views) may keep returning void.
   */
  onApply: (changeId: string) => Promise<string | null | void>
  onDismiss: (changeId: string) => Promise<void>
  onEdit: (changeId: string, updates: Record<string, unknown>) => Promise<void>
  /**
   * Un-apply an already-applied (or auto-accepted) change: deletes the entity it
   * created and re-stages it as pending. Optional — omit to hide the Undo
   * affordance (e.g. read-only/share views).
   */
  onUndo?: (changeId: string) => Promise<void>
  /**
   * Open the entity an applied proposal created (e.g. the action). Honors
   * Cmd/Ctrl/middle-click via the event to open in a new in-app tab. Optional —
   * omit to hide the open affordance.
   */
  onOpenEntity?: (entityType: string, id: string, title: string, event?: React.MouseEvent) => void
  members?: { id: string; display_name: string; avatar_url: string | null }[]
  /** AI team members (agents) assignable to the action this proposal creates. */
  aiMembers?: { id: string; name: string; avatar_url: string | null }[]
  contacts?: { id: string; full_name: string; email: string | null }[]
  projects?: { id: string; name: string }[]
  /** Current user's member ID — shows "(Me)" badge next to their name */
  currentMemberId?: string | null
  /**
   * Workspace trust policy. When present, a pending proposal that didn't
   * auto-accept shows a small "why" chip (e.g. "Not yours", "Below threshold").
   */
  autoAcceptPolicy?: TrustPolicy | null
  /**
   * When true, the card renders without any action buttons or editable property pills.
   * Used for public share views where the viewer does not own the capture.
   */
  readOnly?: boolean
  /** Open the dashboard settings overlay (used by the "Push to…" menu's CTAs). */
  onOpenSettings?: (subPath?: string) => void
}

function ProposalCardImpl({
  change,
  onApply,
  onDismiss,
  onEdit,
  onUndo,
  onOpenEntity,
  members,
  aiMembers,
  contacts,
  projects,
  currentMemberId,
  autoAcceptPolicy,
  readOnly = false,
  onOpenSettings,
}: ProposalCardProps) {
  const [applying, setApplying] = useState(false)
  /**
   * Synchronously-readable mirror of `applying`. The push menu can already be
   * OPEN when Accept is clicked, and its destination handler runs from a closure
   * that may predate the re-render — reading state there can see a stale
   * `false` and start a second apply on a row whose first POST is still in
   * flight (result_entity_id is null until it lands, so nothing else stops it).
   * A ref is written before the click that reads it can possibly run.
   */
  const applyingRef = useRef(false)
  const beginApply = () => {
    applyingRef.current = true
    setApplying(true)
  }
  const endApply = () => {
    applyingRef.current = false
    setApplying(false)
  }
  const [dismissing, setDismissing] = useState(false)
  const [undoing, setUndoing] = useState(false)
  /**
   * The push form is up, so the row's other contents make way for it.
   *
   * The proposal TEXT and the trailing accept/dismiss cluster both stand down:
   * the strip needs the line, and a row offering "Accept" beside a half-filled
   * Jira form invites two conflicting gestures at once (accepting mid-compose is
   * exactly the double-confirm `applyingRef` exists to prevent). Everything is
   * back the instant compose ends — this is state, not a navigation.
   */
  const [composing, setComposing] = useState(false)
  /**
   * WHERE THE STRIP IS DRAWN — the property row's slot, below the card's own
   * top row.
   *
   * The menu lives in the icon slot at the TOP-LEFT and the form belongs on the
   * PROPERTY LINE underneath, which are two different subtrees. So the menu's
   * node is portalled into a host rendered down there, the same way the action
   * detail panel puts this form in its sidebar.
   *
   * A PORTAL rather than lifting the node into state, for the reason recorded
   * there: `renderCompose` is called during the menu's render, so a `setState`
   * from it would be a render-phase update of another component. The portal
   * moves the DOM without moving ownership — the form stays a child of the menu
   * that built it (its `onCreate` closure, its cancel), which is also what keeps
   * `PushToTrackerMenu` from being remounted by the click that enters compose.
   * It holds the compose state in its own `useState`; a re-branch that mounted a
   * second menu would make the form flash and vanish.
   */
  const [composeHost, setComposeHost] = useState<HTMLElement | null>(null)
  // Hover state for the accept/undo button, tracked in JS rather than via
  // group-hover so the label swap is reliable regardless of CSS group scoping.
  const [acceptHovered, setAcceptHovered] = useState(false)
  // Local agent-run state for the inline Start button (the action this proposal
  // created lives at change.result_entity_id once applied).
  const [agentRunStatus, setAgentRunStatus] = useState<string>('idle')
  const [startingAgent, setStartingAgent] = useState(false)

  const buttonLabel = deriveButtonLabel(change)
  const isPending = change.status === 'pending'
  const isApplied = change.status === 'applied'
  const isDismissed = change.status === 'dismissed'
  // Email proposals don't "apply" silently — the button opens the chat panel and
  // the AI drafts the email interactively (matches the older flow).
  const isEmail = change.change_type === 'send_email'

  // Why is this pending instead of auto-accepted? (null when it would/should have
  // auto-accepted, or policy isn't known yet.) Surfaced as a small chip so a
  // high-confidence item that's "stuck" pending isn't a mystery.
  const pendingReason =
    isPending && !readOnly ? derivePendingReason(change, autoAcceptPolicy, currentMemberId) : null

  // Both pending and applied cards expose the full action row (dismiss, context,
  // properties, action button). Dismissed cards render nothing.
  const isEditable = isPending || isApplied
  // Undo is only meaningful for create:* applies — those spawned an entity we
  // can delete. update/assign mutated pre-existing data we can't reverse.
  const canUndo = !readOnly && !!onUndo && canUndoChange(change)
  // Applied items can link out to the entity they created (if it's openable).
  const openable = onOpenEntity ? getOpenableEntity(change) : null

  // Validation: detect missing required fields (pending only — an applied
  // change already passed validation when it was accepted). Memoized — the
  // projects list is workspace-static, and a capture panel renders dozens of
  // these cards on every proposals refetch.
  const knownProjectIds = useMemo(
    () => (projects ? new Set(projects.map((p) => p.id)) : undefined),
    [projects],
  )
  const missingFields = isPending ? getMissingRequiredFields(change, knownProjectIds) : new Set<RequiredField>()
  const hasMissingFields = missingFields.size > 0

  // Properties panel — auto-open when required fields are missing
  const [showProperties, setShowProperties] = useState(false)

  /**
   * THE PROPERTY LENS — whose properties is this row showing?
   *
   * An APPLIED action row may already be in Jira/Asana/Linear, and opening
   * properties on it should be able to show THAT ticket's live fields rather than
   * only Native Intelligence's. `activeLens` is `'dial8'` or a provider; the switcher only
   * exists when there is at least one link, so an unpushed action sees zero
   * change here — no extra request, no extra control, the same pill row it always
   * had.
   *
   * APPLIED ONLY, and not by preference. A pending proposal has no action row and
   * therefore no `action_external_task` row to read: `result_entity_id` is null
   * until the accept lands. `useActionLinkProviders` is passed that null and does
   * nothing with it.
   *
   * GATED ON `showProperties`, so the link lookup happens when a user actually
   * opens properties. A capture panel renders dozens of these rows and firing
   * three requests per row on mount would be a burst for a switcher nobody
   * looked at — the same lazy-on-open discipline the compact push menu already
   * follows for the very same route.
   */
  const [activeLens, setActiveLens] = useState<string | null>(null)
  /**
   * ACTIONS ONLY. `result_entity_id` is set for every applied row — a contact, a
   * project, a milestone — and `action_external_task` only ever holds actions, so
   * asking the three link routes about a contact id is three requests that can
   * only answer "no" per properties-open. The lens is an action affordance; the
   * gate is what keeps it from taxing the rows it does not apply to.
   */
  const lensActionId = isApplied && change.entity_type === 'action' ? change.result_entity_id : null

  /**
   * LINKS PUSHED OR UNLINKED WHILE THIS ROW'S PROPERTIES ARE OPEN.
   *
   * `useActionLinkProviders` reads once per mount, which is right for a question
   * whose answer only changes when someone changes it — and someone can, from the
   * platform-icon menu on this very row, without the properties view closing. A
   * push to Jira with the switcher already up left it showing only the providers
   * that were linked when it opened.
   *
   * SUBSCRIBED rather than refetched, and to the event the menu ALREADY emits:
   * `republishLinks` broadcasts the full post-mutation provider set on the entity
   * bus after both a push and an unlink, because every list row and board card
   * needs it (`external_links` is a JOIN with no realtime channel of its own). It
   * is the same answer the routes would give, already in hand — so this converges
   * off the broadcast instead of adding a request, and needs nothing new from the
   * menu or the hook.
   *
   * Held as `undefined` until the first event: that is what lets the hook do the
   * INITIAL read (passing an array is how a caller says "don't fetch, I have
   * these"). Once an event lands we own the answer and the hook stands down.
   */
  const [busLinks, setBusLinks] = useState<PlatformLink[] | undefined>(undefined)
  useEffect(() => {
    if (!lensActionId) return
    // A row swap must not carry the previous action's broadcast answer.
    setBusLinks(undefined)
    return onEntityUpdated((detail) => {
      if (detail.entityType !== 'action' || detail.id !== lensActionId) return
      const next = detail.fields?.external_links
      // Only this ONE field is authoritative here. Every other action patch on
      // the bus (a status change, a title edit) carries no `external_links`, and
      // treating its absence as "no links" would unlink the switcher on every
      // unrelated update.
      if (!Array.isArray(next)) return
      setBusLinks(
        next.filter(
          (l): l is PlatformLink =>
            !!l && typeof (l as PlatformLink).provider === 'string',
        ),
      )
    })
  }, [lensActionId])

  const { providers: lensProviders } = useActionLinkProviders(lensActionId, {
    enabled: showProperties && !composing && !readOnly && isEditable,
    links: busLinks,
  })
  // The default lens is a function of the links, which arrive after the first
  // render — so it is applied once, when they land, and never again: a user who
  // switched back to Native Intelligence must not be flipped to Jira by a re-render.
  //
  // BUT STICKY IS NOT TRUSTED: the links `activeLens` names can go away under it
  // (an unlink from this row's own platform-icon menu, now that the bus keeps the
  // list live). A lens pointing at a provider this action is no longer linked to
  // would replace the pills with a permanent `link_not_found` banner whose Retry
  // can never succeed — and with the switcher gone too (it reads the same list),
  // no way back. Constrained to a lens that still exists; `defaultLens([])` is
  // Native Intelligence, which is the pill row this row had before it was ever pushed.
  const lens =
    activeLens && (activeLens === 'dial8' || lensProviders.includes(activeLens))
      ? activeLens
      : defaultLens(lensProviders)
  const showLensSwitcher = lensProviders.length > 0
  const lensProvider = lens !== 'dial8' && isLensProvider(lens) ? lens : null

  // W-4c: a target-less action update can't apply in one click — the primary
  // button opens the shared action picker instead of sitting disabled with no
  // escape hatch (the capture panel is where these duds are actually staged).
  const needsTarget = isPending && !readOnly && isTargetlessUpdate(change)
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)

  // Drift guard: a combo the apply engine has no handler for can only dead-end on
  // "Unsupported change" at accept time. Render it disabled (like a needs-attention
  // card) with a label naming the type, never a one-click Accept that would fail.
  // With the current handler set no live proposal hits this — it's a FUTURE-drift
  // backstop (a proposable combo added without a handler).
  const notSupported = isPending && !readOnly && isUnsupportedChange(change)

  // Keep properties open whenever there are missing required fields
  useEffect(() => {
    if (hasMissingFields) setShowProperties(true)
  }, [hasMissingFields])

  const handleApply = async () => {
    if (applyingRef.current) return
    beginApply()
    try {
      await onApply(change.id)
    } finally {
      endApply()
    }
  }

  // W-4c: the user picked the action this update targets. Persist it on the
  // proposal (the edit endpoint accepts entity_id, so the accept is deterministic
  // from here on — same end state as the rail's target_entity_id retry), then
  // apply. An edit/apply failure leaves the proposal pending + retryable.
  const handlePickTarget = async (picked: { id: string }) => {
    if (applyingRef.current) return
    beginApply()
    try {
      await onEdit(change.id, { entity_id: picked.id })
      await onApply(change.id)
    } finally {
      endApply()
    }
  }

  // The confirm half of "push a still-suggested item": accept it through the
  // normal apply flow and hand back the action that created. An applied row
  // short-circuits to the action it already made, so the menu's retry after a
  // failed push confirms nothing twice.
  const resolveActionForPush = async (): Promise<string | null> => {
    if (change.result_entity_id) return change.result_entity_id
    // An accept is ALREADY in flight for this row — from the Accept button, or
    // from a destination picked in a menu that was open when it was clicked.
    // result_entity_id is still null (the POST hasn't returned), so without this
    // the push would confirm the same proposal a second time and create a second
    // action. Null aborts the push silently: handlePush treats it as "the
    // confirm reported itself", and the in-flight accept owns the messaging.
    if (applyingRef.current) return null
    beginApply()
    try {
      const entityId = await onApply(change.id)
      return typeof entityId === 'string' ? entityId : null
    } finally {
      endApply()
    }
  }

  const handleDismiss = async () => {
    setDismissing(true)
    try {
      await onDismiss(change.id)
    } finally {
      setDismissing(false)
    }
  }

  const handleUndo = async () => {
    if (!onUndo) return
    setUndoing(true)
    try {
      await onUndo(change.id)
    } finally {
      setUndoing(false)
    }
  }

  // Start the assigned agent on the action this proposal created: the action's
  // start-agent endpoint runs it server-side and opens a PR.
  const handleStartAgent = async () => {
    const actionId = change.result_entity_id
    if (!actionId) return
    setStartingAgent(true)
    setAgentRunStatus('working')
    try {
      const res = await fetch(`/api/account/actions/${actionId}/start-agent`, { method: 'POST' })
      if (!res.ok) {
        // Keep the server's reason — it's usually an actionable precondition
        // (no repo connected, GitHub not linked), not a transient glitch.
        throw new Error((await res.json().catch(() => ({})))?.error || 'Could not start the agent')
      }
    } catch (err) {
      setAgentRunStatus('failed')
      const agentName = (aiMembers?.find((a) => a.id === assigneeAiMemberId)?.name) || 'the agent'
      toast.error(`Couldn't start ${agentName}`, {
        description: err instanceof Error ? err.message : 'Could not start the agent',
      })
    } finally {
      setStartingAgent(false)
    }
  }

  // Open the chat panel and ask the AI to draft this email. The chat panel
  // listens for this event globally, so no prop threading is needed.
  const handleDraftEmail = () => {
    window.dispatchEvent(
      new CustomEvent('ni:chat-about-proposal', {
        detail: {
          captureId: change.capture_id,
          proposalId: change.id,
          displayText: change.display_text,
          description: change.description || null,
          reasoning: change.reasoning || null,
          triggerQuote: change.trigger_quote || null,
          changeType: change.change_type,
          entityType: change.entity_type,
          emailToName: change.email_to_name || null,
          emailToAddress: change.email_to_address || null,
          emailSubject: change.email_subject || null,
          emailContext: change.email_context || null,
        },
      }),
    )
  }

  if (isDismissed) return null

  // Derived values for pills
  const currentPriority = PRIORITY_OPTIONS.find((o) => o.value === (change.priority || 'none')) ?? PRIORITY_OPTIONS[0]
  // An agent assignee rides in `extra.assignee_ai_member_id` (no column on
  // proposed_change). It is the delegate beside the person (decision 9).
  const assigneeAiMemberId = (change.extra?.assignee_ai_member_id as string | undefined) || null
  const currentAgent = assigneeAiMemberId ? aiMembers?.find((a) => a.id === assigneeAiMemberId) : null
  // Show a Start control when this proposal created an action assigned to an
  // agent — lets you kick off the coding run right from the capture.
  const showAgentStart =
    isApplied && change.entity_type === 'action' && !!change.result_entity_id && !!currentAgent && !readOnly
  // The far-left platform mark on an extracted action item, and the compose menu
  // it opens. A pending row confirms first (resolveActionForPush), so it's
  // offered only when a one-click confirm would actually succeed — a row missing
  // required fields, needing a target, or with no apply handler must be resolved
  // on its own terms first. Dismissed rows never get here (the card returns null
  // above).
  //
  // The GATE is unchanged from the trailing menu this replaced; only its
  // POSITION moved. A row that fails it falls back to the plain Circle, so the
  // left slot is never empty on a pending row.
  const showPlatformIcon =
    !readOnly &&
    isEditable &&
    change.entity_type === 'action' &&
    (isApplied
      ? !!change.result_entity_id
      : !hasMissingFields && !needsTarget && !notSupported)
  const currentAssignee = !currentAgent ? members?.find((m) => m.id === change.assignee_member_id) : null
  const currentAssigneeContact = !currentAssignee && !currentAgent ? contacts?.find((c) => c.id === change.assignee_contact_id) : null
  const isProjectUpdate = change.change_type === 'update' && change.entity_type === 'project'
  const projectValue = isProjectUpdate ? change.entity_id : change.project_id
  const currentProject = projects?.find((p) => p.id === projectValue)
  const hasContext = !!(change.description || change.reasoning || change.trigger_quote || change.stakes || (change.open_questions && change.open_questions.length > 0))

  return (
    <div className="group rounded-lg bg-transparent transition-colors">
      {/* Main row — THE SAME ROW WHILE COMPOSING.

          Compose is a swap of the PROPERTY ROW, and nothing else. The card's
          anatomy above that row is what tells the user which item they are
          acting on: the platform mark in its top-left slot, the full title
          WRAPPING beside it, the trailing buttons at the end. Compose keeps all
          three, exactly where an accepted card puts them, and replaces only the
          pills underneath with the strip's chips plus Create/X.

          THIS REPLACES AN EARLIER FIX that made the row a `flex-col` while
          composing. That was solving a real overlap — the strip used to land on
          this very line, and with the capture panel only ~608px wide the title
          and the trailing cluster left the scroller ~189px for ~848px of fields
          — but it solved it by dismantling the anatomy: the mark migrated down
          onto the strip's line and the title collapsed to a truncated one-line
          caption above it, so a composing card no longer looked like a card.

          The strip now hangs BELOW this row (see the property-row swap further
          down) instead of sharing it, which frees the full width without moving
          anything: the row keeps `items-start gap-3` in both modes and the
          title is never truncated. `showProperties` is not consulted for the
          composing case — the strip is the property row while it is up, so the
          row's bottom padding follows the same rule either way. */}
      {/* FLOATS, NOT FLEX, and the reason is the wrap. As a three-column flex
          row the mark and the trailing cluster reserved their width down the
          WHOLE height of the row, so a title that wrapped stayed boxed into the
          narrow middle column — at this panel width, a couple of words a line.
          Floating the two side elements takes them out of normal flow: the
          title indents past them on its FIRST line and then runs the full width
          underneath, which is what a wrapped sentence should do.

          Two consequences of floats, both handled below: they reserve no
          vertical space (so the title block carries a `min-h` to keep a
          one-line title off the buttons), and they only affect content that
          FOLLOWS them in source order — which is why the trailing cluster is
          now written ABOVE the title rather than after it. `after:clear-both`
          closes the row so the floats can't leak into the property row. */}
      <div
        data-proposal-row=""
        // For UI automation (src/lib/automation/README.md): which change, and
        // where it stands (applied reads as accepted; a dismissed one isn't drawn).
        data-proposal-id={change.id}
        data-proposal-status={isPending ? 'pending' : isApplied ? 'accepted' : 'dismissed'}
        className={cn(
          'pt-1.5 after:block after:clear-both after:content-[""]',
          showProperties || composing ? 'pb-0.5' : 'pb-1.5',
        )}
      >
        {/* THE FAR-LEFT SLOT, and the one place the two meanings meet.

            For an ACTION it is the platform mark: whose item is this, and the
            way to send it somewhere. It shows for BOTH pending and applied
            rows, which INVERTS what the decorative Circle used to do — the
            Circle was a "still pending" marker and correctly vanished on
            accept, but this is a push affordance and an accepted row is exactly
            when it becomes most useful (there is finally a real action to push).
            A pending row still works: the menu confirms the suggestion first,
            through the same resolveActionForPush the trailing menu used to.

            For every OTHER change type it is still the pending Circle, on the
            old terms: those rows have nothing to push and an accepted one drops
            it so the text starts flush-left. */}
        {showPlatformIcon ? (
          // THE MARK STAYS IN ITS SLOT, in both modes. This wrapper is a plain
          // 16px top-left cell and no longer changes shape while composing: the
          // strip is portalled to the property row below, so nothing needs the
          // mark to move or this wrapper to become a full-width line.
          <div className="float-left mr-3 flex h-5 shrink-0 items-center">
            <PushToTrackerMenu
              compact
              actionId={isApplied ? change.result_entity_id : null}
              actionTitle={change.title ?? change.display_text ?? null}
              onResolveAction={isApplied ? undefined : resolveActionForPush}
              onOpenSettings={onOpenSettings}
              disabled={applying || dismissing}
              // DRAWN ON THE PROPERTY LINE below, not here. The strip needs the
              // card's full width — the capture panel is only ~608px and
              // sharing the top row left the scroller too narrow to show a
              // second field — and the property row is both the full width and
              // the line whose meaning it is taking over. Until that host
              // exists (the first render of compose mode) it draws nothing
              // rather than falling back into the 16px icon slot.
              renderCompose={(node) => (composeHost ? createPortal(node, composeHost) : null)}
              onComposeChange={(destination) => setComposing(!!destination)}
              renderTrigger={({ links, linksKnown, busy, disabled }) => (
                <ActionPlatformIcon
                  // An unresolved row has NOT been asked yet, and an empty list
                  // would claim "Native Intelligence only" on an action that may already be in
                  // Jira. The Native Intelligence mark is the right answer to "nothing links
                  // here", not to "nobody has looked" — so the unknown state is
                  // passed THROUGH rather than flattened to an empty array,
                  // which drew the very claim this comment rules out. An applied
                  // row is in that state on every page load, because the compact
                  // menu defers its link fetch to first open.
                  links={links}
                  known={linksKnown}
                  onOpen={() => {}}
                  disabled={busy || disabled}
                  // The capture row has no fixed-width icon column (unlike the
                  // list/board rows — see action-platform-icon.tsx), so it's the
                  // one surface that can afford to spell the mark out: "Native Intelligence"
                  // (or the linked provider's name) plus a chevron, so the
                  // control reads as clickable rather than as a bare glyph.
                  showLabel
                />
              )}
            />
          </div>
        ) : (
          !isApplied && (
            <div className="float-left mr-3 flex h-5 shrink-0 items-center">
              <Circle className="h-4 w-4 text-muted-foreground" />
            </div>
          )
        )}
        {isEditable && (
          // Floated right and written ABOVE the title on purpose — a float only
          // displaces content that comes after it in source order.
          //
          // `h-5` pins the float to ONE 20px line box even though the buttons
          // inside are 28px: a float displaces every line it overlaps, so at its
          // natural height it stole the indent from the second line too — the
          // exact "line 2 doesn't reach the edge, line 3 does" this layout is
          // meant to fix.
          //
          // The 28px buttons then have to overflow that 20px box, and they must
          // do it SYMMETRICALLY (-4px each way) or they read as sitting low
          // against the text. `items-center` on a fixed-height box does exactly
          // that, which `items-start` did not — it hung all 8px below the line.
          <div className="float-right ml-3 flex h-5 shrink-0 items-center gap-1">
            {/* Dismiss (owner only) — for applied items this also deletes the entity */}
            {!readOnly && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:border-destructive/50"
                onClick={handleDismiss}
                disabled={dismissing || undoing}
                title="Dismiss"
                data-testid="proposal-dismiss"
              >
                {dismissing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            )}

            {/* Context popover — safe to show in read-only mode */}
            {hasContext && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title="View context"
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-[340px] p-0 shadow-lg"
                >
                  <div className="space-y-3 p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-semibold text-muted-foreground">Details</p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        title="Ask AI about this"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent('ni:chat-about-proposal', {
                              detail: {
                                captureId: change.capture_id,
                                proposalId: change.id,
                                displayText: change.display_text,
                                description: change.description || null,
                                reasoning: change.reasoning || null,
                                triggerQuote: change.trigger_quote || null,
                                changeType: change.change_type,
                                entityType: change.entity_type,
                              },
                            }),
                          )
                        }}
                      >
                        <MessageCircle className="h-3 w-3" />
                        Ask AI
                      </Button>
                    </div>
                    {change.description && (
                      <div>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Context
                        </p>
                        <p className="text-sm leading-relaxed text-foreground">
                          <Linkify text={change.description} />
                        </p>
                      </div>
                    )}
                    {change.trigger_quote && (
                      <div className="rounded-lg bg-muted/60 px-3.5 py-2.5">
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {change.trigger_quote}
                        </p>
                      </div>
                    )}
                    {change.reasoning && (
                      <div>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Reasoning
                        </p>
                        <p className="text-sm leading-relaxed text-foreground">
                          {change.reasoning}
                        </p>
                      </div>
                    )}
                    {change.stakes && (
                      <p className="text-sm leading-relaxed text-foreground">
                        {change.stakes}
                      </p>
                    )}
                    {change.open_questions && change.open_questions.length > 0 && (
                      <div>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Open questions
                        </p>
                        <ul className="space-y-1">
                          {change.open_questions.map((q, i) => (
                            <li key={i} className="text-sm text-muted-foreground">
                              &bull; {q}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* Properties toggle + link-out + action button (owner only) */}
            {!readOnly && (
              <>
                {/* The strip IS the property row while compose is up, so this
                    toggle has nothing coherent to do: showing the native pills
                    would put two property rows on the card, and hiding them
                    would take the line the form is standing on. */}
                {!composing && (
                <Button
                  size="sm"
                  variant={showProperties ? 'secondary' : 'outline'}
                  className="h-7 w-7 p-0"
                  onClick={() => setShowProperties((v) => !v)}
                  title={showProperties ? 'Hide properties' : 'Edit properties'}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
                )}

                {/* The push menu used to sit HERE, trailing. It moved to the
                    far-left slot above — one affordance per row, and the left
                    one carries information (which platforms this action is
                    already in) that a trailing button never did. Every other
                    trailing control is unchanged, in the same order. */}

                {/* Start the assigned agent's coding run (applied action assigned
                    to an agent). Reflects working / PR-opened / failed. */}
                {showAgentStart && (
                  agentRunStatus === 'working' ? (
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 text-xs font-medium text-primary">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Working
                    </span>
                  ) : agentRunStatus === 'pr_open' ? (
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <GitPullRequest className="h-3 w-3" />
                      PR opened
                    </span>
                  ) : (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                            onClick={handleStartAgent}
                            disabled={startingAgent}
                            aria-label={`Launch ${currentAgent?.name || 'agent'} to work on this task`}
                          >
                            {startingAgent ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="end" className="max-w-[240px] text-xs leading-relaxed">
                          {agentRunStatus === 'failed'
                            ? `Retry — launch ${currentAgent?.name || 'the agent'} to work on this task`
                            : `Launch ${currentAgent?.name || 'the agent'} to start working on this task`}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )
                )}

                {/* Open the created entity (applied items only) — sits just left of
                    the Accepted button. We forward a synthetic event with metaKey
                    set so the shared open handler (goForItem) prefers a new tab.
                    While the multi-tab UI is disabled (TABS_ENABLED=false),
                    goForItem falls back to opening in-place. */}
                {openable && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      onOpenEntity?.(
                        openable.entityType,
                        openable.entityId,
                        change.title || change.display_text,
                        { metaKey: true } as React.MouseEvent,
                      )
                    }
                    title="Open in new tab"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Button>
                )}

                {/* THE COMMIT BUTTON, suppressed for the duration of compose.
                    Every branch below ends in an act on the PROPOSAL (accept,
                    undo, apply, draft, pick a target) and the strip's Create is
                    an act on the same row — two commits side by side, one of
                    which silently discards the form. */}
                {composing ? null : isApplied ? (
                  canUndo ? (
                    // Green "accepted" pill that becomes "Undo" on hover. The two
                    // labels are stacked in the same box (the accepted label sets
                    // the width; Undo is absolutely centered over it) so swapping
                    // on hover never resizes the button — no left-edge jump.
                    // Hover is tracked in JS for a reliable label swap.
                    <button
                      type="button"
                      onClick={handleUndo}
                      data-testid="proposal-undo"
                      onMouseEnter={() => setAcceptHovered(true)}
                      onMouseLeave={() => setAcceptHovered(false)}
                      disabled={undoing || dismissing}
                      title="Click to undo"
                      className={cn(
                        'relative inline-flex h-7 items-center justify-center rounded-md border px-2.5 text-xs font-medium transition-colors',
                        acceptHovered && !undoing
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                        (undoing || dismissing) && 'opacity-50',
                      )}
                    >
                      {undoing ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Undoing
                        </span>
                      ) : (
                        <>
                          {/* Base layer — defines the button width, hidden on hover */}
                          <span className={cn('inline-flex items-center gap-1.5', acceptHovered && 'opacity-0')}>
                            {change.auto_accepted ? (
                              <Sparkles className="h-3 w-3" />
                            ) : (
                              <Check className="h-3 w-3" />
                            )}
                            {change.auto_accepted ? 'Auto-accepted' : 'Accepted'}
                          </span>
                          {/* Hover layer — centered over the base, no layout impact */}
                          <span className={cn('absolute inset-0 flex items-center justify-center gap-1.5', acceptHovered ? 'opacity-100' : 'opacity-0')}>
                            <RotateCcw className="h-3 w-3" />
                            Undo
                          </span>
                        </>
                      )}
                    </button>
                  ) : (
                    // update/assign applies can't be reversed — show a static badge.
                    <span
                      title="Accepted. This change modified existing data, so it can't be undone here."
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                    >
                      {change.auto_accepted ? (
                        <Sparkles className="h-3 w-3" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      {change.auto_accepted ? 'Auto-accepted' : 'Accepted'}
                    </span>
                  )
                ) : isEmail ? (
                  // Email proposals open the chat panel where the AI drafts the
                  // email, rather than silently creating a blank draft row.
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    onClick={handleDraftEmail}
                    disabled={dismissing}
                    data-testid="proposal-accept"
                  >
                    <Mail className="h-3 w-3" />
                    {buttonLabel}
                  </Button>
                ) : needsTarget ? (
                  // W-4c: a target-less action update — "Choose target" opens the
                  // shared action picker (never a disabled dead end); picking one
                  // persists entity_id on the proposal and applies.
                  <ActionTargetPicker
                    open={targetPickerOpen}
                    onOpenChange={setTargetPickerOpen}
                    onPick={(a) => void handlePickTarget(a)}
                    align="end"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      disabled={applying || dismissing}
                      title="Pick which action this update targets"
                      data-testid="proposal-accept"
                    >
                      {applying ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Target className="h-3 w-3" />
                      )}
                      {buttonLabel}
                    </Button>
                  </ActionTargetPicker>
                ) : notSupported ? (
                  // Drift guard: no apply-engine handler for this combo. Disabled
                  // (never a dead-end Accept), labelled with the unsupported type.
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs opacity-50 cursor-not-allowed"
                    disabled
                    title={`Native Intelligence can't apply a ${change.change_type} on a ${change.entity_type} yet — dismiss it or handle it manually.`}
                    data-testid="proposal-accept"
                  >
                    {buttonLabel}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn('h-7 text-xs', hasMissingFields && 'opacity-50 cursor-not-allowed')}
                    onClick={hasMissingFields ? () => setShowProperties(true) : handleApply}
                    disabled={applying || dismissing || hasMissingFields}
                    data-testid="proposal-accept"
                    title={hasMissingFields ? 'Set required fields first' : undefined}
                  >
                    {applying ? (
                      <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    ) : null}
                    {buttonLabel}
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {/* THE TITLE IS THE TITLE, composing or not: same size, WRAPPING rather
            than truncated. It used to shrink to a one-line `text-xs` caption
            while the strip took the row; now the strip is on its own line below
            and this block never has to give anything up. That also makes the
            strip's title FIELD redundant — it was showing the same string a
            second time, editably — which is why compose no longer offers one.

            No `flex-1` any more: this is the float container's normal-flow
            content, so it is already full width and simply wraps AROUND the two
            floated side elements. `min-h-5` is the one-line floor that keeps a
            short title on the same line box as the two side elements; the
            buttons are taller and overflow it evenly, so matching their 28px
            here would only pad the row. */}
        <div
          data-proposal-title=""
          className={cn(
            'min-h-5 text-sm',
            isApplied && 'text-muted-foreground',
          )}
        >
          <SmartText change={change} />
          {!composing && pendingReason && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* `ml-1.5 align-middle` rather than `mt-1`: this is an
                      inline-flex chip, so a top margin dropped it onto its own
                      line unconditionally — even when the sentence had room
                      beside it. It now trails the text and wraps only when the
                      line genuinely cannot hold it. Note the space it competes
                      for ends at the trailing float's MARGIN box, not its
                      border box, so the usable gap is 12px tighter than it
                      looks. */}
                  <span className="ml-1.5 inline-flex w-fit cursor-default items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 align-middle text-[10px] font-medium text-muted-foreground">
                    <Sparkles className="h-2.5 w-2.5 opacity-70" />
                    {pendingReason.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-[260px] text-xs leading-relaxed">
                  {pendingReason.detail}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* THE TRAILING CLUSTER STAYS, minus the gestures that would conflict.
            The card keeps its shape while composing — that is the whole point
            of this row surviving compose — so the read-only affordances
            (Dismiss, the context popover, Open in new tab) are untouched.

            What stands down is the COMMIT half: Accept/Undo and the properties
            toggle. Accept beside a half-filled Jira form is two conflicting
            gestures on one row (accepting mid-compose is exactly the
            double-confirm `applyingRef` exists to prevent), and the properties
            toggle would swap the strip out from under the form that is standing
            on that line. Create/X in the strip are the committing actions until
            compose ends. */}
      </div>

      {/* THE PROPERTY LINE, and the one thing compose actually swaps.

          The strip is portalled into this host (see `composeHost`), which sits
          exactly where the native pills would be and indents to the same
          column — so entering compose exchanges one row of properties for
          another IN PLACE, leaving the card's top row untouched above it.

          Rendered whenever `composing`, independent of `showProperties`: the
          strip is not the native pill set and must not require the pills to
          have been toggled on. The ref callback is what tells the menu its host
          exists — `renderCompose` draws nothing until this element mounts, so
          the very first compose render is a no-op and the state update here
          brings the form in on the next one. */}
      {composing && (
        <div className="flex gap-3 pb-2.5" data-compose-property-row="">
          {/* The same indent the pills use, so the strip starts on the property
              column rather than under the icon. */}
          {!isApplied && <div className="w-4 shrink-0" />}
          <div className="flex min-w-0 flex-1" ref={setComposeHost} />
        </div>
      )}

      {/* Property pills — toggled via sliders button (owner only). For applied
          items these reach through onEdit to the entity the proposal created. */}
      {/* Native Intelligence's own property pills, DOWN while the push form is up: the two
          sets mean different things (what this action IS, versus where this push
          is going) and showing both would let a user edit the proposal's due
          date and the Jira due date in the same breath. */}
      {isEditable && !readOnly && showProperties && !composing && (
        <div className="flex gap-3 pb-2.5">
          {/* Align pills under the text: pending rows have a status-icon column to
              clear; accepted rows don't (the icon was removed). */}
          {!isApplied && <div className="w-4 shrink-0" />}

          {/* THE LENS SWITCHER, ahead of the properties it switches.
              Drawn only when this action is linked somewhere — an unpushed row's
              property line is byte-identical to what it was before the lens
              existed. `shrink-0` keeps it off the scroller: the tabs are how you
              get back to Native Intelligence and must never scroll out of reach. */}
          {showLensSwitcher && (
            <PropertyLensSwitcher
              providers={['dial8', ...lensProviders]}
              active={lens}
              onChange={setActiveLens}
              className="mt-0.5 self-start"
            />
          )}

          {/* THE PROVIDER LENS, taking the property line in place of the pills.
              Not alongside them: the two sets mean different things (what this
              action IS, versus what the linked ticket is) and showing both would
              let a user edit the Native Intelligence due date and the Jira due date in the same
              breath — the same reason compose takes this line rather than sharing
              it. `strip` layout, and the lens brings the compose scroller's own
              classes: the capture panel is ~608px and a chip row of six fields
              has to scroll rather than wrap. */}
          {lensProvider && lensActionId ? (
            <TaskLens
              actionId={lensActionId}
              provider={lensProvider}
              layout="strip"
              onOpenSettings={onOpenSettings}
            />
          ) : (
          <div className="flex flex-wrap gap-1.5">
            {/* Project */}
            {projects && projects.length > 0 && (
              <PropertyPill
                icon={<Folder className={cn('h-3 w-3', missingFields.has('project') ? 'text-destructive' : 'text-muted-foreground')} />}
                label={currentProject?.name || (isProjectUpdate ? 'Select project' : 'Project')}
                muted={!currentProject}
                error={missingFields.has('project')}
              >
                {(close) => (
                  <Command>
                    <CommandInput placeholder={isProjectUpdate ? 'Select project to update...' : 'Set project...'} />
                    <CommandList>
                      <CommandEmpty>No projects found</CommandEmpty>
                      <CommandGroup>
                        {!isProjectUpdate && (
                          <CommandItem
                            value="none"
                            onSelect={() => {
                              onEdit(change.id, { project_id: null })
                              close()
                            }}
                          >
                            <Folder className="mr-2 h-3 w-3 text-muted-foreground" />
                            No project
                          </CommandItem>
                        )}
                        {projects.map((p) => (
                          <CommandItem
                            key={p.id}
                            value={p.name}
                            onSelect={() => {
                              if (isProjectUpdate) {
                                onEdit(change.id, { entity_id: p.id })
                              } else {
                                onEdit(change.id, { project_id: p.id })
                              }
                              close()
                            }}
                          >
                            <Folder className="mr-2 h-3 w-3" />
                            {p.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                )}
              </PropertyPill>
            )}

            {/* Assignee */}
            {((members && members.length > 0) || (aiMembers && aiMembers.length > 0) || (contacts && contacts.length > 0)) && (
              <PropertyPill
                // The person and the delegate agent show together (decision 9):
                // the person leads, the agent follows ("Ada · Writer").
                icon={
                  currentAssignee?.avatar_url ? (
                    <img src={currentAssignee.avatar_url} alt="" className="h-3.5 w-3.5 rounded-full" />
                  ) : !currentAssignee && currentAgent ? (
                    currentAgent.avatar_url ? (
                      <img src={currentAgent.avatar_url} alt="" className="h-3.5 w-3.5 rounded-full" />
                    ) : (
                      <Boxes className="h-3 w-3 text-primary" />
                    )
                  ) : (
                    <User className={cn('h-3 w-3', missingFields.has('assignee') ? 'text-destructive' : 'text-muted-foreground')} />
                  )
                }
                label={
                  [currentAssignee?.display_name || currentAssigneeContact?.full_name || change.assignee_name, currentAgent?.name]
                    .filter(Boolean)
                    .join(' · ') || 'Assignee'
                }
                muted={!currentAgent && !currentAssignee && !currentAssigneeContact && !change.assignee_name}
                error={missingFields.has('assignee')}
              >
                {(close) => (
                  <Command>
                    <CommandInput placeholder="Assign to..." />
                    <CommandList>
                      <CommandEmpty>No people found</CommandEmpty>
                      <CommandGroup heading="Actions">
                        <CommandItem
                          value="unassigned"
                          onSelect={() => {
                            onEdit(change.id, { assignee_member_id: null, assignee_contact_id: null, assignee_name: null, assignee_ai_member_id: null })
                            close()
                          }}
                        >
                          <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                          Unassigned
                        </CommandItem>
                      </CommandGroup>
                      {aiMembers && aiMembers.length > 0 && (
                        <CommandGroup heading="Agents">
                          {aiMembers.map((a) => (
                            <CommandItem
                              key={a.id}
                              value={`agent-${a.name}`}
                              onSelect={() => {
                                // The agent is the delegate beside the person
                                // (decision 9, as the apply engine writes it):
                                // picking it keeps the member. An external
                                // contact can't sit beside an agent, so a
                                // contact assignee gives way.
                                onEdit(change.id, {
                                  assignee_ai_member_id: a.id,
                                  ...(change.assignee_contact_id ? { assignee_contact_id: null, assignee_name: null } : {}),
                                })
                                close()
                              }}
                            >
                              {a.avatar_url ? (
                                <img src={a.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                              ) : (
                                <Boxes className="mr-2 h-3.5 w-3.5 text-primary" />
                              )}
                              <span className="truncate">{a.name}</span>
                              <Boxes className="ml-auto h-3 w-3 text-primary" />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                      {members && members.length > 0 && (
                        <CommandGroup heading="Members">
                          {members.map((m) => (
                            <CommandItem
                              key={m.id}
                              value={`member-${m.display_name}`}
                              onSelect={() => {
                                // Picking a person keeps the delegate agent.
                                onEdit(change.id, { assignee_member_id: m.id, assignee_contact_id: null, assignee_name: m.display_name })
                                close()
                              }}
                            >
                              {m.avatar_url ? (
                                <img src={m.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                              ) : (
                                <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                              )}
                              {m.display_name}
                              {currentMemberId === m.id && (
                                <span className="ml-1 text-xs text-muted-foreground">(Me)</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                      {contacts && contacts.length > 0 && (
                        <CommandGroup heading="Contacts">
                          {contacts.map((c) => (
                            <CommandItem
                              key={c.id}
                              value={`contact-${c.full_name}-${c.email || ''}`}
                              onSelect={() => {
                                onEdit(change.id, { assignee_member_id: null, assignee_contact_id: c.id, assignee_name: c.full_name, assignee_ai_member_id: null })
                                close()
                              }}
                            >
                              <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                              <span className="truncate">{c.full_name}</span>
                              {c.email && (
                                <span className="ml-1 truncate text-[10px] text-muted-foreground">{c.email}</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                )}
              </PropertyPill>
            )}

            {/* Priority */}
            {(change.entity_type === 'action' || change.entity_type === 'project') && (
              <PropertyPill
                icon={<Flag className={cn('h-3 w-3', currentPriority.color)} />}
                label={change.priority && change.priority !== 'none' ? currentPriority.label : 'Priority'}
                muted={!change.priority || change.priority === 'none'}
              >
                {(close) => (
                  <Command>
                    <CommandList>
                      <CommandGroup>
                        {PRIORITY_OPTIONS.map((opt) => (
                          <CommandItem
                            key={opt.value}
                            value={opt.label}
                            onSelect={() => {
                              onEdit(change.id, { priority: opt.value })
                              close()
                            }}
                          >
                            <Flag className={cn('mr-2 h-3 w-3', opt.color)} />
                            {opt.label}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                )}
              </PropertyPill>
            )}

            {/* Status (for updates) */}
            {change.change_type === 'update' && (
              <PropertyPill
                icon={<Circle className="h-3 w-3 text-muted-foreground" />}
                label={change.status_to || 'Status'}
                muted={!change.status_to}
              >
                {(close) => {
                  const statuses = change.entity_type === 'project'
                    ? PROJECT_STATUSES
                    : change.entity_type === 'milestone'
                      ? MILESTONE_STATUSES
                      : []
                  return (
                    <Command>
                      <CommandList>
                        <CommandGroup>
                          <CommandItem
                            value="no-change"
                            onSelect={() => {
                              onEdit(change.id, { status_to: null })
                              close()
                            }}
                          >
                            <Circle className="mr-2 h-3 w-3 text-muted-foreground" />
                            No status change
                          </CommandItem>
                          {statuses.map((s) => (
                            <CommandItem
                              key={s.value}
                              value={s.label}
                              onSelect={() => {
                                onEdit(change.id, { status_to: s.value })
                                close()
                              }}
                            >
                              <Circle className="mr-2 h-3 w-3" />
                              {s.label}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  )
                }}
              </PropertyPill>
            )}

            {/* Due date */}
            <div className="flex items-center gap-1">
              <DateTimePicker
                // parseISO: `YYYY-MM-DD` as the LOCAL day (new Date() reads
                // it as UTC midnight, the day before west of UTC).
                value={change.due_date ? parseISO(change.due_date) : undefined}
                onChange={(date) => {
                  if (date) {
                    const y = date.getFullYear()
                    const m = String(date.getMonth() + 1).padStart(2, '0')
                    const d = String(date.getDate()).padStart(2, '0')
                    onEdit(change.id, { due_date: `${y}-${m}-${d}` })
                  } else {
                    onEdit(change.id, { due_date: null })
                  }
                }}
                granularity="day"
                displayFormat={{ hour24: 'MMM d, yyyy', hour12: 'MMM d, yyyy' }}
                placeholder="Due date"
                className={cn(
                  'h-7 rounded-full border border-border px-2.5 text-xs shadow-sm hover:bg-muted',
                  !change.due_date && 'text-muted-foreground',
                )}
              />
              {change.due_date && (
                <button
                  className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => onEdit(change.id, { due_date: null })}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          )}

        </div>
      )}

      {/* Error message */}
      {change.error_message && (
        <div className="border-t border-destructive/20 bg-destructive/5 py-2">
          <p className="text-xs text-destructive">{change.error_message}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Memoized: a proposals refetch that changed nothing about THIS row must not
 * re-render it (the capture panel's realtime channel refetches the full list
 * on every proposed_change event). Only effective because the panel reconciles
 * fetched rows by id, preserving object identity for unchanged changes — and
 * keeps its callbacks/lookup arrays stable across those refetches.
 */
export const ProposalCard = memo(ProposalCardImpl)
