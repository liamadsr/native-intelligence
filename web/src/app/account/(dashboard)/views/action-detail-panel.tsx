'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ThinkingOrb } from 'thinking-orbs'
import { copyDeferredTextToClipboard } from '@/lib/clipboard'
import { createPortal } from 'react-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { celebrateFromElement } from '@/components/celebration/celebrate'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { LabelPickerContent, flattenGroups } from '@/components/labels/label-picker-content'
import { EntityTitleInput } from '@/components/views/entity-title-input'
import { usePropertiesVisible } from '@/components/views/use-properties-visible'
import { WindowProperties, WindowActions } from '@/components/views/window-properties'
import { SubActionComposer, type SubActionDraft } from '@/components/views/sub-action-composer'
import { PropertyGroup } from '@/components/views/property-group'
import {
  StatusPanelField,
  PriorityPanelField,
  ProjectPanelField,
  DatePanelField,
  type WorkflowStateOption,
  type ProjectOption as PickerProjectOption,
} from '@/components/views/properties'
import { toast } from 'sonner'
import { ReminderPickerPopover } from '@/components/reminders/reminder-picker'
import { DocumentSearchPicker, type DocumentOption } from '@/components/documents/document-search-picker'
import { fetchReminder, onReminderChanged } from '@/lib/reminders/client'
import type { Reminder } from '@/lib/reminders/types'
import { useHotkeys } from '@/lib/hotkeys'
import { useIsWindowFocused } from '@/components/views/unified-view-layout'
import { useRowChanges } from '@/hooks/use-row-changes'
import { ActionJobPlan } from '@/components/work/action-job-plan'
import { NoteEditor } from './note-editor-lazy'
// Lazy: CloudRunView renders only when the user opens the 'cloud' tab, and it
// reaches the `ai` SDK through run-chat.tsx (`isToolUIPart`). A static import
// put that SDK on the dashboard's first-load path via this panel, for a tab
// most sessions never open.
// Lazy for the same reason: the Agents tab (plan row 10) mounts its own
// channels and the attention hook only when opened.
const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)
const CloudRunView = dynamic(() => import('./cloud-run-view').then((m) => m.CloudRunView), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center">
      <ThinkingOrb state="breathing" size={20} theme="auto" />
    </div>
  ),
})
import { canShowCloudRunTab, cloudRunTabMarker } from './cloud-run-gate'
import { isAgentRunLive } from '@/lib/agent-run/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Calendar as CalendarIcon,
  PanelLeftClose,
  X,
  Plus,
  Link as LinkIcon,
  Trash2,
  Circle,
  AlertCircle,
  Tag,
  User,
  GitBranch,
  Layers,
  Gauge,
  Milestone,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  ExternalLink,
  Check,
  XCircle,
  Loader2,
  Sparkles,
  Boxes,
  Play,
  Copy,
  ChevronDown,
  Cloud,
  FileText,
  Paperclip,
  MessageCircleQuestion,
  AlarmClock,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useSettingsOverlay } from '../settings-overlay'
import { SiGithub } from '@icons-pack/react-simple-icons'
import { cn } from '@/lib/utils'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { RecordHistory } from '@/components/entity-links/record-history'
import { useCurrentMemberId, useWorkspaceId } from '@/app/account/workspace-switcher'
import {
  readActionCache,
  hasActionCache,
  writeActionCache,
  deleteActionCache,
  getInflightActionDetail,
  type ActionDetail,
  type ActionLabel,
} from '@/lib/action-cache'
import { cachedJson } from '@/lib/cached-fetch'
import { AttachmentsCarousel } from '@/components/capture/attachments-carousel'
import { dropZoneOf, filesFromTransfer } from '@/lib/attachments/dropped-files'
import { useElementFileDrop } from '@/lib/attachments/use-element-file-drop'
import { uploadAttachment, AttachmentUploadError } from '@/lib/attachments/upload-client'
import { ATTACHMENT_ACCEPT_ATTR, isAllowedAttachmentFile } from '@/lib/attachments/constants'
import { ContentTransition } from './transitions'
import { Comments } from '../components/comments'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { ListenBrief } from '@/components/read-aloud/listen-brief'
import { plainLine } from '@/lib/read-aloud/listen-briefs'
import { MoveToWorkspaceButton } from '@/components/move/move-to-workspace-button'
import {
  PushToTrackerMenu,
  type ExternalTaskLink,
} from '@/components/tasks/push-to-tracker-menu'
import {
  defaultLens,
  PropertyLensSwitcher,
  TaskLens,
  useActionLinkProviders,
} from '@/components/tasks/task-lens'
import { isLensProvider } from '@/lib/tasks/task-lens'
import {
  ACTION_COMPOSE_REQUESTED,
  consumeActionComposeRequest,
  type ActionComposeRequest,
} from '@/lib/tasks/compose-request-events'
import { emitEntityUpdated, emitEntityDeleted, onEntityUpdated, onEntityDeleted } from '@/lib/entity-events'

interface WorkflowState {
  id: string
  name: string
  category: string
  color: string
  sort_order: number
  /** Served by /api/account/workflow-states; used to skip a redundant
   *  status PATCH when a new sub-action already lands on the default. */
  is_default?: boolean
}

interface ActionRelation {
  id: string
  type: string
  action_id: string
  identifier: string
  title: string
  status_name: string
  status_color: string
}

interface LinkedPr {
  id: string
  pr_url: string
  repo_full_name: string
  pr_number: number
  pr_title: string | null
  pr_state: string
  pr_draft: boolean
  head_branch: string | null
  linked_at: string
}

interface LinkedDocument {
  link_id: string
  id: string
  title: string
  updated_at: string
  created_by_name: string | null
}

interface SubAction {
  id: string
  identifier: string
  title: string
  status_id: string
  status_name: string
  status_category: string
  status_color: string
  assignee_name: string | null
  assignee_avatar: string | null
  priority: string
}

interface TeamMember {
  id: string
  display_name: string
  avatar_url: string | null
}

interface AiMemberOption {
  id: string
  name: string
  avatar_url: string | null
}

interface ProjectOption {
  id: string
  name: string
}

interface MilestoneOption {
  id: string
  name: string
  status: string
}

interface CycleOption {
  id: string
  name: string
  number: number
  status: string
}

// The detail cache lives in @/lib/action-cache so list rows can seed it from
// row data (instant open) and prefetch the full record on hover.
export type { ActionDetail } from '@/lib/action-cache'

// The detail route embeds the external-task link rows (see ACTION_FIELDS in
// actions/[id]/route.ts); ActionDetail itself doesn't carry them because list
// rows seed the cache without them — hence the optional widening here.
type ActionDetailWithLinks = ActionDetail & { external_links?: ExternalTaskLink[] }

/**
 * Link rows read from the shared action cache are trusted only when every row
 * is a FULL `action_external_task` row (identified by a string `id`).
 *
 * The cache can hold thinner shapes: the entity-bus republish used to write
 * provider-only stubs (`{ provider }`) through this panel's own
 * onEntityUpdated listener, and any other emitter may still announce a thin
 * projection. A stub reaching the menu in CONTROLLED mode is taken as the
 * truth while missing everything a link needs — "Open in …" renders disabled
 * (no `external_url`) and Unlink aims its DELETE at `/{provider}/undefined`.
 * One untrusted row poisons the WHOLE array (a mixed set is not a state the
 * server can produce), so the seed falls back to `undefined` — the honest
 * "nobody has looked yet" hedge — and the mount fetch resolves the truth.
 */
export function trustedCachedLinks(
  links: ExternalTaskLink[] | undefined,
): ExternalTaskLink[] | undefined {
  if (!links) return undefined
  return links.every((l) => typeof l?.id === 'string') ? links : undefined
}

/** The panel's inner views: the action, its Cloud run, and the agents that worked on it (row 10). */
type PanelView = 'details' | 'cloud' | 'agents'
const panelViewOf = (section: string | undefined): PanelView =>
  section === 'cloud' ? 'cloud' : section === 'agents' ? 'agents' : 'details'

