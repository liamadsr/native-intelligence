'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { parseISO } from 'date-fns'
import {
  Boxes,
  Building2,
  Calendar,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Copy,
  Flag,
  Folder,
  Loader2,
  Mail,
  MessageCircle,
  Pencil,
  Play,
  Send,
  Target,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { CardControlBar } from './card-control-bar'
import { COLUMN_CARD_SKIN } from './card-skin'
import { ApprovalInputs } from './approval-inputs'
import { useAttentionCardVerbs } from './use-attention-card-verbs'
import type { DeckPager } from './rail-cards'
import type { OpenTarget } from '@/lib/chat-cards/open-card'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { WorkResources } from '@/app/account/(dashboard)/views/agent-run-ui'
import type { WorkResourceRef } from '@/lib/agent-run/types'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'
import {
  PropertyPill as SharedPropertyPill,
  type PropertyPillProps,
} from '@/components/views/properties'
import type {
  AttentionItem,
  AttentionPayload,
  AcceptCorrections,
  AcceptResult,
} from '@/hooks/use-attention-items'
import type {
  RailAiMember,
  RailMember,
  RailProject,
} from '@/hooks/use-rail-picker-data'
import { isTargetlessUpdate, isUnsupportedChange } from '@/lib/proposed-changes/derive-ui'
import { cardEffectLine as effectLine, cardPrimaryLabel as primaryLabel } from '@/lib/attention/card-copy'
import { ActionTargetPicker } from '@/components/capture/action-target-picker'
import { relativeTime } from '@/lib/work/presentation'
import { Linkify } from '@/components/ui/linkify'
import { POST_SURFACE_NAME, postDraftFromPayload } from '@/lib/content/post-draft'
import type { WorkRunPlace } from '@/lib/attention/work-place'
import { WorkPlacePicker, runInOf, useWorkPlace } from './work-place-picker'

/**
 * A single attention-rail card (loop-closure Phase 2, Workstream D).
 *
 * The landing card's glass skin (action-stream-demo.tsx) wearing ProposalCard's
 * interaction model (proposal-card.tsx). It carries the full property model —
 * project, priority, due date, human OR agent assignee — editable inline before
 * accepting, and the "assign to an agent and send it off" flow: pick an agent,
 * hit accept, and the created action's coding run starts.
 *
 * accept/dismiss are driven by the parent (useAttentionItems); this component
 * only owns local edit + button state.
 *
 * CROSS-WORKSPACE: the rail is a personal queue spanning every workspace the
 * user belongs to, and the accept endpoint fences on the CARD's workspace, not
 * the active one. So a foreign card is fully actionable here — it just wears a
 * workspace badge so the user knows where the change is landing, and every
 * card it opens carries the card's workspace (openTarget's `workspaceId`,
 * which switches first), never resolving the card's ids against the ACTIVE
 * workspace's data. `editable` is narrower than it
 * sounds: it means "this card's workspace has loaded its picker lists", and so
 * gates only the property pills.
 *
 * HOSTS (bots-v4.md Phase 3): a bot's bubble, a bot's page and the desktop
 * overlay. Each says which it is (`surface`, carried on every
 * `attention_card_*` event). A bot's host gives the card its chat (`onRefine`:
 * "Refine in chat" talks to that bot, never the main chat) and its column
 * (`narrow`: 320 px or so, where the pills wrap and the card grows to fit).
 * A Start's receipt points at the page of the teammate the run is for ("Watch
 * it on Writer's page").
 */

/**
 * Where a card is shown, for analytics (`surface` on the attention_card_* events).
 * 'column' is the chat's For you column (always-on-agent.md decision 13), which
 * also gives the card its column skin (COLUMN_CARD_SKIN): the pages' glass, as
 * tall as its content, pills wrapping. 'chat' is a card inline in a
 * conversation (P13: an approval or a question, chat-ask-card.tsx): the same
 * skin, and an approval's Decline or Skip beside Approve, not in a menu.
 */
export type CardSurface = 'bubble' | 'bot_page' | 'overlay' | 'column' | 'chat'

/**
 * A card's skin in the chat's For you column: the pages' glass, with a
 * hairline lift, light and dark. One surface with the side panel's cards
 * (card-skin.ts).
 */
export { COLUMN_CARD_SKIN } from './card-skin'

/** The For you column's impressions sent this session, by card id (it mounts many cards, and remounts them). */
const columnImpressions = new Set<string>()

/**
 * A card's `attention_card_impression`. On the deck surfaces, once per mount
 * (they mount only the card on show). In the For you column, which mounts a
 * page of cards at once, once per card per session, and only once the card is
 * actually in view (half of it, IntersectionObserver; rootMargin in px only,
 * a WebKit rule). Without an IntersectionObserver, once per card per session.
 */
export function useCardImpression(
  ref: RefObject<HTMLElement | null>,
  id: string,
  surface: CardSurface | undefined,
  send: () => void,
): void {
  useEffect(() => {
    if (surface !== 'column') {
      send()
      return
    }
    if (columnImpressions.has(id)) return
    const fire = () => {
      if (columnImpressions.has(id)) return
      columnImpressions.add(id)
      send()
    }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      fire()
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        observer.disconnect()
        fire()
      },
      { rootMargin: '0px', threshold: 0.5 },
    )
    observer.observe(el)
    return () => observer.disconnect()
    // Per card and surface; `send` is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, surface])
}

/** Tests only: forget the column's impressions. */
export function __resetColumnImpressionsForTests(): void {
  columnImpressions.clear()
}

interface AttentionCardProps {
  item: AttentionItem
  /** The card's workspace has loaded its projects/members/agents, so the
   *  property pills can offer real options. NOT a cross-workspace gate — see the
   *  component doc. */
  editable: boolean
  members: RailMember[]
  aiMembers: RailAiMember[]
  projects: RailProject[]
  onEdit: (id: string, patch: Partial<AttentionPayload>) => void
  onAccept: (
    id: string,
    corrections?: AcceptCorrections,
    targetEntityId?: string | null,
  ) => Promise<AcceptResult>
  /** Start a work_proposal card — dispatches a work run, or runs it in the place picked on the card. */
  onStart: (id: string, runIn?: WorkRunPlace | null) => Promise<AcceptResult>
  onDismiss: (id: string) => Promise<void>
  /** Deck browse state, rendered in this card's bottom control bar. */
  pager?: DeckPager
  /** Where it's shown, on every attention_card_* event. */
  surface?: CardSurface
  /**
   * "Refine in chat" (an email card): the host's own chat with its bot (the
   * bubble's, the bot's page's). Absent: the main chat, as the rail always
   * did. Either way the card is dismissed after, so the chat owns the draft.
   */
  onRefine?: (item: AttentionItem) => void
  /** A narrow column (a bot's bubble or page, ~320 px): the pills wrap and the card grows to fit them. */
  narrow?: boolean
}

/**
 * This card's binding of the shared pill. The `attention` variant reproduces the
 * DOM this file used to build inline (h-6, softer border/text, flex-truncating
 * label, and a bare button with no Popover when `disabled`) — see
 * components/views/properties/property-pill.tsx.
 */
function PropertyPill(props: Omit<PropertyPillProps, 'variant'>) {
  return <SharedPropertyPill {...props} variant="attention" />
}

/** Resource types that open as a record card. 'package' opens the Knowledge card on it. */
const RESOURCE_RECORDS = new Set(['action', 'capture', 'document', 'contact', 'project', 'initiative'])

export function AttentionCard({
  item,
  editable,
  members,
  aiMembers,
  projects,
  onEdit,
  onAccept,
  onStart,
  onDismiss,
  pager,
  surface,
  onRefine,
  narrow = false,
}: AttentionCardProps) {
  const [expanded, setExpanded] = useState(false)
  const { workspaces, currentId } = useWorkspaces()
  const p = item.payload || {}
  // Accept, Start, Dismiss and Refine, with their receipts and
  // events: shared with the For you column's compact card.
  const {
    accepting,
    dismissing,
    targetPickerOpen,
    setTargetPickerOpen,
    capture,
    openInCardWorkspace,
    handleAccept,
    handleStart,
    handleDismiss,
    handleRefineInChat,
    handleCopy,
    handlePublish,
    handleAlwaysAllow,
    alwaysAllowing,
  } = useAttentionCardVerbs({ item, aiMembers, onAccept, onStart, onDismiss, onRefine, surface })

  // The badge shown on a card from ANOTHER workspace, so the user can see where
  // an accept is about to land. Only once the workspace cache has an active id
  // (before that every card would read as foreign and the badge would flash),
  // and only when we can actually name the workspace — an unnamed badge tells
  // the user nothing the card doesn't already say.
  const foreignWorkspaceName =
    currentId && item.workspace_id !== currentId
      ? workspaces.find((w) => w.id === item.workspace_id)?.name ?? null
      : null

  const isEmail = item.kind === 'draft_email'
  const isQuestion = item.kind === 'question'
  const isWork = item.kind === 'work_proposal'
  // Where its Start runs: Native Intelligence, a folder on the person's Mac, or a cloud environment (work-place-picker.tsx).
  const place = useWorkPlace({ workspaceId: item.workspace_id, windowWorkspaceId: currentId ?? null, enabled: isWork })
  // W-4b: a target-less action update — can't apply in one click; the primary
  // action opens a picker so the user chooses which action to update (W-4c).
  // Works on ANY card: the picker is told which workspace to search, so a
  // foreign card resolves its target in its own workspace. (It used to be gated
  // on `editable`, which made a foreign needs-target card a dead end — the plain
  // button posted, the server 409'd UPDATE_TARGET_UNRESOLVED, and the rescue
  // picker it asked for wasn't mounted.)
  const needsTarget = isTargetlessUpdate(p)
  // Drift guard: a change-backed proposal whose combo has no apply-engine handler
  // can only dead-end on accept — render it disabled with a type-named label
  // instead of a one-click Accept. Scoped to change-backed cards: work_proposal /
  // question / draft_email carry no change_type:entity_type combo and are handled
  // by their own accept paths, so the combo check doesn't apply to them.
  // An approval (A5) holds a tool call, not a proposal: it has its own accept path.
  const isApproval = item.kind === 'approval'
  // A loop step's held call (F4): Edit before it runs, Skip ends the loop's run.
  const editableApproval = isApproval && p.editable === true
  // A connected app's call its own permission held (not the reviewer): Claude's
  // Always allow beside Approve, unless the tool always asks (approvals.ts).
  const offerAlwaysAllow = isApproval && p.always_allow === true && !editableApproval
  const [editingInput, setEditingInput] = useState(false)
  // C2a (P9 review B2): Post now through Typefully asks once more, showing the whole post and the account.
  const [confirmNow, setConfirmNow] = useState(false)
  // What runs is what the card shows: the person's edit once they made one.
  const shownInput = editableApproval && p.edited_input && typeof p.edited_input === 'object' ? p.edited_input : (p as { input?: unknown }).input
  // A post draft (F3 post_drafts): its text shows in full when expanded, Copy beside Post.
  const post = isQuestion ? postDraftFromPayload(p) : null
  const notSupported = !isWork && !isQuestion && !isEmail && !isApproval && isUnsupportedChange(p)
  // A draft_email whose shell already exists (a prior generation failed and
  // stamped its draft_id) — accepting again retries into the SAME shell (WS-2a).
  const isRetry = isEmail && !!p.draft_id

  // WS-1f: one impression per card mount. The deck mounts only the top card, so
  // this fires once for each card the user actually sees (the column: once in view).
  const rootRef = useRef<HTMLDivElement>(null)
  useCardImpression(rootRef, item.id, surface, () => capture('attention_card_impression'))

  // Current property values (payload snapshot, patched locally on edit).
  const currentPriority =
    PRIORITY_OPTIONS.find((o) => o.value === (p.priority || 'none')) ?? PRIORITY_OPTIONS[0]
  const currentProject = projects.find((pr) => pr.id === p.project_id)
  const currentAgent = p.assignee_ai_member_id
    ? aiMembers.find((a) => a.id === p.assignee_ai_member_id)
    : null
  const currentMember = !currentAgent
    ? members.find((m) => m.id === p.assignee_member_id)
    : null

  const toggleDetails = () => {
    setExpanded((v) => {
      if (!v) capture('attention_card_expanded')
      return !v
    })
  }

  // A "Will use" resource chip. The resource belongs to the CARD's workspace,
  // so it opens as a card there (switched to first), never against whatever
  // workspace is active. A package opens the Knowledge card on it; a record
  // its record card. Best-effort: the card renders the pre-Start (unvalidated)
  // payload, so an id here may be one Start would drop; a dead id just opens
  // an empty record.
  const openResource = (r: WorkResourceRef) => {
    if (!r.id) return
    if (r.type === 'package') {
      openInCardWorkspace({ type: 'package', id: r.id, title: r.label })
      return
    }
    if (!RESOURCE_RECORDS.has(r.type)) return
    openInCardWorkspace({ type: r.type, id: r.id, title: r.label } as OpenTarget)
  }

  const busy = accepting || dismissing
  // The chat's For you column, or a card inline in a conversation: the solid skin, content height, wrapping pills.
  const column = surface === 'column' || surface === 'chat'
  // Inline in a chat (P13): an approval says no beside its yes, in plain sight.
  const inlineNo = surface === 'chat' && isApproval
  // Its age, on the column only: there its bot's header names it once, so each card keeps its own when.
  const age = column ? relativeTime(item.created_at) : ''

  // The card is a plain surface — the deck (AttentionDeck) owns ALL enter/exit
  // motion via its own AnimatePresence. Animating here too would double up and
  // make the transition feel muddy.
  return (
    // Fixed height so every card is an identical box in the deck — content
    // flows from the top, the action row + footer pin to the bottom (mt-auto),
    // so the controls sit in the same place on every card regardless of how
    // many pills / lines of text it has.
    <div
      ref={rootRef}
      className={cn(
        // Collapsed: a fixed box so every card is identical in the deck and the
        // action row pins to the bottom (mt-auto). Expanded: h-auto so details
        // grow the card IN PLACE — height isn't animated, so the deck's motion
        // stays stable, the card just resizes. (WS-1a)
        // Padding moved off the card root and onto the content block, so the
        // bottom control bar can run edge-to-edge with its own divider.
        // `ph-no-capture`: a draft card shows the email's recipient, subject
        // and brief; session replay blocks it (Native Intelligence never stores mail text).
        'ph-no-capture flex w-full min-w-0 flex-col rounded-xl border border-border/60',
        // In a bot's column it sits inside the bot's own glass (the bubble's
        // card, the page's section): no blur or lift of its own, and it grows
        // to fit its wrapped pills (never shorter than a deck card).
        column ? COLUMN_CARD_SKIN : narrow ? 'bg-background/60 dark:bg-white/[0.04]' : 'bg-background/70 hud-surface-shadow backdrop-blur-md',
        expanded || column ? 'h-auto' : narrow ? 'h-auto min-h-[196px]' : 'h-[196px]',
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3.5 pb-1 pt-3">
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground/90">
              {item.title}
            </p>
            {item.why && (
              <p className={cn('mt-0.5 text-xs leading-snug text-muted-foreground', !isApproval && 'line-clamp-2')}>
                {item.why}
              </p>
            )}
          </div>
          {/* Quiet details affordance (WS-1a) — expands the card in place. */}
          <button
            type="button"
            onClick={toggleDetails}
            aria-label={expanded ? 'Hide details' : 'Show details'}
            aria-expanded={expanded}
            className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Detail expansion (WS-1a): the full effect + description + confidence +
            provenance footer the card otherwise under-discloses. */}
        {expanded && (
          <div className="mt-2 space-y-1.5 border-t border-border/40 pt-2">
            <p className="text-xs font-medium text-foreground/80">{effectLine(item, p)}</p>
            {post && confirmNow && (
              <div data-post-confirm="" className="space-y-2 rounded-lg border border-border/70 bg-muted/40 p-2.5">
                <p className="text-xs font-medium text-foreground">
                  Post this as {post.typefully_account ?? 'your Typefully account'} on {POST_SURFACE_NAME[post.surface]} now?
                </p>
                <p className="whitespace-pre-wrap text-xs leading-snug text-foreground/90">{post.text}</p>
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setConfirmNow(false)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={() => void handlePublish('now').then(() => setConfirmNow(false))} disabled={busy}>
                    <Send className="h-3 w-3" />
                    Post now
                  </Button>
                </div>
              </div>
            )}
            {post && !confirmNow && (
              <p data-post-draft-text="" className="whitespace-pre-wrap text-xs leading-snug text-foreground/80">
                {post.text}
                <span className="mt-1 block text-[11px] text-muted-foreground/70">
                  {post.limit ? `${post.chars}/${post.limit}` : post.chars} characters
                </span>
              </p>
            )}
            {/* Work proposal: the full task text (the effect line only shows its
                first ~80 chars) + a "Will use" row of the declared resources. */}
            {isWork && p.task && (
              <p className="whitespace-pre-wrap text-xs leading-snug text-muted-foreground">
                <Linkify text={p.task} />
              </p>
            )}

            {isWork && (p.resources?.length ?? 0) > 0 && (
              <div className="pt-0.5">
                <WorkResources resources={p.resources} onOpen={openResource} label="Will use" />
              </div>
            )}
            {p.description && (
              <p className="whitespace-pre-wrap text-xs leading-snug text-muted-foreground">
                <Linkify text={p.description} />
              </p>
            )}
            {typeof p.confidence === 'number' && (
              <p className="text-[11px] text-muted-foreground/60">
                Confidence {Math.round(p.confidence * 100)}%
              </p>
            )}
            {(p.skill_name || p.capture_title) && (
              <p className="text-[11px] text-muted-foreground/60">
                from {p.skill_name || 'a skill'}
                {p.capture_title && (
                  <>
                    {' · '}
                    {p.capture_id ? (
                      <button
                        type="button"
                        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                        onClick={() =>
                          openInCardWorkspace({ type: 'capture', id: p.capture_id as string, title: p.capture_title as string })
                        }
                      >
                        {p.capture_title}
                      </button>
                    ) : (
                      p.capture_title
                    )}
                  </>
                )}
              </p>
            )}
          </div>
        )}

          {/* Bottom block — property pills + actions row pinned together to the
              bottom of the fixed-height card (mt-auto). Grouping them means the
              pills AND the buttons sit at the SAME position on every card,
              regardless of how much title / why text is above. */}
          <div className="mt-auto pt-2">
          {/* Cross-workspace badge — the card's own workspace, named, whenever it
              isn't the active one. It sits with the provenance block at the foot
              of the card (visible collapsed as well as expanded, because the card
              is fully actionable collapsed) and wears the same chip shape as the
              property pills. Same-workspace cards render nothing: the badge is
              the exception marker, not a permanent field. */}
          {foreignWorkspaceName && (
            <div className="mb-1.5 flex min-w-0">
              <span
                className="flex h-5 min-w-0 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] font-medium text-muted-foreground"
                title={`In ${foreignWorkspaceName}`}
              >
                <Building2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{foreignWorkspaceName}</span>
              </span>
            </div>
          )}
          {/* Approval (A5): every input the held call will run with, always
              shown (never behind the expand): what the person sees is what runs. */}
          {isApproval && (
            <ApprovalInputs
              input={shownInput}
              {...(editableApproval && editingInput ? { onChange: (next: Record<string, unknown>) => onEdit(item.id, { edited_input: next }) } : {})}
            />
          )}
          {/* Property pills — only for action cards. Work cards are NOT
              board-row proposals (they run an agent), so no project/priority/
              assignee/due editing applies. Single row, no wrapping: pills stay
              on one line and shrink (their labels truncate) rather than dropping
              to a second row. */}
          {!isEmail && !isQuestion && !isWork && !isApproval && (
            <div
              data-attention-card-pills=""
              className={cn('mb-2 flex min-w-0 items-center gap-1.5', narrow || column ? 'flex-wrap' : 'flex-nowrap overflow-hidden')}
            >
              {/* Project */}
              <PropertyPill
                icon={<Folder className="h-3 w-3 text-muted-foreground/70" />}
                label={currentProject?.name || 'Project'}
                muted={!currentProject}
                disabled={!editable || projects.length === 0}
              >
                {(close) => (
                  <Command>
                    <CommandInput placeholder="Set project…" />
                    <CommandList>
                      <CommandEmpty>No projects</CommandEmpty>
                      <CommandGroup>
                        <CommandItem
                          value="none"
                          onSelect={() => {
                            onEdit(item.id, { project_id: null })
                            close()
                          }}
                        >
                          <Folder className="mr-2 h-3 w-3 text-muted-foreground" />
                          No project
                        </CommandItem>
                        {projects.map((pr) => (
                          <CommandItem
                            key={pr.id}
                            value={pr.name}
                            onSelect={() => {
                              onEdit(item.id, { project_id: pr.id })
                              close()
                            }}
                          >
                            <Folder className="mr-2 h-3 w-3" />
                            {pr.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                )}
              </PropertyPill>

              {/* Assignee (human or agent) */}
              <PropertyPill
                icon={
                  currentAgent ? (
                    currentAgent.avatar_url ? (
                      <img src={currentAgent.avatar_url} alt="" className="h-3.5 w-3.5 rounded-full" />
                    ) : (
                      <Boxes className="h-3 w-3 text-primary" />
                    )
                  ) : currentMember?.avatar_url ? (
                    <img src={currentMember.avatar_url} alt="" className="h-3.5 w-3.5 rounded-full" />
                  ) : (
                    <User className="h-3 w-3 text-muted-foreground/70" />
                  )
                }
                label={currentAgent?.name || currentMember?.display_name || 'Assignee'}
                muted={!currentAgent && !currentMember}
                disabled={!editable || (members.length === 0 && aiMembers.length === 0)}
                shrinkable
              >
                {(close) => (
                  <Command>
                    <CommandInput placeholder="Assign to…" />
                    <CommandList>
                      <CommandEmpty>No people found</CommandEmpty>
                      <CommandGroup heading="Actions">
                        <CommandItem
                          value="unassigned"
                          onSelect={() => {
                            onEdit(item.id, { assignee_member_id: null, assignee_ai_member_id: null })
                            close()
                          }}
                        >
                          <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                          Unassigned
                        </CommandItem>
                      </CommandGroup>
                      {aiMembers.length > 0 && (
                        <CommandGroup heading="Agents">
                          {aiMembers.map((a) => (
                            <CommandItem
                              key={a.id}
                              value={`agent-${a.name}`}
                              onSelect={() => {
                                onEdit(item.id, {
                                  assignee_ai_member_id: a.id,
                                  assignee_member_id: null,
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
                      {members.length > 0 && (
                        <CommandGroup heading="Members">
                          {members.map((m) => (
                            <CommandItem
                              key={m.id}
                              value={`member-${m.display_name}`}
                              onSelect={() => {
                                onEdit(item.id, {
                                  assignee_member_id: m.id,
                                  assignee_ai_member_id: null,
                                })
                                close()
                              }}
                            >
                              {m.avatar_url ? (
                                <img src={m.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                              ) : (
                                <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                              )}
                              {m.display_name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                )}
              </PropertyPill>

              {/* Priority */}
              <PropertyPill
                icon={<Flag className={cn('h-3 w-3', currentPriority.color)} />}
                label={p.priority && p.priority !== 'none' ? currentPriority.label : 'Priority'}
                muted={!p.priority || p.priority === 'none'}
                disabled={!editable}
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
                              onEdit(item.id, { priority: opt.value })
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

              {/* Due date */}
              {editable ? (
                <div className="flex shrink-0 items-center gap-1">
                  <DateTimePicker
                    value={p.due_date ? parseISO(p.due_date) : undefined}
                    onChange={(date) => {
                      if (date) {
                        const y = date.getFullYear()
                        const m = String(date.getMonth() + 1).padStart(2, '0')
                        const d = String(date.getDate()).padStart(2, '0')
                        onEdit(item.id, { due_date: `${y}-${m}-${d}` })
                      } else {
                        onEdit(item.id, { due_date: null })
                      }
                    }}
                    granularity="day"
                    displayFormat={{ hour24: 'MMM d', hour12: 'MMM d' }}
                    placeholder="Due"
                    className={cn(
                      // Override the picker's outline-Button background/shadow so
                      // it matches the other transparent pills (Project/Assignee/…).
                      'h-6 w-auto shrink-0 rounded-full border border-border/60 bg-transparent px-2 text-[11px] font-medium shadow-none hover:bg-muted dark:bg-transparent',
                      !p.due_date && 'text-muted-foreground',
                    )}
                  />
                  {p.due_date && (
                    <button
                      className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/50 hover:bg-muted hover:text-foreground"
                      onClick={() => onEdit(item.id, { due_date: null })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ) : (
                p.due_date && (
                  <span className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 text-[11px] font-medium text-foreground/70">
                    <Calendar className="h-3 w-3 text-muted-foreground/70" />
                    {formatDue(p.due_date)}
                  </span>
                )
              )}
            </div>
          )}

          </div>
        </div>

        {/* Bottom control bar — pager left, split-button CTA right; dismiss now
            lives in the caret menu rather than as a bare bin icon. */}
        <CardControlBar
          pager={pager}
          busy={busy}
          leading={isWork ? <WorkPlacePicker state={place} workspaceId={item.workspace_id} disabled={busy} /> : undefined}
          meta={age ? <span data-attention-card-age="" title={new Date(item.created_at).toLocaleString()}>{age}</span> : undefined}
          extra={
            editableApproval || inlineNo || offerAlwaysAllow ? (
              <>
                {inlineNo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-approval-no=""
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={handleDismiss}
                    disabled={busy}
                    title={editableApproval ? 'Skip this step: the run ends here, nothing runs' : 'Decline: nothing runs'}
                  >
                    {dismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                    {editableApproval ? 'Skip' : 'Decline'}
                  </Button>
                )}
                {offerAlwaysAllow && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-approval-always=""
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => void handleAlwaysAllow()}
                    disabled={busy}
                    title="Run it now, and let this tool run without asking from now on (change it in Settings › Connectors)"
                  >
                    {alwaysAllowing ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3 w-3" />}
                    Always allow
                  </Button>
                )}
                {editableApproval && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => setEditingInput((v) => !v)}
                    disabled={busy}
                    aria-pressed={editingInput}
                    title={editingInput ? 'Done editing' : 'Edit the inputs before it runs'}
                  >
                    {editingInput ? <Check className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                    {editingInput ? 'Done' : 'Edit'}
                  </Button>
                )}
              </>
            ) : post ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => void handleCopy()}
                  disabled={busy}
                  title="Copy the post"
                >
                  <Copy className="h-3 w-3" />
                  Copy
                </Button>
                {/* C2a: with Typefully connected, and only on the opened card (the whole post shows):
                    Post now asks once more with the full text and the account; Queue can be undone in Typefully. */}
                {post.typefully && expanded && !confirmNow && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmNow(true)}
                      disabled={busy}
                      title="Post it now through your Typefully"
                    >
                      <Send className="h-3 w-3" />
                      Post now
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => void handlePublish('next_free_slot')}
                      disabled={busy}
                      title="Add it to your Typefully queue (next free slot)"
                    >
                      <CalendarClock className="h-3 w-3" />
                      Queue
                    </Button>
                  </>
                )}
              </>
            ) : isEmail ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={handleRefineInChat}
                disabled={busy}
                title="Refine in chat"
              >
                <MessageCircle className="h-3 w-3" />
                Refine
              </Button>
            ) : undefined
          }
          menu={
            inlineNo ? undefined : <DropdownMenuItem
              onSelect={handleDismiss}
              disabled={busy}
              // `text-destructive` is a BACKGROUND token: in dark mode it resolves to a
              // dark red (0 62.8% 30.6%) that sits at ~1.5:1 on the dark popover —
              // effectively invisible. Use the codebase's red-text pair instead.
              className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
            >
              {dismissing ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              {editableApproval ? 'Skip' : 'Dismiss'}
            </DropdownMenuItem>
          }
          primary={
            <>
              {needsTarget ? (
                // W-4c: a target-less update — the primary action opens the shared
                // action picker; choosing one retries the accept with that target.
                // Mounted for every card, foreign included, and told which
                // workspace to search so the target comes from the card's own.
                <ActionTargetPicker
                  open={targetPickerOpen}
                  onOpenChange={setTargetPickerOpen}
                  onPick={(a) => void handleAccept(a.id)}
                  workspaceId={item.workspace_id}
                  align="end"
                >
                  <Button
                    size="sm"
                    className="h-6 gap-1 px-2.5 text-[11px]"
                    disabled={busy}
                  >
                    {accepting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Target className="h-3 w-3" />
                    )}
                    {primaryLabel(item, p)}
                  </Button>
                </ActionTargetPicker>
              ) : (
                <Button
                  size="sm"
                  className={cn('h-6 gap-1 px-2.5 text-[11px]', notSupported && 'opacity-50 cursor-not-allowed')}
                  onClick={isWork ? () => void handleStart(runInOf(place.choice)) : () => handleAccept()}
                  disabled={busy || notSupported}
                  title={
                    notSupported
                      ? `Native Intelligence can't apply a ${p.change_type} on a ${p.entity_type} yet — dismiss it or handle it manually.`
                      : undefined
                  }
                >
                  {accepting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : isEmail ? (
                    <Mail className="h-3 w-3" />
                  ) : isWork || p.assignee_ai_member_id ? (
                    <Play className="h-3 w-3" />
                  ) : needsTarget ? (
                    <Target className="h-3 w-3" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {isEmail ? (isRetry ? 'Retry draft' : 'Draft email') : primaryLabel(item, p)}
                </Button>
              )}
            </>
          }
        />
    </div>
  )
}

function formatDue(iso: string): string {
  try {
    // parseISO: a date-only `YYYY-MM-DD` is the LOCAL day (new Date() reads it
    // as UTC midnight, the day before west of UTC).
    return parseISO(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}