export function ActionDetailPanel({
  actionId,
  section,
  onSectionChange,
  onClose,
  onUpdate,
  onSelectAction,
  onOpenEntity,
}: {
  actionId: string
  /** Deep-link the panel's inner view. `'cloud'` opens the Cloud-run surface —
   *  the canonical view for a Loops v3 work run (Activity / notifications route
   *  here). Undefined = default to Details. */
  section?: 'cloud' | 'agents'
  /** When provided, the Details/Cloud switch becomes a real navigation: the
   *  host owns `section`, so each toggle is its own history step and Back walks
   *  Cloud → Details → whatever the user was on before. Mount sites that don't
   *  wire this keep the old local-state behaviour. */
  onSectionChange?: (section: 'cloud' | 'agents' | undefined) => void
  onClose: () => void
  onUpdate?: (fields: Record<string, unknown>) => void
  onSelectAction?: (id: string, title: string, event?: React.MouseEvent) => void
  /** Opens another entity in the host's navigation (project, initiative, …).
   *  Mount sites that don't wire this simply don't get the open affordance. */
  onOpenEntity?: (entityType: string, id: string, title: string, event?: React.MouseEvent) => void
}) {
  const cached = readActionCache(actionId)
  const [action, setAction] = useState<ActionDetail | null>(cached ?? null)
  const actionIdRef = useRef(actionId)
  actionIdRef.current = actionId
  const [loading, setLoading] = useState(!cached)
  const workspaceId = useWorkspaceId()
  const [saving, setSaving] = useState(false)
  const panelBodyRef = useRef<HTMLDivElement>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const currentMemberId = useCurrentMemberId()

  // ── Remind me (⇧H) ──
  // The pending reminder is read here rather than left to the picker so the
  // Remove row is already correct the instant the popover opens — a picker that
  // learns about the existing reminder one render late would flash a list
  // without it. Kept in sync with the header pill (and any other surface) through
  // the reminder-changed event, since neither owns the other.
  const [reminderOpen, setReminderOpen] = useState(false)
  const [reminder, setReminder] = useState<Reminder | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetchReminder('action', actionId)
        .then((r) => {
          if (!cancelled) setReminder(r)
        })
        // A failed read only costs the Remove row — never a toast in a toolbar
        // the user hasn't touched.
        .catch(() => {})
    }
    setReminder(null)
    load()
    const off = onReminderChanged((detail) => {
      if (detail && (detail.entityType !== 'action' || detail.entityId !== actionId)) return
      load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [actionId])
  // Every tab and every window stays MOUNTED, and a tab can show several
  // windows at once — so without this gate one Shift+H would open the reminder
  // picker in every panel at once. Only the focused window's panel answers.
  // Outside a window (bare detail panel) it reads true, so nothing changes.
  const isWindowFocused = useIsWindowFocused()
  useHotkeys([
    { key: 'h', shift: true, handler: () => setReminderOpen(true), disabled: !isWindowFocused },
  ])

  /**
   * INLINE COMPOSE, in the properties sidebar rather than a pop-up.
   *
   * The push menu lives in the TOOLBAR and the form belongs in the SIDEBAR —
   * two different subtrees, so the menu's node is PORTALLED into a host the
   * sidebar renders. A portal rather than lifting the node into state because
   * `renderCompose` is called during the menu's render, and a `setState` there
   * is a render-phase update of a different component: React either warns or
   * loops. The portal moves the DOM without moving the ownership, so the form
   * stays a child of the menu that built it (its `onCreate` closure, its
   * cancel) while appearing where the properties are.
   *
   * `stack` layout: this sidebar is already a narrow vertical column, so there is
   * nothing to scroll sideways and the fields simply stack, one per row, like
   * every other property above them.
   */
  const [composeHost, setComposeHost] = useState<HTMLElement | null>(null)
  const [composeProviderName, setComposeProviderName] = useState<string | null>(null)

  /**
   * A board card asked for compose it had no room to show.
   *
   * The card's own menu picked the provider; this panel is where the form fits.
   * Held as state and handed to the menu as `autoComposeProvider`, which arms
   * compose once and then leaves the user in control (see the menu's
   * `armedFor`). Cleared as soon as it is consumed so a later cancel is final.
   *
   * Declared here, above usePropertiesVisible, because it's one of the two
   * signals that lock the sidebar visible.
   */
  const [autoComposeProvider, setAutoComposeProvider] = useState<string | null>(null)

  /** Keep the page inspector open while a provider compose form is armed or
   * being edited. Standalone panels also keep their inline fields visible. */
  const propertiesOpen = usePropertiesVisible(
    panelBodyRef,
    !!composeProviderName || !!autoComposeProvider,
  )

  /**
   * THE PROPERTY LENS — which system's properties is the sidebar showing?
   *
   * `'dial8'` (the groups that were always here) or a provider this action is
   * linked to, in which case the Properties group's CONTENTS are replaced by the
   * linked ticket's live fields. Only the Properties group: Labels, Project,
   * Links, Documents, GitHub and Attachments are Dial8's own relationships and
   * mean the same thing whatever lens is up, so they stay exactly where they are.
   *
   * The switcher is drawn only when a link exists, so an action that was never
   * pushed gets a sidebar identical to the one it had before this feature — no
   * control, and no request either (the hook is gated on the same condition).
   *
   * WHY `propertiesOpen` GATES THE LOOKUP: a collapsed sidebar shows no
   * properties at all, so there is nothing for a lens to be the lens OF. Opening
   * it is what asks.
   */
  /**
   * THIS PANEL OWNS THE LINK ROWS, and it must — there are now TWO readers of
   * them (the toolbar menu's button tint, and the lens switcher) and the panel is
   * the only place above both.
   *
   * Before the lens, the menu fetched them itself and the panel kept no
   * external-task state at all. Adding a second independent fetcher would have
   * made every panel open ask twice — the exact duplicate
   * `action-detail-panel-push-menu.test.tsx` forbids, written when the panel had
   * a redundant effect of its own beside the menu's. So ownership moves up one
   * level instead: the panel resolves the rows once, drives the menu in
   * CONTROLLED mode, and hands the same rows to the lens hook, which then
   * fetches nothing.
   *
   * WHERE THE ROWS COME FROM: the action detail response. The panel used to run
   * three unconditional per-provider probe requests (asana/jira/linear) on every
   * open — three lambda invocations per next/back step over one table the detail
   * select already reads — so the route now embeds `external_links` and the
   * mount fetch below is the single resolver.
   *
   * `onPushed`/`onUnlinked` are what keep that ownership honest — a push or an
   * unlink happens inside the menu, and a controlled caller that ignored them
   * would show a stale switcher (a tab for a provider just unlinked, or no tab
   * for one just pushed to).
   */
  /**
   * REPLACE ON RESOLVE — the refresh never clears first.
   *
   * The panel passes these rows to the menu in CONTROLLED mode, where they are
   * taken as the truth (`linksKnown` short-circuits). Emptying them before a
   * refresh would make the toolbar draw the upload arrow and name itself "Push
   * to…" for the width of the fetch — an affirmative "this action is in no
   * tracker" about an action that may be sitting in Jira. That is precisely the
   * claim `known=false` was added to prevent (see the regression note in
   * `action-platform-icon.tsx`); a controlled caller has no `known=false` to
   * reach for, so the fix is to never hold an array we do not believe. Old rows
   * stand until new rows land — seeded here from the detail cache when a full
   * (non-list-seeded) entry carries them AND every cached row survives the
   * `trustedCachedLinks` gate above, refreshed by the mount fetch.
   *
   * `undefined` is the one state that is not an array: nobody has looked yet. The
   * readers below turn it into `[]` (there is nothing else they could draw) but
   * they do it EXPLICITLY, at the two call sites, so neither one silently claims
   * knowledge this state exists to deny — and the menu gets `linksKnown={false}`
   * alongside it, so the `[]` we hand it is not mistaken for an answer. That
   * covers both halves: the refresh of an already-resolved action (old rows stand)
   * and the never-yet-resolved first load (the trigger hedges).
   */
  const [externalLinks, setExternalLinks] = useState<ExternalTaskLink[] | undefined>(
    trustedCachedLinks((cached as ActionDetailWithLinks | undefined)?.external_links),
  )

  /**
   * A DIFFERENT ACTION means the rows we hold are somebody else's.
   *
   * Keeping the previous array is right for a refresh of the SAME action and
   * wrong across a swap — B would wear A's links for as long as the fetch takes.
   * Reset during render rather than in an effect: an effect runs after paint, and
   * that paint is the frame that would show A's Jira tab on B. B's own cached
   * rows (if a full detail entry exists) stand in immediately; otherwise
   * `undefined` — nobody has looked yet — until the mount fetch resolves.
   *
   * (Today the panel remounts on navigation — `key={dp.id}` in tab-content — so
   * this is the belt to that braces. It costs one ref and stops the whole class
   * of bug if that key ever goes away.)
   */
  const linksActionRef = useRef<string | null>(actionId)
  if (linksActionRef.current !== actionId) {
    linksActionRef.current = actionId
    const cachedLinks = trustedCachedLinks(
      (readActionCache(actionId) as ActionDetailWithLinks | undefined)?.external_links,
    )
    if (externalLinks !== cachedLinks) setExternalLinks(cachedLinks)
  }

  const [activeLens, setActiveLens] = useState<string | null>(null)
  const { providers: lensProviders } = useActionLinkProviders(actionId, {
    // `?? []` KEEPS THE HOOK OUT OF THE FETCHING PATH. Passing `undefined` is how
    // a caller says "I have no rows, go ask" — and this panel has rows, or will
    // in a moment, from the one fetch above. Letting the hook ask too is the
    // duplicate the push-menu suite's "exactly once" test forbids. An empty list
    // for the pre-resolve window is the right answer here anyway: no providers
    // means no switcher, and drawing no switcher for an action we have not
    // resolved yet is exactly what we want (the alternative is a switcher that
    // pops in, and a lens that mounts against links we have not read).
    enabled: propertiesOpen,
    links: externalLinks ?? [],
  })
  /**
   * THE STICKY LENS IS CONSTRAINED TO LENSES THAT STILL EXIST.
   *
   * `activeLens` deliberately survives re-renders (a user who switched back to
   * Dial8 must not be flipped to Jira when the links resolve), but "survives" is
   * not "is trusted": the links it names can go away underneath it. The live path
   * is an in-place unlink from the toolbar menu — `onUnlinked` empties
   * `externalLinks`, `lensProviders` goes to `[]`, and the switcher unmounts
   * because `showLensSwitcher` reads the same list. An unvalidated `activeLens`
   * would still say `'jira'`, so the Properties group would be replaced by a
   * permanent `link_not_found` banner whose Retry can never succeed, with no
   * switcher left to escape through.
   *
   * So a lens naming a provider this action is no longer linked to falls back to
   * the default — which, with no links at all, is Dial8: the sidebar the action
   * had before it was ever pushed.
   */
  const lens =
    activeLens && (activeLens === 'dial8' || lensProviders.includes(activeLens))
      ? activeLens
      : defaultLens(lensProviders)
  const showLensSwitcher = lensProviders.length > 0
  // Compose WINS. While a push form is up, the sidebar is committed to a
  // create-in-progress; swapping the group under it to a different provider's
  // live fields would put two provider forms in one column and invite an edit to
  // the wrong one. The switcher and the lens both stand down until the push is
  // finished or cancelled.
  const lensProvider =
    !composeProviderName && lens !== 'dial8' && isLensProvider(lens) ? lens : null

  useEffect(() => {
    const arm = (provider: string) => {
      // The form is in the sidebar, and arming is what asks for it — so this
      // also LOCKS the sidebar visible (see usePropertiesVisible below), since
      // a narrow panel would otherwise swallow the very thing the click wanted.
      setAutoComposeProvider(provider)
    }

    // THE LATCH, drained first. The board card's click MOUNTS this panel, so
    // its event was dispatched before this listener existed — the live event
    // below can only ever serve a panel that was already open. Without this
    // drain the board path is a dead click. Id-matched and TTL-guarded inside
    // `consume`, and consuming clears it so a cancel is final.
    const latched = consumeActionComposeRequest(actionId)
    if (latched) arm(latched.provider)

    const onRequested = (event: Event) => {
      const detail = (event as CustomEvent<ActionComposeRequest>).detail
      // Only OUR action: every mounted panel hears the same window event, and a
      // stale one arming compose for a different action would be a form over the
      // wrong issue.
      if (!detail || detail.actionId !== actionId) return
      arm(detail.provider)
    }
    window.addEventListener(ACTION_COMPOSE_REQUESTED, onRequested)
    return () => window.removeEventListener(ACTION_COMPOSE_REQUESTED, onRequested)
  }, [actionId])

  const [newLinkUrl, setNewLinkUrl] = useState('')
  const [linksExpanded, setLinksExpanded] = useState(false)
  const [workflowStates, setWorkflowStates] = useState<WorkflowState[]>([])
  const { labels: scopedLabels, grouped: scopedLabelsGrouped } = useScopedLabels('action')
  const allLabels = useMemo(() => scopedLabels as unknown as ActionLabel[], [scopedLabels])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [aiMembers, setAiMembers] = useState<AiMemberOption[]>([])
  const [subActions, setSubActions] = useState<SubAction[]>([])
  const [relations, setRelations] = useState<ActionRelation[]>([])
  const [linkedPrs, setLinkedPrs] = useState<LinkedPr[]>([])
  const [linkedDocs, setLinkedDocs] = useState<LinkedDocument[]>([])
  const [allDocuments, setAllDocuments] = useState<DocumentOption[]>([])
  const [docSearchOpen, setDocSearchOpen] = useState(false)
  const [docsExpanded, setDocsExpanded] = useState(false)
  const [newPrUrl, setNewPrUrl] = useState('')
  const [prsExpanded, setPrsExpanded] = useState(false)
  const [linkingPr, setLinkingPr] = useState(false)
  const [prError, setPrError] = useState('')
  const [startingAgent, setStartingAgent] = useState(false)
  // Detail panel view switcher. 'cloud' shows the run surface (coding logs or a
  // Loops v3 work run) and is only offered when this action can have a
  // server-side run.
  //
  // With `onSectionChange` wired the host owns this: `section` IS the state, so
  // switching tabs pushes a history entry and Back/Forward walk the switch like
  // any other screen change. Without it (mount sites that don't route through
  // tab history) the local state below is the fallback, seeded from the
  // `section` deep-link so section:'cloud' (Activity row / work-run
  // notification) still lands on the run.
  const controlledSection = !!onSectionChange
  const [localPanelView, setLocalPanelView] = useState<PanelView>(panelViewOf(section))
  const panelView: PanelView = controlledSection ? panelViewOf(section) : localPanelView
  const setPanelView = useCallback(
    (next: PanelView) => {
      if (onSectionChange) onSectionChange(next === 'details' ? undefined : next)
      else setLocalPanelView(next)
    },
    [onSectionChange],
  )
  // True once we've observed at least one workspace-kind (Loops v3) run for this
  // action. A work-run action ALWAYS has such a run (the Start route inserts it),
  // so this is the durable signal that this action's Cloud tab must stay
  // reachable — including after the run completes, when agent_run_status is no
  // longer live and there's no AI assignee. Resolved from the action-scoped
  // agent-runs fetch below.
  const [hasWorkRun, setHasWorkRun] = useState(false)
  // A work-run action (Loops v3) can park in `needs_input` — the executing agent
  // asked the user a question mid-run. Unlike coding runs this action carries no
  // assignee_ai_member_id, so we resolve its live run id here to deep-link the
  // "Waiting on you" chip straight to the run's question picker.
  const [workRunId, setWorkRunId] = useState<string | null>(null)
  const [projectRepo, setProjectRepo] = useState<{ github_repo: string | null } | null>(null)
  const settingsOverlay = useSettingsOverlay()
  const [showSubActionForm, setShowSubActionForm] = useState(false)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectMilestones, setProjectMilestones] = useState<MilestoneOption[]>([])
  const [teamCycles, setTeamCycles] = useState<CycleOption[]>([])
  const descriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const titleTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingDescriptionRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Anchors the completion confetti to the status field (not screen center).
  const statusFieldRef = useRef<HTMLDivElement>(null)
  // Suppress the next entity-updated echo for this action — patchAction emits
  // an event that we also listen to, and re-applying our own delta is wasteful
  // and would lose server-computed fields (like updated_at) on partial deltas.
  const suppressEchoRef = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [attachmentRefreshKey, setAttachmentRefreshKey] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Fetch the action with abort-on-unmount/id-change. Without cancellation, a
  // slow response for the previous actionId can land after the user has already
  // navigated to a new action and overwrite the new state.
  // A cached entry (full or seeded from the list row on click) renders
  // immediately; the fetch then reconciles in the background. If a hover
  // prefetch is already in flight for this id, await it instead of firing a
  // duplicate request.
  useEffect(() => {
    const controller = new AbortController()
    const hasCached = hasActionCache(actionId)
    if (!hasCached) {
      setLoading(true)
      setAction(null)
    } else {
      // Re-seed local state — the cache may be fresher than the initial
      // useState snapshot when navigating between actions in one panel.
      const entry = readActionCache(actionId)
      if (entry) setAction(entry)
    }

    const inflight = getInflightActionDetail(actionId)
    const load = inflight
      ? inflight.then((detail) => {
          if (controller.signal.aborted || !detail) return
          setAction(detail)
          // The detail response embeds the external-task link rows — this is
          // the panel's single link resolver (see `externalLinks` above).
          setExternalLinks((detail as ActionDetailWithLinks).external_links ?? [])
        })
      : fetch(`/api/account/actions/${actionId}`, { signal: controller.signal })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (!data) return
            setAction(data.action)
            setExternalLinks((data.action as ActionDetailWithLinks).external_links ?? [])
            writeActionCache(actionId, data.action)
          })
    load
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [actionId])

  // Reset the LOCAL fallback whenever we navigate to a different action (or the
  // deep-link `section` changes for the same action), so the Cloud-run view
  // doesn't "stick" across actions. A `section:'cloud'` deep-link lands on the
  // run; everything else defaults to Details. When the host controls `section`
  // this is unnecessary — the derived value already tracks the prop — and it's
  // skipped so we never write local state the render doesn't read.
  useEffect(() => {
    if (controlledSection) return
    setLocalPanelView(panelViewOf(section))
  }, [actionId, section, controlledSection])

  // Stay in sync when other surfaces (inline row edit, bulk action, AI tool)
  // update this action — patch our local copy and the cache, no refetch.
  // Skip echoes from our own patchAction (handled directly via setAction).
  useEffect(() => {
    return onEntityUpdated((d) => {
      if (d.entityType !== 'action' || d.id !== actionId) return
      if (suppressEchoRef.current) {
        suppressEchoRef.current = false
        return
      }
      setAction((prev) => {
        if (!prev) return prev
        const next = { ...prev, ...(d.fields as Partial<ActionDetail>) }
        writeActionCache(actionId, next)
        return next
      })
    })
  }, [actionId])

  // If the action is deleted from elsewhere, drop the cached entry and close.
  useEffect(() => {
    return onEntityDeleted((d) => {
      if (d.entityType !== 'action' || d.id !== actionId) return
      deleteActionCache(actionId)
      onClose()
    })
  }, [actionId, onClose])

  // Picker/lookup data below goes through cachedJson — workspace-level data
  // that barely changes between panel opens, so repeat opens resolve from the
  // shared cache instantly instead of re-firing ~6 lookups every time.

  // Fetch workflow states when action loads (need team_id)
  useEffect(() => {
    if (!action?.team_id) return
    let cancelled = false
    cachedJson<{ states?: WorkflowState[] }>(
      `/api/account/workflow-states?team_id=${action.team_id}`,
      { scope: workspaceId },
    )
      .then((d) => { if (!cancelled && d) setWorkflowStates(d.states || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [action?.team_id, workspaceId])

  // Fetch team cycles for cycle picker — active + upcoming in parallel
  useEffect(() => {
    if (!action?.team_id) return
    let cancelled = false
    type CyclesResponse = { cycles?: { id: string; name: string; number: number; status: string }[] }
    Promise.all([
      cachedJson<CyclesResponse>(`/api/account/cycles?team_id=${action.team_id}&status=active`, { scope: workspaceId }),
      cachedJson<CyclesResponse>(`/api/account/cycles?team_id=${action.team_id}&status=upcoming`, { scope: workspaceId }),
    ])
      .then(([active, upcoming]) => {
        if (cancelled) return
        const all = [...(active?.cycles || []), ...(upcoming?.cycles || [])]
        setTeamCycles(all.map((c) => ({
          id: c.id,
          name: c.name,
          number: c.number,
          status: c.status,
        })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [action?.team_id, workspaceId])

  // Labels are now fetched via useScopedLabels('action') hook above

  // Fetch workspace projects for project picker (minimal — base rows only)
  useEffect(() => {
    let cancelled = false
    cachedJson<{ projects?: { id: string; name: string }[] }>(
      '/api/account/projects?minimal=1',
      { scope: workspaceId },
    )
      .then((d) => {
        if (cancelled || !d) return
        const list = (d.projects || [])
          .filter((p) => p.name !== '__default__')
          .map((p) => ({ id: p.id, name: p.name }))
        setProjects(list)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  // Fetch milestones and repo info when project changes
  useEffect(() => {
    if (!action?.project_id) {
      setProjectMilestones([])
      setProjectRepo(null)
      return
    }
    fetch(`/api/account/projects/${action.project_id}/milestones`)
      .then((r) => r.json())
      .then((d) => setProjectMilestones(d.milestones || []))
      .catch(() => setProjectMilestones([]))
    fetch(`/api/account/projects/${action.project_id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.project) {
          setProjectRepo({ github_repo: d.project.github_repo || null })
        }
      })
      .catch(() => {})
  }, [action?.project_id])

  // Fetch workspace members for assignee picker
  useEffect(() => {
    let cancelled = false
    cachedJson<{ members?: TeamMember[]; aiMembers?: AiMemberOption[] }>('/api/account/workspace', { scope: workspaceId })
      .then((d) => {
        if (cancelled || !d) return
        const memberList = (d.members || []).map((m) => ({
          id: m.id,
          display_name: m.display_name,
          avatar_url: m.avatar_url,
        }))
        setMembers(memberList)
        setAiMembers((d.aiMembers || []).map((m) => ({
          id: m.id,
          name: m.name,
          avatar_url: m.avatar_url,
        })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  // A server-side agent run's outcome reaches the panel without polling
  // (plan 1.2): the entity bus patches `agent_run_status` from the `actions`
  // row (onEntityUpdated above), and the linked PRs ride their own
  // `action_github_pr action_id=eq.<action>` channel (migration 283 put the
  // table in the publication). What the old 5 s poll also covered:
  //  - the PR list on the working → pr_open transition (a PR row can land
  //    before or after the status write; refetching on both is cheap);
  //  - a dropped socket: the channel's resync re-reads the run fields and PRs.
  const refetchLinkedPrs = useCallback(() => {
    fetch(`/api/account/actions/${actionId}/prs`)
      .then((res) => (res.ok ? res.json() : null))
      .then((pd) => { if (pd?.prs) setLinkedPrs(pd.prs) })
      .catch(() => {})
  }, [actionId])
  const refetchAgentFields = useCallback(() => {
    fetch(`/api/account/actions/${actionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.action) return
        setAction((prev) => (prev ? {
          ...prev,
          agent_run_status: d.action.agent_run_status,
          assignee_ai_member_id: d.action.assignee_ai_member_id,
          assignee_ai_member_name: d.action.assignee_ai_member_name,
          assignee_ai_member_avatar: d.action.assignee_ai_member_avatar,
        } : prev))
      })
      .catch(() => {})
  }, [actionId])
  const prevRunStatusRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const status = action?.agent_run_status ?? null
    const prev = prevRunStatusRef.current
    prevRunStatusRef.current = status
    if (prev !== undefined && prev !== status && status === 'pr_open') refetchLinkedPrs()
  }, [action?.agent_run_status, refetchLinkedPrs])
  useRowChanges({
    table: 'action_github_pr',
    filter: `action_id=eq.${actionId}`,
    events: ['INSERT', 'UPDATE', 'DELETE'],
    onRow: () => refetchLinkedPrs(),
    onResync: () => {
      refetchLinkedPrs()
      refetchAgentFields()
    },
  })

  // Resolve this action's server-side runs once per action. Two things ride on
  // it: (1) `hasWorkRun` — whether any run is workspace-kind (Loops v3). A
  // work-run action ALWAYS has such a run (the Start route inserts it), so this
  // is the durable "show the Cloud tab" signal that survives completion, when the
  // action has no AI assignee and agent_run_status is no longer live. (2) the
  // parked run id, so the "Waiting on you" chip can deep-link into the run's
  // Cloud-run view. Re-runs when agent_run_status changes so a freshly-started or
  // freshly-parked run is picked up without a manual reopen.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/account/actions/${actionId}/agent-runs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        const runs = (Array.isArray(d.runs) ? d.runs : Array.isArray(d) ? d : []) as Array<{
          id: string
          status: string
          kind?: string
        }>
        setHasWorkRun(runs.some((run) => run.kind === 'workspace'))
        const parked = runs.find((run) => run.status === 'needs_input') ?? runs[0]
        setWorkRunId(parked ? parked.id : null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [actionId, action?.agent_run_status])

  // Fetch sub-actions
  useEffect(() => {
    fetch(`/api/account/actions?parent_id=${actionId}`)
      .then((r) => r.json())
      .then((d) => setSubActions(d.actions || []))
      .catch(() => {})
  }, [actionId])

  // Fetch relations
  useEffect(() => {
    fetch(`/api/account/actions/${actionId}/relations`)
      .then((r) => r.json())
      .then((d) => setRelations(d.relations || []))
      .catch(() => {})
  }, [actionId])

  // Fetch linked documents
  useEffect(() => {
    fetch(`/api/account/actions/${actionId}/documents`)
      .then((r) => r.json())
      .then((d) => setLinkedDocs(d.documents || []))
      .catch(() => {})
  }, [actionId])

  // Fetch all documents for the picker
  useEffect(() => {
    let cancelled = false
    cachedJson<{ documents?: { id: string; title: string }[] }>(
      '/api/account/documents',
      { scope: workspaceId },
    )
      .then((d) => {
        if (cancelled || !d) return
        setAllDocuments((d.documents || []).map((doc) => ({ id: doc.id, title: doc.title })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  // Fetch linked PRs
  useEffect(() => {
    fetch(`/api/account/actions/${actionId}/prs`)
      .then((r) => r.json())
      .then((d) => setLinkedPrs(d.prs || []))
      .catch(() => {})
  }, [actionId])

  // Linked external tasks (Asana &c.): ownership came BACK to the panel when the
  // property lens arrived, because there are now two readers — the toolbar menu's
  // button tint and the lens switcher. The panel resolves the rows once from the
  // action detail response (see `externalLinks` above) and drives the menu in
  // controlled mode; the menu still owns the push/unlink CALLS and reports their
  // outcomes back. One resolver, one source of truth, which is what the
  // "no probe requests" guard in the push-menu suite is about.

  // Reset transient UI state when switching actions
  useEffect(() => {
    setNewLinkUrl('')
    // Close the composer too: a half-filled sub-action form left open would
    // otherwise carry over and submit against a different parent.
    setShowSubActionForm(false)
    setNewPrUrl('')
    setPrError('')
  }, [actionId])

  /** Re-read the action after a refused save, so the panel (and its cache)
   *  show what the server actually holds rather than the optimistic edit. */
  function reloadAction() {
    const id = actionId
    fetch(`/api/account/actions/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.action || actionIdRef.current !== id) return
        setAction(data.action)
        writeActionCache(id, data.action)
      })
      .catch(() => {})
  }

  async function patchAction(updates: Record<string, unknown>) {
    // Capture the pre-patch completion state so we can detect a transition
    // INTO completed (and only then celebrate).
    const wasCompleted = action?.status_category === 'completed'
    // PATCH answers without the comment count GET carries; keep ours.
    const commentCount = action?.comment_count
    // Optimistic update — reflect the change immediately so fields feel instant.
    setAction((prev) => (prev ? { ...prev, ...updates } : prev))
    setSaving(true)
    let res: Response
    try {
      res = await fetch(`/api/account/actions/${actionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    } catch {
      setSaving(false)
      toast.error("Couldn't save that change")
      reloadAction()
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error || "Couldn't save that change")
      reloadAction()
    } else {
      const data = await res.json()
      if (data.action && data.action.comment_count == null) data.action.comment_count = commentCount
      setAction(data.action)
      // Cute confetti pop, anchored to the status field, when this edit just
      // completed the action.
      if (!wasCompleted && data.action?.status_category === 'completed') {
        celebrateFromElement(statusFieldRef.current)
      }
      writeActionCache(actionId, data.action)
      // Notify any list/board cache that this action changed so they can patch
      // the row in place instead of showing stale data after navigation.
      // Send only the patched delta — list rows have a different shape than
      // ActionDetail (e.g. workflow_state object vs status_id string), so
      // spreading the whole detail object would clobber correct row fields.
      suppressEchoRef.current = true
      emitEntityUpdated({ entityType: 'action', id: actionId, fields: updates })
      // Reset after the synchronous dispatch so future external events aren't
      // silently dropped. The listener fires in the same call frame as
      // dispatchEvent, so the flag is already consumed by now.
      queueMicrotask(() => { suppressEchoRef.current = false })
      onUpdate?.(data.action)
    }
    setSaving(false)
  }

  function handleTitleChange(value: string) {
    if (!action) return
    setAction({ ...action, title: value })
    if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current)
    titleTimeoutRef.current = setTimeout(() => {
      patchAction({ title: value })
    }, 500)
  }

  function handleDescriptionChange(value: string) {
    if (!action) return
    // Store in ref instead of calling setAction to avoid re-rendering
    // the entire panel on every keystroke. NoteEditor manages its own
    // display state internally via Tiptap.
    pendingDescriptionRef.current = value
    if (descriptionTimeoutRef.current)
      clearTimeout(descriptionTimeoutRef.current)
    descriptionTimeoutRef.current = setTimeout(() => {
      patchAction({ description: value })
      pendingDescriptionRef.current = null
    }, 500)
  }

  const handleFileUpload = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const errors: string[] = []
    const allowed: File[] = []
    for (const file of files) {
      const check = isAllowedAttachmentFile(file)
      if (check.ok) allowed.push(file)
      else errors.push(check.reason)
    }
    if (allowed.length === 0) {
      setUploadError(errors.join(' '))
      setTimeout(() => setUploadError(null), 6000)
      return
    }
    setUploading(true)
    try {
      for (const file of allowed) {
        try {
          await uploadAttachment({ file, actionId })
        } catch (err) {
          errors.push(err instanceof AttachmentUploadError
            ? err.message
            : `${file.name}: upload failed. Please try again.`)
        }
      }
      setAttachmentRefreshKey((k) => k + 1)
    } finally {
      setUploading(false)
    }
    if (errors.length > 0) {
      setUploadError(errors.join(' '))
      setTimeout(() => setUploadError(null), 6000)
    }
  }, [actionId])

  const handleAddAttachment = useCallback(async () => {
    if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({
          multiple: true,
          title: 'Add attachments',
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'heif'] },
            { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md'] },
            { name: 'Code', extensions: ['json', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml', 'sh', 'sql', 'r', 'lua', 'php', 'env', 'log', 'conf', 'cfg', 'ini'] },
          ],
        })
        if (!selected) return
        const paths = Array.isArray(selected) ? selected : [selected]
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const files: File[] = []
        const readErrors: string[] = []
        for (const path of paths) {
          try {
            const assetUrl = convertFileSrc(path)
            const resp = await fetch(assetUrl)
            if (!resp.ok) throw new Error(`could not read file (${resp.status})`)
            const blob = await resp.blob()
            const name = path.split('/').pop() || 'file'
            files.push(new File([blob], name, { type: blob.type || 'application/octet-stream' }))
          } catch (err) {
            const name = path.split('/').pop() || path
            readErrors.push(`"${name}": ${err instanceof Error ? err.message : 'could not read file'}`)
          }
        }
        if (readErrors.length > 0) {
          setUploadError(readErrors.join(' '))
          setTimeout(() => setUploadError(null), 6000)
        }
        if (files.length > 0) handleFileUpload(files)
      } catch (err) {
        console.warn('[ActionDetailPanel] Tauri dialog failed:', err)
        setUploadError(
          err instanceof Error && err.message
            ? `Could not open the file picker: ${err.message}`
            : 'Could not open the file picker. Try dragging the file onto the panel instead.',
        )
        setTimeout(() => setUploadError(null), 6000)
      }
    } else {
      fileInputRef.current?.click()
    }
  }, [handleFileUpload])

  // Drag-and-drop + paste-to-attach, scoped to the panel element. In the desktop
  // WebView an unhandled drop navigates the whole app, so preventDefault is
  // load-bearing here, not just cosmetic.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return

    // A zone inside the panel (the Cloud tab's run chat box) keeps its drops.
    const ours = (e: Event) => {
      const zone = dropZoneOf(e.target)
      return !zone || zone === el
    }
    let counter = 0
    const onDragEnter = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      counter++
      if (e.dataTransfer?.types.includes('Files')) setIsDragging(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      counter = Math.max(0, counter - 1)
      if (counter === 0) setIsDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      counter = 0
      setIsDragging(false)
      if (!ours(e)) return
      e.preventDefault()
      e.stopPropagation()
      const files = filesFromTransfer(e.dataTransfer)
      if (files.length > 0) handleFileUpload(files)
    }
    // Paste is bound to the panel element (not document) — every tab stays
    // mounted behind display:none, so a document listener would attach one
    // paste to every open action. We bow out when the paste lands in a text
    // field or the NoteEditor so we never steal a normal paste — only
    // clipboard files attach.
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || [])
      if (files.length === 0) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const named = files.map((file, i) => {
        if (file.name) return file
        const ext = (file.type.split('/')[1] || 'png').toLowerCase()
        return new File([file], `screenshot-${Date.now()}${i > 0 ? `-${i}` : ''}.${ext}`, {
          type: file.type || 'image/png',
        })
      })
      handleFileUpload(named)
    }
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    el.addEventListener('paste', onPaste)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('paste', onPaste)
    }
  }, [handleFileUpload])

  // Its properties show outside the panel (the card's popover or column): a
  // drop zone of their own, so a file dropped on Attachments lands here too.
  const [propsEl, setPropsEl] = useState<HTMLDivElement | null>(null)
  const [propsDragging, setPropsDragging] = useState(false)
  useElementFileDrop(propsEl, handleFileUpload, setPropsDragging, { paste: false })

  function handleAddLink() {
    const url = newLinkUrl.trim()
    if (!url || !action) return
    const links = [...(action.links || []), { url }]
    setNewLinkUrl('')
    patchAction({ links })
  }

  function handleRemoveLink(index: number) {
    if (!action) return
    const links = (action.links || []).filter((_, i) => i !== index)
    patchAction({ links })
  }

  const labelToggleInFlight = useRef(new Set<string>())
  async function toggleLabel(labelId: string, isAttached: boolean) {
    if (!action) return
    if (labelToggleInFlight.current.has(labelId)) return
    labelToggleInFlight.current.add(labelId)

    // Optimistic update
    let updated: typeof action
    if (isAttached) {
      updated = { ...action, labels: (action.labels ?? []).filter((l) => l.id !== labelId) }
    } else {
      const label = allLabels.find((l) => l.id === labelId)
      updated = label ? { ...action, labels: [...action.labels, label] } : action
    }
    setAction(updated)
    onUpdate?.(updated as unknown as Record<string, unknown>)

    try {
      const res = isAttached
        ? await fetch(`/api/account/actions/${actionId}/labels/${labelId}`, {
            method: 'DELETE',
          })
        : await fetch(`/api/account/actions/${actionId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label_id: labelId }),
          })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Revert on failure (a refused request as much as a network error)
      toast.error("Couldn't update the label")
      setAction(action)
      onUpdate?.(action as unknown as Record<string, unknown>)
    } finally {
      labelToggleInFlight.current.delete(labelId)
    }
  }

  /**
   * Create a sub-action from the inline composer.
   *
   * Mirrors the create dialog's sequence, because the create endpoint doesn't
   * take all of these fields: POST the action, PATCH the ones it ignores
   * (status, description), then attach labels one at a time. Skipping the
   * follow-ups would let the composer collect properties it silently dropped.
   */
  async function handleAddSubAction(draft: SubActionDraft) {
    if (!draft.title || !action) return

    const res = await fetch('/api/account/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        team_id: action.team_id,
        parent_id: actionId,
        priority: draft.priority,
        assignee_ids: draft.assigneeIds.length > 0 ? draft.assigneeIds : undefined,
        project_id: draft.projectId || undefined,
      }),
    })
    if (!res.ok) return

    const data = await res.json()
    const created = data.action

    const patches: Record<string, unknown> = {}
    // Only send a status when it differs from the one the server already
    // assigned by default, so the common case stays a single request.
    if (draft.statusId && workflowStates.length > 0) {
      const defaultState =
        workflowStates.find((s) => s.is_default) ||
        workflowStates.find((s) => s.category === 'backlog')
      if (!defaultState || draft.statusId !== defaultState.id) patches.status_id = draft.statusId
    }
    if (draft.description) patches.description = draft.description
    if (Object.keys(patches).length > 0) {
      await fetch(`/api/account/actions/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patches),
      })
    }

    for (const labelId of draft.labelIds) {
      await fetch(`/api/account/actions/${created.id}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label_id: labelId }),
      })
    }

    // Re-fetch so the row reflects the patched status/labels rather than the
    // POST's pre-patch response.
    const fresh = await fetch(`/api/account/actions/${created.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    setSubActions((prev) => [...prev, fresh?.action ?? created])
  }

  async function handleDeleteRelation(relationId: string) {
    const res = await fetch(
      `/api/account/actions/${actionId}/relations/${relationId}`,
      { method: 'DELETE' },
    )
    if (res.ok) {
      setRelations((prev) => prev.filter((r) => r.id !== relationId))
    }
  }

  async function handleLinkDocument(documentId: string) {
    const res = await fetch(`/api/account/actions/${actionId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: documentId }),
    })
    if (res.ok) {
      // Re-fetch to get full document info
      fetch(`/api/account/actions/${actionId}/documents`)
        .then((r) => r.json())
        .then((d) => setLinkedDocs(d.documents || []))
        .catch(() => {})
    }
    setDocSearchOpen(false)
  }

  async function handleUnlinkDocument(linkId: string) {
    const res = await fetch(
      `/api/account/actions/${actionId}/documents?link_id=${linkId}`,
      { method: 'DELETE' },
    )
    if (res.ok) {
      setLinkedDocs((prev) => prev.filter((d) => d.link_id !== linkId))
    }
  }

  // The action as a self-contained prompt, to paste into any coding tool. The
  // clipboard write starts synchronously in the click (copyDeferredTextToClipboard)
  // while the prompt is still being built, so the desktop's WKWebView keeps the
  // click's permission to write.
  function handleCopyAsPrompt() {
    if (!action) return
    const prompt = import('@/lib/ai/build-action-context')
      .then(({ buildActionContext }) => buildActionContext(actionId))
      .then(({ prompt }) => prompt)
    prompt.catch((err) => console.error('Failed to build the prompt:', err))
    void copyDeferredTextToClipboard(prompt).then((ok) => {
      if (ok) toast.success('Prompt copied')
      else toast.error("Couldn't copy the prompt")
    })
  }

  // Start the assigned agent's coding run on this action, server-side (the eve
  // coding agent); it opens a PR and the run status syncs back.
  async function handleStartAgent() {
    if (!action || !action.assignee_ai_member_id) return
    setStartingAgent(true)
    try {
      const res = await fetch(`/api/account/actions/${actionId}/start-agent`, { method: 'POST' })
      if (!res.ok) {
        const error = ((await res.json().catch(() => ({}))) as { error?: string })?.error
        // A refusal (4xx: ACTION_BUSY, a teammate's job already running; no
        // folder linked to the repo; your Mac offline; no repo or GitHub) is
        // not a failure: the server's sentence, and the status stays as it was.
        if (res.status >= 400 && res.status < 500) {
          toast.error(`Couldn't start ${action.assignee_ai_member_name || 'the agent'}`, { description: error || 'It was refused.' })
          return
        }
        throw new Error(error || 'start failed')
      }
      const started = (await res.json().catch(() => null)) as { mode?: string; mac?: string } | null
      // On your Mac ("Run my work here"): it runs there, not in the cloud-run
      // view, and the server marks it working itself (read back here, the
      // entity bus brings it too).
      if (started?.mode === 'mac') {
        toast.success(started.mac ? `Started on ${started.mac}` : 'Running on your Mac')
        refetchAgentFields()
        return
      }
      // Run queued — jump to the Cloud-run view so the user can watch status +
      // logs stream in. Status moves working → pr_open/failed and the PR
      // appears via the linked-PRs list.
      setAction((prev) => (prev ? { ...prev, agent_run_status: 'working' } : prev))
      setPanelView('cloud')
    } catch (err) {
      console.error('Failed to start agent:', err)
      // Surface the reason to the user — these are usually actionable
      // preconditions (no repo connected, GitHub not linked), not transient
      // glitches, so a silent failure leaves them stuck with no clue why.
      const message = err instanceof Error ? err.message : 'Could not start the agent'
      toast.error(`Couldn't start ${action.assignee_ai_member_name || 'the agent'}`, {
        description: message,
      })
      setAction((prev) => (prev ? { ...prev, agent_run_status: 'failed' } : prev))
      fetch(`/api/account/actions/${actionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_run_status: 'failed' }),
      }).catch(() => {})
    } finally {
      // Always clear the spinner, or the Play / Re-run buttons stay disabled.
      setStartingAgent(false)
    }
  }

  async function handleLinkPr() {
    const url = newPrUrl.trim()
    if (!url) return
    setPrError('')
    setLinkingPr(true)
    try {
      const res = await fetch(`/api/account/actions/${actionId}/prs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_url: url }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPrError(data.error || 'Failed to link PR')
      } else {
        setLinkedPrs((prev) => [data.pr, ...prev.filter((p) => p.id !== data.pr.id)])
        setNewPrUrl('')
      }
    } catch {
      setPrError('Failed to link PR')
    }
    setLinkingPr(false)
  }

  async function handleUnlinkPr(prId: string) {
    const res = await fetch(`/api/account/actions/${actionId}/prs/${prId}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      setLinkedPrs((prev) => prev.filter((p) => p.id !== prId))
    }
  }

  // Ensure the action's current status/project render immediately, even before
  // the full workflowStates/projects lists finish loading (avoids a flash of the
  // empty "Set status" / "Set project" placeholders for an item that has them).
  const statusOptions = useMemo<WorkflowStateOption[]>(() => {
    if (action && !workflowStates.some((s) => s.id === action.status_id)) {
      return [
        {
          id: action.status_id,
          name: action.status_name,
          category: action.status_category ?? 'backlog',
          color: action.status_color,
        },
        ...workflowStates,
      ]
    }
    return workflowStates
  }, [workflowStates, action])

  const projectOptions = useMemo<PickerProjectOption[]>(() => {
    const list: PickerProjectOption[] = projects.map((p) => ({ id: p.id, name: p.name, icon: null }))
    if (action?.project_id && action.project_name && !list.some((p) => p.id === action.project_id)) {
      list.unshift({ id: action.project_id, name: action.project_name, icon: null })
    }
    return list
  }, [projects, action?.project_id, action?.project_name])

  // Whether the Cloud-run tab is offered at all (see canShowCloudRunTab).
  const canShowCloudTab =
    !!action &&
    canShowCloudRunTab({
      assignedToAi: !!action.assignee_ai_member_id,
      hasWorkRun,
      agentRunStatus: action.agent_run_status,
    })
  const cloudRunMarker = action ? cloudRunTabMarker(action.agent_run_status) : null

  return (
    <div ref={panelRef} data-file-drop-zone="" className="relative flex h-full flex-col">
      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 backdrop-blur-sm">
          <div className="text-center">
            <Paperclip className="mx-auto h-8 w-8 text-primary/60" />
            <p className="mt-2 text-sm font-medium text-primary/80">Drop files to attach</p>
          </div>
        </div>
      )}
      {/* Sub-header toolbar — action buttons (matches left panel toolbar height) */}
      <div className="flex h-10 shrink-0 items-center px-3">
        {/* View switcher — pill tabs matching the project detail panel. Offered
            whenever this action can carry a server-side run: an AI assignee
            (coding run), a workspace-kind run (Loops v3 work run — reachable even
            after it completes), or a currently-live run status. */}
        {action && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPanelView('details')}
              className={cn(
                'inline-flex shrink-0 items-center px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
                panelView === 'details'
                  ? 'bg-foreground text-background border-foreground font-medium'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
              )}
            >
              Details
            </button>
            {canShowCloudTab && (
            <button
              onClick={() => setPanelView('cloud')}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
                panelView === 'cloud'
                  ? 'bg-foreground text-background border-foreground font-medium'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
              )}
            >
              <Cloud className="h-3 w-3" />
              Cloud run
              {/* Exactly one status marker, chosen in cloud-run-gate.ts. */}
              {cloudRunMarker === 'needs_input' && (
                <MessageCircleQuestion className="h-3 w-3 animate-pulse text-amber-500" />
              )}
              {cloudRunMarker === 'live' && <Loader2 className="h-3 w-3 animate-spin" />}
              {cloudRunMarker === 'failed' && (
                <AlertCircle
                  className={cn(
                    'h-3 w-3',
                    // The selected tab has a foreground-coloured fill, where
                    // text-destructive is close to unreadable.
                    panelView === 'cloud' ? 'text-background' : 'text-destructive',
                  )}
                />
              )}
            </button>
            )}
            <button
              onClick={() => setPanelView('agents')}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 px-3 py-1 text-xs rounded-full border transition-colors whitespace-nowrap',
                panelView === 'agents'
                  ? 'bg-foreground text-background border-foreground font-medium'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
              )}
            >
              <Boxes className="h-3 w-3" />
              Agents
            </button>
          </div>
        )}
        {/* Work-run parked on a question (Loops v3): a "Waiting on you" chip that
            jumps to the in-panel Cloud-run view, where the question picker lives.
            Shown for a work-run action (agent_run_status='needs_input') — these
            carry no AI assignee, so the chip is the discoverable path in. */}
        {action?.agent_run_status === 'needs_input' && (
          <button
            type="button"
            onClick={() => setPanelView('cloud')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-60 dark:text-amber-400"
            title="The agent asked a question — open the run to answer"
          >
            <MessageCircleQuestion className="h-3 w-3 animate-pulse" />
            Waiting on you
          </button>
        )}
        <WindowActions reveal={reminderOpen} className="ml-auto flex items-center gap-1">
          {saving && <span className="text-xs text-muted-foreground">Saving...</span>}
          {/* Listen mode (desktop only): where this action stands, then its
                    description, spoken as it opens. No button of its own: the
                    Listen mode toggle in the top bar is its control, as for an
                    email. */}
          {action && (
            <ListenBrief kind="action" id={action.id} fallback={() => plainLine(action.title)} />
          )}
          {/* The one entity actions menu: Copy link, Copy ID ("action <uuid>",
                    for AI prompts / MCP), Share, and the rest the kind offers. */}
          {action && <EntityActionsMenu entity={{ type: 'action', id: action.id, label: action.title ?? '' }} omit={PANEL_OMIT} />}
          {/* Remind me — the same picker ⇧H opens, anchored on its own button so
                    the popover has somewhere to point when the hotkey fires. */}
          <ReminderPickerPopover
            open={reminderOpen}
            onOpenChange={setReminderOpen}
            entityType="action"
            entityId={actionId}
            existing={reminder}
          >
            <PreferenceActionButton
              label="Remind me"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              title="Remind me (⇧H)"
            >
              <AlarmClock className="h-3.5 w-3.5" />
            </PreferenceActionButton>
          </ReminderPickerPopover>
          {/* Agent run control — only when this action is assigned to an agent.
                    Idle/failed = launch button; working/PR-opened = status icon. */}
          {action?.assignee_ai_member_id && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {action.agent_run_status === 'working' ? (
                    // Running — click to jump to the Cloud run view, where the
                    // Stop button lives. Spinner doubles as the affordance.
                    <PreferenceActionButton
                      label="View the running cloud job"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-primary hover:text-primary"
                      onClick={() => setPanelView('cloud')}
                      aria-label="View the running cloud job"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    </PreferenceActionButton>
                  ) : action.agent_run_status === 'pr_open' ? (
                    <PreferenceActionButton label="Pull request opened" disabled variant="ghost" className="h-7 w-7 p-0 text-emerald-600 dark:text-emerald-400">
                      <GitPullRequest className="h-3.5 w-3.5" />
                    </PreferenceActionButton>
                  ) : (
                    <PreferenceActionButton
                      label="Run agent in cloud"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => handleStartAgent()}
                      disabled={startingAgent}
                      aria-label={`Launch ${action.assignee_ai_member_name || 'agent'} to work on this task`}
                    >
                      {startingAgent ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </PreferenceActionButton>
                  )}
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  align="end"
                  className="max-w-[240px] text-xs leading-relaxed"
                >
                  {action.agent_run_status === 'working'
                    ? `${action.assignee_ai_member_name || 'Agent'} is working — click to view or stop the run`
                    : action.agent_run_status === 'pr_open'
                      ? `PR opened by ${action.assignee_ai_member_name || 'agent'}`
                      : action.agent_run_status === 'failed'
                        ? `Retry — launch ${action.assignee_ai_member_name || 'the agent'} to work on this task`
                        : `Launch ${action.assignee_ai_member_name || 'the agent'} to start working on this task`}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {/* Push to an external task tracker (Asana &c.). Replaces the old
                    "Asana" properties section.

                    CONTROLLED, unlike before the property lens: the panel resolves the
                    link rows once (embedded in the action detail response) and passes
                    them, because the lens switcher needs the same answer and two
                    independent fetchers would double every panel open's requests (the
                    duplicate the push-menu suite forbids). The menu still runs the
                    push/unlink calls and reports them back through onPushed/onUnlinked,
                    which is what keeps the rows the panel holds from going stale.
                    Picking an unlinked provider opens the compose panel; `actionTitle`
                    is what it starts from.

                    REPLACE ON RESOLVE, never clear-then-fetch — see `externalLinks`.
                    Controlled mode makes the menu treat this array as the truth, so the
                    array must never be one we do not have: the refresh effect used to
                    set `[]` before awaiting, and in that window the trigger drew the
                    upload arrow and named itself "Push to…" — an affirmative "in no
                    tracker" for an action sitting in Jira. Holding the previous rows
                    until the new ones land removes that window entirely for any action
                    whose links have ever resolved.

                    And `linksKnown` covers the rest of it. `?? []` is the only array we
                    can pass before the FIRST read lands, but an empty array is itself a
                    claim, so we disclaim it explicitly rather than let the menu take our
                    placeholder for knowledge — the trigger then hedges (neutral glyph,
                    "Task app options") instead of promising the action is unlinked. */}
          {action && (
            <PushToTrackerMenu
              actionId={action.id}
              actionTitle={action.title ?? null}
              links={externalLinks ?? []}
              linksKnown={externalLinks !== undefined}
              onPushed={(link) =>
                setExternalLinks((prev) => [
                  // UNIQUE (action_id, provider) — a re-push replaces its row
                  // rather than adding a second tab for the same tracker.
                  // A push before the first read resolves still gives us one
                  // link first-hand, which beats staying unknown.
                  ...(prev ?? []).filter((l) => l.provider !== link.provider),
                  link,
                ])
              }
              onUnlinked={(linkId) =>
                // Only ever narrows a KNOWN set: an unlink cannot happen through a
                // menu that never learned there was a link, so `undefined` here
                // would be a state we invented rather than one we observed.
                setExternalLinks((prev) => prev?.filter((l) => l.id !== linkId))
              }
              onOpenSettings={settingsOverlay.openSettings}
              // The sidebar is a vertical column — the fields stack, they don't
              // scroll sideways.
              composeLayout="stack"
              autoComposeProvider={autoComposeProvider}
              // BUILT here, DRAWN in the properties sidebar below. Until that
              // host exists (the sidebar is collapsed, or this is the first
              // render of compose mode) the form renders nowhere rather than
              // falling back into the toolbar, where the form has no room.
              renderCompose={(node) => (composeHost ? createPortal(node, composeHost) : null)}
              onComposeChange={(destination) => {
                setComposeProviderName(destination?.name ?? null)
                if (destination) {
                  // ARMING OPENS THE SIDEBAR, whichever path armed it.
                  //
                  // The form's only host is the properties sidebar, and the
                  // toolbar's push menu can be used with that sidebar collapsed
                  // — in which case `composeHost` is null, `renderCompose` draws
                  // nothing, and the toggle that would fix it is DISABLED with
                  // "Finish or cancel the push first". There is no finish and no
                  // cancel to reach: the form the message refers to was never
                  // mounted. The lock above is what makes this coherent — the
                  // sidebar is guaranteed visible for as long as it's locked,
                  // whatever the panel width.
                } else {
                  // A cancel must not be re-armed by the board's request still
                  // sitting in state — that is what would make the form
                  // impossible to dismiss.
                  setAutoComposeProvider(null)
                }
              }}
            />
          )}
          {/* Relations icon */}
          <PreferenceActionButton label="Relations" variant="ghost" size="sm" className="h-7 w-7 p-0">
            <GitBranch className="h-3.5 w-3.5" />
          </PreferenceActionButton>
          {/* Move to another workspace — the dialog emits the delete event and
                    drops the detail cache, so here we only have to close. */}
          <MoveToWorkspaceButton
            entityType="action"
            id={actionId}
            entityLabel={action?.title || undefined}
            onMoved={onClose}
          />
          {/* Delete action */}
          <PreferenceActionButton
            label="Delete action"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            onClick={() => setDeleteConfirm(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </PreferenceActionButton>
          {/* Copy as prompt — the action as a self-contained prompt for any coding tool. */}
          <PreferenceActionButton
            label="Copy as prompt"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            onClick={handleCopyAsPrompt}
            disabled={!action}
          >
            <Copy className="h-3.5 w-3.5" />
          </PreferenceActionButton>
        </WindowActions>
      </div>

      <ContentTransition contentKey={actionId} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 justify-center">
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </div>
      ) : !action ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-sm text-muted-foreground">Action not found</div>
        </div>
      ) : panelView === 'agents' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[736px] px-5">
            <EntityActivitySection entityType="action" entityId={actionId} />
          </div>
        </div>
      ) : panelView === 'cloud' && canShowCloudTab ? (
        <CloudRunView
          actionId={actionId}
          // Re-run is coding-only — a work run is one-shot, so the panel only
          // wires the launcher when this action has an AI assignee (CloudRunView
          // itself also hides Re-run on a workspace-kind run).
          onRerun={action.assignee_ai_member_id ? () => handleStartAgent() : undefined}
          rerunning={startingAgent}
        />
      ) : (
      // Properties float at page level; the reading column stays centered.
      <div ref={panelBodyRef} className="flex flex-1 min-h-0 justify-center">
        {/* Centered reading column; properties do not consume window width. */}
        <div className="w-full max-w-[736px] min-w-0 mx-auto">
        <ScrollArea className="h-full">
          <div className="px-8 pb-28 space-y-8">
            {/* Title. The identifier used to print above it, but the breadcrumb
                header now carries the ID, so repeating it here was redundant. */}
            {/* Auto-acceptance is reported in Activity ("Created by the live
                agent"), not as a badge here: it describes how this action came
                to exist, which is what the timeline is for, and it stopped
                being news the moment you opened the action. */}
            <div className="pt-6 pb-2">
              <EntityTitleInput
                value={action.title ?? ''}
                onChange={handleTitleChange}
                placeholder="Untitled task"
              />
            </div>

            {/* Description */}
            <div>
              <NoteEditor
                key={actionId}
                initialContent={action.description || ''}
                onUpdate={handleDescriptionChange}
                placeholder="Add description..."
              />
            </div>

            {/* The job working this action: its plan, live, with Stop
                (decision 9). Owner-only under RLS: a teammate sees "Working". */}
            <ActionJobPlan
              actionId={actionId}
              agentRunId={workRunId}
              runLive={['starting', 'working', 'needs_input'].includes(action.agent_run_status ?? '')}
            />

            {/* Sub-actions */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-sm font-medium">Sub-actions</p>
                {subActions.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {subActions.length}
                  </Badge>
                )}
                {/* Add sits at the far right of the header row rather than
                    under the list, so it stays in the same place whether or not
                    there are sub-actions yet. Hidden while the composer is open
                    — it would be a no-op that reads as a second add control. */}
                {!showSubActionForm && (
                  <button
                    type="button"
                    onClick={() => setShowSubActionForm(true)}
                    aria-label="Add sub-action"
                    title="Add sub-action"
                    className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {subActions.length > 0 && (
                <div className="space-y-1">
                  {subActions.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
                      onClick={(e) => onSelectAction?.(sub.id, sub.title, e)}
                    >
                      <Circle
                        className="h-3 w-3 shrink-0"
                        style={{ color: sub.status_color }}
                        fill={sub.status_color}
                      />
                      <span className="font-mono text-muted-foreground">
                        {sub.identifier}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">
                        {sub.title}
                      </span>
                      {sub.assignee_avatar && (
                        <img
                          src={sub.assignee_avatar}
                          alt=""
                          className="h-4 w-4 shrink-0 rounded-full"
                        />
                      )}
                    </button>
                  ))}
                </div>
              )}
              {/* The same composer the create dialog uses, embedded inline —
                  a sub-action created here can carry status/priority/assignee/
                  project/labels instead of being title-only. */}
              {showSubActionForm && (
                <SubActionComposer
                  workflowStates={workflowStates}
                  members={members}
                  projects={projects}
                  labels={scopedLabels}
                  onSubmit={handleAddSubAction}
                  onCancel={() => setShowSubActionForm(false)}
                />
              )}
            </div>

            {/* Relations */}
            {relations.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-sm font-medium">Relations</p>
                </div>
                <div className="space-y-1">
                  {relations.map((rel) => (
                    <div
                      key={rel.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                    >
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {rel.type.replace('_', ' ')}
                      </Badge>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        onClick={(e) => onSelectAction?.(rel.action_id, rel.title, e)}
                      >
                        <span className="font-mono text-muted-foreground">
                          {rel.identifier}
                        </span>{' '}
                        {rel.title}
                      </button>
                      <Circle
                        className="h-2.5 w-2.5 shrink-0"
                        style={{ color: rel.status_color }}
                        fill={rel.status_color}
                      />
                      <button
                        onClick={() => handleDeleteRelation(rel.id)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Comments{action.comment_count ? ` (${action.comment_count})` : ''}
              </p>
              <Comments commentableType="action" commentableId={action.id} currentMemberId={currentMemberId} />
            </div>

            {/* Activity */}
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Activity</p>
              <div className="relative space-y-0">
                <div className="absolute left-[9px] top-3 bottom-3 w-px bg-border" />
                {action.updated_at !== action.created_at && (
                  <div className="relative flex items-start gap-3 py-1.5">
                    <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                      <Circle
                        className="h-2.5 w-2.5"
                        style={{ color: action.status_color }}
                        fill={action.status_color}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last updated · {formatRelativeTime(action.updated_at)}
                    </p>
                  </div>
                )}
                {action.due_at && (
                  <div className="relative flex items-start gap-3 py-1.5">
                    <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                      <CalendarIcon className="h-2.5 w-2.5 text-orange-500" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Due date set to{' '}
                      {new Date(action.due_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                )}
                {/* Auto-acceptance is part of THIS event rather than a row of
                    its own — it happened at creation, so a separate entry would
                    duplicate the timestamp and imply a second thing occurred. */}
                <div className="relative flex items-start gap-3 py-1.5">
                  <div className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-background">
                    {action.auto_accepted ? (
                      <Sparkles className="h-2.5 w-2.5 text-emerald-500" />
                    ) : (
                      <Plus className="h-2.5 w-2.5 text-green-500" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {action.auto_accepted ? 'Created by the live agent' : 'Created'} ·{' '}
                    {formatRelativeTime(action.created_at)}
                    {action.auto_accepted && action.ai_confidence != null && (
                      <span className="text-muted-foreground/70">
                        {' '}
                        · {Math.round(action.ai_confidence * 100)}% confident
                      </span>
                    )}
                    {/* Provenance, on the Created row for the same reason
                        auto-acceptance is: the action came from this meeting AT
                        creation, so it's a clause of that event, not a second
                        one. Only ~half of actions have a source capture — the
                        rest were created directly — so this is often absent. */}
                    {action.source_capture_id && (
                      <>
                        {' from '}
                        {onOpenEntity ? (
                          <button
                            type="button"
                            onClick={(e) =>
                              onOpenEntity(
                                'capture',
                                action.source_capture_id!,
                                action.source_capture_title || 'Capture',
                                e,
                              )
                            }
                            className="text-foreground underline-offset-2 hover:underline"
                          >
                            {action.source_capture_title || 'the capture'}
                          </button>
                        ) : (
                          <span className="text-foreground">
                            {action.source_capture_title || 'a capture'}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
        </div>

      </div>
      )}
      {action && !loading && (
        <WindowProperties key={actionId} title={action.title || 'Untitled action'} fallbackVisible={propertiesOpen} locked={!!composeProviderName || !!autoComposeProvider}>
            <div
              // Shown outside the panel (the card's properties popover or
              // column): its own drop zone, so a file dropped on Attachments
              // lands on this action.
              ref={setPropsEl}
              data-file-drop-zone=""
              className="relative p-4 space-y-4"
            >
              {propsDragging && (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-primary/5">
                  <p className="flex items-center gap-2 text-sm font-medium text-primary/80">
                    <Paperclip className="h-4 w-4" />
                    Drop files to attach
                  </p>
                </div>
              )}
              {/* THE LENS SWITCHER, above the group whose contents it swaps.
                  Only drawn when this action is linked to something — otherwise
                  the sidebar below is exactly what it always was. */}
              {showLensSwitcher && !composeProviderName && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {lens === 'dial8' ? 'Dial8 properties' : 'Live from the linked ticket'}
                  </p>
                  <PropertyLensSwitcher
                    providers={['dial8', ...lensProviders]}
                    active={lens}
                    onChange={setActiveLens}
                  />
                </div>
              )}

              {/* Properties group.
                  Under a provider lens this group keeps its frame and title and
                  exchanges only its CONTENTS — the linked ticket's fields, in
                  `stack` layout, which is the same labelled-column shape the
                  Dial8 fields below use. Every OTHER group in this sidebar is
                  untouched by the lens. */}
              <PropertyGroup title="Properties">
                {lensProvider ? (
                  <TaskLens
                    actionId={actionId}
                    provider={lensProvider}
                    layout="stack"
                    onOpenSettings={settingsOverlay.openSettings}
                  />
                ) : (
                <>
                {/* Status */}
                <div ref={statusFieldRef}>
                  <StatusPanelField
                    value={action.status_id}
                    workflowStates={statusOptions}
                    onChange={(v) => patchAction({ status_id: v })}
                  />
                </div>

                {/* Priority */}
                <PriorityPanelField
                  value={action.priority}
                  onChange={(v) => patchAction({ priority: v })}
                />

                {/* Assignees (multi-select) */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex h-8 w-full items-center gap-2 rounded-md border-none bg-transparent px-2 text-sm hover:bg-muted/50 text-left">
                      {/* The delegate model (decision 9): the people responsible
                          lead, and the agent working it as the delegate follows
                          as a chip. An agent with nobody responsible stands alone. */}
                      {action.assignees && action.assignees.length > 0 ? (
                        <>
                          <div className="flex -space-x-1">
                            {action.assignees.slice(0, 3).map((a) =>
                              a.avatar_url ? (
                                <img key={a.id} src={a.avatar_url} alt="" className="h-4 w-4 rounded-full ring-1 ring-background" />
                              ) : (
                                <div key={a.id} className="flex h-4 w-4 items-center justify-center rounded-full bg-muted ring-1 ring-background">
                                  <User className="h-2.5 w-2.5 text-muted-foreground" />
                                </div>
                              )
                            )}
                          </div>
                          <span className="min-w-0 truncate">
                            {action.assignees.map((a) => a.display_name).join(', ')}
                          </span>
                        </>
                      ) : action.assignee_ai_member_id ? null : (
                        <>
                          <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">Assignee</span>
                        </>
                      )}
                      {action.assignee_ai_member_id && (
                        <span
                          data-delegate-chip=""
                          title={`Delegated to ${action.assignee_ai_member_name || 'an agent'}`}
                          className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-0.5 pr-2 text-xs text-primary"
                        >
                          {action.assignee_ai_member_avatar ? (
                            <img src={action.assignee_ai_member_avatar} alt="" className="h-4 w-4 shrink-0 rounded-full" />
                          ) : (
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10">
                              <Boxes className="h-2.5 w-2.5" />
                            </span>
                          )}
                          <span className="min-w-0 truncate">{action.assignee_ai_member_name || 'Agent'}</span>
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[220px] p-1" align="start">
                    <div className="max-h-[280px] overflow-y-auto">
                      {members.map((m) => {
                        // People and the delegate agent coexist (decision 9).
                        const isSelected = (action.assignees || []).some((a) => a.id === m.id)
                        return (
                          <button
                            key={m.id}
                            className="flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-sm hover:bg-accent"
                            onClick={() => {
                              const currentIds = (action.assignees || []).map((a) => a.id)
                              const newIds = isSelected
                                ? currentIds.filter((id) => id !== m.id)
                                : [...currentIds, m.id]
                              // Optimistically update the displayed assignees — the
                              // picker reads action.assignees, not assignee_ids.
                              // The delegate agent stays (decision 9).
                              const newAssignees = members
                                .filter((mm) => newIds.includes(mm.id))
                                .map((mm) => ({ id: mm.id, display_name: mm.display_name, avatar_url: mm.avatar_url }))
                              setAction((prev) => (prev ? { ...prev, assignees: newAssignees } : prev))
                              patchAction({ assignee_ids: newIds })
                            }}
                          >
                            <div className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                              isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                            )}>
                              {isSelected && <Check className="h-3 w-3" />}
                            </div>
                            {m.avatar_url ? (
                              <img src={m.avatar_url} alt="" className="h-4 w-4 rounded-full" />
                            ) : (
                              <User className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{m.display_name}</span>
                            {currentMemberId === m.id && <span className="text-xs text-muted-foreground">(Me)</span>}
                          </button>
                        )
                      })}

                      {aiMembers.length > 0 && (
                        <>
                          <div className="mt-1 mb-0.5 flex items-center gap-1 px-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground border-t border-border/50">
                            <Boxes className="h-2.5 w-2.5" /> Agents
                          </div>
                          {aiMembers.map((a) => {
                            const isSelected = action.assignee_ai_member_id === a.id
                            return (
                              <button
                                key={a.id}
                                className="flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-sm hover:bg-accent"
                                onClick={() => {
                                  // Selecting an agent makes it the delegate beside the
                                  // people (decision 9); clicking the selected agent
                                  // removes it. With nobody responsible, the delegator
                                  // (you) becomes responsible — the server writes it,
                                  // and the optimistic copy shows it.
                                  const nextAgentId = isSelected ? null : a.id
                                  const me = members.find((mm) => mm.id === currentMemberId)
                                  setAction((prev) => (prev ? {
                                    ...prev,
                                    assignees:
                                      nextAgentId && (prev.assignees || []).length === 0 && me
                                        ? [{ id: me.id, display_name: me.display_name, avatar_url: me.avatar_url }]
                                        : prev.assignees,
                                    assignee_ai_member_id: nextAgentId,
                                    assignee_ai_member_name: nextAgentId ? a.name : null,
                                    assignee_ai_member_avatar: nextAgentId ? a.avatar_url : null,
                                  } : prev))
                                  patchAction({ assignee_ai_member_id: nextAgentId })
                                }}
                              >
                                <div className={cn(
                                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                                  isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                                )}>
                                  {isSelected && <Check className="h-3 w-3" />}
                                </div>
                                {a.avatar_url ? (
                                  <img src={a.avatar_url} alt="" className="h-4 w-4 rounded-full" />
                                ) : (
                                  <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/10">
                                    <Boxes className="h-2.5 w-2.5 text-primary" />
                                  </div>
                                )}
                                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                              </button>
                            )
                          })}
                        </>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* The failed-run signal is a red ! on the Cloud-run tab, not a
                    note here: the tab is where the logs that explain the
                    failure live, so the marker belongs on the way in. An AI
                    assignee (the old condition for this note) always makes that
                    tab available — see cloud-run-gate.ts. */}

                {/* Due date */}
                <DatePanelField
                  value={action.due_at}
                  onChange={(iso) => patchAction({ due_at: iso })}
                  placeholder="Due date"
                  overdueSensitive={action.status_category !== 'completed'}
                />

                {/* Estimate */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
                      <Gauge className="h-4 w-4 shrink-0" />
                      <span>{action.estimate != null ? `${action.estimate} pts` : 'Estimate'}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48 p-3" align="start">
                    <div className="space-y-2">
                      <Label className="text-xs">Estimate (points)</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number" min={0} step={0.5}
                          defaultValue={action.estimate ?? ''}
                          onBlur={(e) => { const val = e.target.value.trim(); patchAction({ estimate: val ? parseFloat(val) : null }) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { const val = (e.target as HTMLInputElement).value.trim(); patchAction({ estimate: val ? parseFloat(val) : null }) } }}
                          className="h-7 text-xs" placeholder="0"
                        />
                        {action.estimate != null && (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => patchAction({ estimate: null })}>
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Cycle */}
                {teamCycles.length > 0 && (
                  <Select
                    value={action.cycle_id || '_none'}
                    onValueChange={(v) => patchAction({ cycle_id: v === '_none' ? null : v })}
                  >
                    <SelectTrigger className="h-8 w-full gap-2 border-none bg-transparent px-2 text-sm shadow-none hover:bg-muted/50 justify-start">
                      <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className={cn(!action.cycle_id && 'text-muted-foreground')}>
                        {action.cycle_name || 'Add to cycle'}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <RefreshCw className="h-3.5 w-3.5" /> No cycle
                        </div>
                      </SelectItem>
                      {teamCycles.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <div className="flex items-center gap-2">
                            <RefreshCw className="h-3.5 w-3.5" />
                            {c.name}
                            <Badge variant="outline" className="ml-1 px-1 py-0 text-[9px]">{c.status}</Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                </>
                )}

                {/* Labels — part of Properties rather than its own group */}
                {(action.labels?.length ?? 0) > 0 && (
                  <div className="space-y-1 px-2">
                    {(action.labels ?? []).map((l) => (
                      <div key={l.id} className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                        <span className="min-w-0 flex-1 truncate">{l.name}</span>
                        <button onClick={() => toggleLabel(l.id, true)} className="ml-auto shrink-0 text-muted-foreground hover:text-foreground">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
                      <Tag className="h-4 w-4 shrink-0" />
                      <span>Add label</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-2" align="start">
                    <LabelPickerContent
                      grouped={scopedLabelsGrouped}
                      selectedIds={(action.labels ?? []).map((l) => l.id)}
                      onToggle={(id, isAttached) => toggleLabel(id, isAttached)}
                    />
                  </PopoverContent>
                </Popover>

                {/* Attachments — a property row, like Participants */}
                <AttachmentsCarousel
                  variant="row"
                  actionId={actionId}
                  refreshKey={attachmentRefreshKey}
                  onAddClick={handleAddAttachment}
                  uploading={uploading}
                />

                {/* Project — a property row rather than its own group. The
                    milestone below stays nested under it: it is scoped to the
                    selected project, not a sibling property. */}
                <ProjectPanelField
                  value={action.project_id}
                  projects={projectOptions}
                  onChange={(v) => patchAction({ project_id: v, milestone_id: null })}
                  placeholder="Set project"
                  onOpen={onOpenEntity && ((id, name, e) => onOpenEntity('project', id, name, e))}
                />

                {/* Milestone (only when project selected) */}
                {action.project_id && (
                  <div className="ml-4 border-l pl-2">
                    <Select
                      value={action.milestone_id || '_none'}
                      onValueChange={(v) => patchAction({ milestone_id: v === '_none' ? null : v })}
                    >
                      <SelectTrigger className="h-8 w-full gap-2 border-none bg-transparent px-2 text-sm shadow-none hover:bg-muted/50 justify-start">
                        <Milestone className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className={cn(!action.milestone_id && 'text-muted-foreground')}>
                          {action.milestone_name || 'Set milestone'}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Milestone className="h-3.5 w-3.5" /> No milestone
                          </div>
                        </SelectItem>
                        {projectMilestones.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            <div className="flex items-center gap-2">
                              <Milestone className="h-3.5 w-3.5" /> {m.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Links — a property row, like Attachments: a count that
                    expands to the list plus the paste-URL input. */}
                <div>
                  <button
                    onClick={() => setLinksExpanded((v) => !v)}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                  >
                    <LinkIcon className="h-4 w-4 shrink-0" />
                    <span>
                      {(action.links || []).length === 0
                        ? 'Add link'
                        : `${(action.links || []).length} ${(action.links || []).length === 1 ? 'link' : 'links'}`}
                    </span>
                    {linksExpanded ? (
                      <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronRight className="ml-auto h-3 w-3 shrink-0" />
                    )}
                  </button>
                  {linksExpanded && (
                    <div className="pb-1">
                      {(action.links || []).length > 0 && (
                        <div className="space-y-0.5 px-1">
                          {(action.links || []).map((link, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs group hover:bg-muted/50"
                            >
                              <LinkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <a
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-w-0 flex-1 truncate text-blue-500 hover:underline"
                              >
                                {link.title || extractDomain(link.url)}
                              </a>
                              <button
                                onClick={() => handleRemoveLink(i)}
                                className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mt-0.5 flex items-center gap-1.5 px-2">
                        <Input
                          value={newLinkUrl}
                          onChange={(e) => setNewLinkUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddLink()
                          }}
                          placeholder="Paste URL..."
                          className="h-7 flex-1 text-xs"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={handleAddLink}
                          disabled={!newLinkUrl.trim()}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Documents — a property row, like Links: a count that expands
                    to the linked docs, with the picker as its own row. */}
                {linkedDocs.length > 0 && (
                  <div>
                    <button
                      onClick={() => setDocsExpanded((v) => !v)}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                    >
                      <FileText className="h-4 w-4 shrink-0" />
                      <span>
                        {linkedDocs.length} {linkedDocs.length === 1 ? 'document' : 'documents'}
                      </span>
                      {docsExpanded ? (
                        <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronRight className="ml-auto h-3 w-3 shrink-0" />
                      )}
                    </button>
                    {docsExpanded && (
                      <div className="space-y-0.5 px-1 pb-1">
                        {linkedDocs.map((doc) => (
                          <div
                            key={doc.link_id}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs group hover:bg-muted/50"
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="select-text min-w-0 flex-1 truncate">{doc.title}</span>
                            <button
                              onClick={() => handleUnlinkDocument(doc.link_id)}
                              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <DocumentSearchPicker
                  open={docSearchOpen}
                  onOpenChange={setDocSearchOpen}
                  documents={allDocuments.filter((d) => !linkedDocs.some((ld) => ld.id === d.id))}
                  onSelect={handleLinkDocument}
                />

                {/* Repository (inherited from project) — a read-only row: it
                    follows the project, so there is nothing to set here. */}
                {projectRepo?.github_repo && (
                  <a
                    href={`https://github.com/${projectRepo.github_repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50"
                  >
                    <SiGithub className="h-4 w-4 shrink-0 text-black dark:text-white" />
                    <span className="min-w-0 flex-1 truncate">{projectRepo.github_repo}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </a>
                )}

                {/* Pull requests — a property row, like Links: a count that
                    expands to the PRs plus the paste-URL input. */}
                <div>
                  <button
                    onClick={() => setPrsExpanded((v) => !v)}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                  >
                    <GitPullRequest className="h-4 w-4 shrink-0" />
                    <span>
                      {linkedPrs.length === 0
                        ? 'Link pull request'
                        : `${linkedPrs.length} ${linkedPrs.length === 1 ? 'pull request' : 'pull requests'}`}
                    </span>
                    {prsExpanded ? (
                      <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronRight className="ml-auto h-3 w-3 shrink-0" />
                    )}
                  </button>
                  {prsExpanded && (
                    <div className="pb-1">
                      {linkedPrs.length > 0 && (
                        <div className="space-y-0.5 px-1">
                          {linkedPrs.map((pr) => (
                            <div
                              key={pr.id}
                              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs group hover:bg-muted/50"
                            >
                              <PrStatusIcon state={pr.pr_state} draft={pr.pr_draft} />
                              <a
                                href={pr.pr_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-w-0 flex-1 truncate hover:underline"
                              >
                                <span className="font-mono text-muted-foreground">
                                  {pr.repo_full_name}#{pr.pr_number}
                                </span>
                                {pr.pr_title && (
                                  <span className="ml-1.5">{pr.pr_title}</span>
                                )}
                              </a>
                              <button
                                onClick={() => handleUnlinkPr(pr.id)}
                                className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {prError && (
                        <p className="px-2 text-xs text-red-500">{prError}</p>
                      )}
                      <div className="mt-0.5 flex items-center gap-1.5 px-2">
                        <Input
                          value={newPrUrl}
                          onChange={(e) => { setNewPrUrl(e.target.value); setPrError('') }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleLinkPr()
                          }}
                          placeholder="Paste PR URL..."
                          className="h-7 flex-1 text-xs"
                          disabled={linkingPr}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={handleLinkPr}
                          disabled={!newPrUrl.trim() || linkingPr}
                        >
                          {linkingPr ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Plus className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </PropertyGroup>

              {/* PUSH TO {PROVIDER} — inline compose, where the properties are.
                  Not a permanent section: the group's TITLE and border appear
                  only while composing, so a workspace with no tracker still
                  carries no dead block here and a second provider still costs no
                  new section (that was the point of retiring the old per-provider
                  "Asana" block). The HOST div underneath is always mounted and
                  empty — the portal needs a live node to target on the very
                  render that compose begins, and a host that appeared with the
                  group would be one render too late.

                  Keep the host through Activity's hide/show cycle. The form is
                  owned by the toolbar, so clearing its portal target while
                  switching windows would discard the user's draft. The whole
                  owner unmounts when this action is closed. */}
              {composeProviderName && (
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  Push to {composeProviderName}
                </p>
              )}
              <div
                ref={(node) => { if (node) setComposeHost(node) }}
                data-compose-sidebar-host=""
                className={cn(composeProviderName && 'rounded-lg border border-border p-3')}
              />

              {/* Attachment picker — opened by the Attachments row in Properties */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT_ATTR}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    handleFileUpload(Array.from(e.target.files))
                    e.target.value = ''
                  }
                }}
              />
              {uploadError && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <X className="h-3.5 w-3.5 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
              <ReferencedIn entityType="action" entityId={actionId} />
              <RecordHistory entityType="action" entityId={actionId} />
            </div>
          </WindowProperties>
      )}
      </div>
      </ContentTransition>

      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{action?.title || 'Untitled'}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this action item. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (deleting) return
                setDeleting(true)
                const res = await fetch(`/api/account/actions/${actionId}`, { method: 'DELETE' })
                if (res.ok) {
                  deleteActionCache(actionId)
                  emitEntityDeleted({ entityType: 'action', id: actionId })
                  setDeleteConfirm(false)
                  onClose()
                }
                setDeleting(false)
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function formatDate(date: Date, allDay: boolean) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today.getTime() + 86400000)
  const dateOnly = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  )

  let dateStr: string
  if (dateOnly.getTime() === today.getTime()) dateStr = 'Today'
  else if (dateOnly.getTime() === tomorrow.getTime()) dateStr = 'Tomorrow'
  else
    dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })

  if (allDay) return dateStr
  return `${dateStr}, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${diffYears}y ago`
}

/** PR status badge with colored icon */
function PrStatusIcon({ state, draft }: { state: string; draft: boolean }) {
  if (draft) {
    return (
      <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    )
  }
  switch (state) {
    case 'merged':
      return (
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-purple-500" />
      )
    case 'closed':
      return (
        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
      )
    case 'open':
    default:
      return (
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-green-500" />
      )
  }
}

function extractDomain(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
