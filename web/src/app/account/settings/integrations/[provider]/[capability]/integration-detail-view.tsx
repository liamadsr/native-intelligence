'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSettingsNavigate } from '../../../settings-shell'
import {
  ArrowLeft, Loader2, Pencil, Check, Star, Trash2, Plus, ChevronDown, X, AlertTriangle,
} from 'lucide-react'
import { getIntegration } from '@/lib/integrations/catalog'
import { getBrandIcon, getCapabilityIcon } from '@/lib/integrations/catalog-icons'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConnectProvider } from '@/lib/integrations/use-connect-provider'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  isCanceledStatusName,
  jiraCategoryForBucket,
  LIFECYCLE_BUCKETS,
  type LifecycleBucket,
} from '@/lib/tasks/lifecycle'
import { notifyTaskDestinationsChanged } from '@/lib/tasks/destinations-events'
import { toast } from 'sonner'
import { useDestinationPicker } from './use-destination-picker'
import {
  PickerLoadError,
  ReconnectBanner,
  SearchableOptionList,
} from './destination-picker-slots'
import { AsanaSectionMap, JiraStatusMap, LinearStateMap } from './bucket-maps'
import { WebsiteSection } from './website-section'

interface ConnectedAccount {
  id: string
  provider: 'google' | 'microsoft' | 'github' | 'hubspot' | 'asana' | 'jira' | 'linear'
  capability: 'email' | 'calendar' | 'github' | 'crm' | 'tasks'
  account_email: string
  display_name: string | null
  color: string
  is_enabled: boolean
  is_primary: boolean
  sync_status?: string | null
  last_sync_at?: string | null
  last_sync_error?: string | null
  workspace_ids: string[]
  scopes?: string[]
}

// HubSpot meeting-logging writeback needs this scope; a connection made before
// it was added to the requested set will lack it until the user reconnects.
const HUBSPOT_WRITE_SCOPE = 'crm.objects.contacts.write'

interface Workspace {
  id: string
  name: string
}

/**
 * First-run section guesses, matched case-insensitively against each Asana
 * section name. Applied ONLY when the workspace has never saved a section map —
 * once the user has chosen (including choosing "Don't move"), their map wins
 * forever and is never re-guessed.
 *
 * These are PREFILL ONLY. A guess is never written to the server as if the user
 * had picked it: saving one bucket sends the SAVED map plus that bucket, so the
 * other three stay unset until they're chosen too.
 */
const BUCKET_NAME_HINTS: Record<LifecycleBucket, RegExp> = {
  not_started: /(to ?do|backlog)/i,
  in_progress: /(in progress|doing)/i,
  done: /(done|complete)/i,
  canceled: /cancel/i,
}

/** Every bucket explicitly "don't move" — what a project switch resets to. */
function emptySectionMap(): Record<LifecycleBucket, string | null> {
  return { not_started: null, in_progress: null, done: null, canceled: null }
}

/**
 * Radix Select rejects an empty-string item value, so "leave the task where it
 * is" needs a sentinel. It never leaves this file — the PATCH sends null.
 */
const NO_SECTION = '__none__'

interface AsanaPickerOption {
  gid: string
  name: string
}

interface AsanaDestinationConfig {
  asana_workspace_gid?: string
  asana_workspace_name?: string
  project_gid?: string
  project_name?: string
  section_map?: Partial<Record<LifecycleBucket, string | null>>
  /** Absent = true. See `includesAsanaAttribution` in asana-config.ts. */
  include_dial8_attribution?: boolean
}

/**
 * What the settings PATCH accepts. `{ project_gid: null }` on its own is the
 * route's explicit "clear the destination" shape — not a partial config, which
 * is why it can't be expressed by AsanaDestinationConfig.
 */
type AsanaConfigPatch = AsanaDestinationConfig | { project_gid: null }

// ---------------------------------------------------------------------------
// Jira destination picker
//
// Shares the PLUMBING with its two siblings (useDestinationPicker: the picker
// classifier, the retry triad, the settings load, the save funnel) and nothing
// above it. The shapes still differ — a site to address calls to, an issue type
// with no Asana or Linear analogue, statuses whose "unmapped" means something
// else entirely — so the cascade effects, derived ids and the status map stay
// right here, per provider.
// ---------------------------------------------------------------------------

/**
 * Radix Select rejects an empty-string item value, so "let Native Intelligence choose" needs a
 * sentinel. It never leaves this file — the PATCH sends null.
 *
 * NOT the same meaning as Asana's NO_SECTION ("don't move the task"). An
 * unmapped Jira bucket still transitions the issue; it just picks the target by
 * statusCategory instead of by an id the user chose.
 */
const AUTO_STATUS = '__auto__'

interface JiraSiteOption {
  id: string
  name: string | null
  url: string | null
}

interface JiraProjectOption {
  id: string
  key: string
  name: string
}

interface JiraNamedOption {
  id: string
  name: string
}

interface JiraStatusOption {
  id: string
  name: string
  /** statusCategory key: 'new' | 'indeterminate' | 'done'. */
  category: string | null
}

interface JiraDestinationConfig {
  cloud_id?: string
  site_name?: string
  /** null = this site reports no browsable url; the API stores no permalink. */
  site_url?: string | null
  project_id?: string
  project_key?: string
  project_name?: string
  issue_type_id?: string
  issue_type_name?: string
  status_map?: Partial<Record<LifecycleBucket, string | null>>
  /** Absent = true. See `includesJiraAttribution` in jira-config.ts. */
  include_dial8_attribution?: boolean
}

/**
 * What the settings PATCH accepts. `{ project_id: null }` on its own is the
 * route's explicit "clear the destination" shape — not a partial config.
 */
type JiraConfigPatch = JiraDestinationConfig | { project_id: null }

// ---------------------------------------------------------------------------
// Linear destination picker
//
// The third section, and the one that supplied the rule-of-three extraction its
// deciding example: it is where the shared plumbing needed its only two
// options (`adoptResponseConfig` and `reconnectOnSaveFailure`, both off for the
// other two — see useDestinationPicker).
//
// This one is the SIMPLEST of the three, and that is a fact about Linear rather
// than a shortcut. There is no site to pick (a token belongs to exactly one
// organization), no issue type (the concept doesn't exist), and — the part worth
// pausing on — NO bucket→state mapping UI. `WorkflowState.type` is a stable
// seven-value enum, so the mapping is a FACT about the chosen team rather than a
// preference: the server derives it at save time and this view shows the result
// read-only, warning where a bucket came out empty.
// ---------------------------------------------------------------------------

/**
 * Radix Select rejects an empty-string item value, so "push to the team, not a
 * project" needs a sentinel. It never leaves this file — the PATCH sends
 * `{ project_id: null }`, the route's explicit project-clear shape.
 *
 * NOT the same meaning as Asana's NO_SECTION or Jira's AUTO_STATUS: this one
 * names a complete, ordinary destination. A Linear issue belongs to a team and
 * may have no project at all.
 */
const NO_LINEAR_PROJECT = '__no_project__'

interface LinearTeamOption {
  id: string
  key: string | null
  name: string
}

interface LinearProjectOption {
  id: string
  name: string
}

/** One entry of the server-derived bucket→state map. */
interface LinearStateRef {
  id: string
  name: string
}

interface LinearDestinationConfig {
  organization_id?: string
  organization_name?: string
  team_id?: string
  team_key?: string
  team_name?: string
  /** OPTIONAL — a Linear issue may live directly under its team. */
  project_id?: string
  project_name?: string
  /** DERIVED server-side. A bucket the team cannot express is ABSENT. */
  state_map?: Partial<Record<LifecycleBucket, LinearStateRef>>
  /** Absent = true. See `includesLinearAttribution` in linear-config.ts. */
  include_dial8_attribution?: boolean
}

/**
 * What the settings PATCH accepts.
 *
 * TWO explicit clear shapes rather than Asana's and Jira's one, because Linear
 * has two things to remove: `{ team_id: null }` tears the destination down, and
 * `{ project_id: null }` drops only the optional refinement ("push to the team,
 * not a project") while keeping the team. `state_map` is deliberately absent —
 * the route REJECTS it as a PATCH key and derives it itself.
 */
type LinearConfigPatch =
  | Omit<LinearDestinationConfig, 'state_map'>
  | { team_id: null }
  | { project_id: null }

export function IntegrationDetailView({
  provider,
  capability,
  name,
  description,
}: {
  provider: string
  capability: string
  name: string
  description: string
}) {
  const router = useRouter()
  const settingsNavigate = useSettingsNavigate()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null)
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editNameValue, setEditNameValue] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [savingWorkspaces, setSavingWorkspaces] = useState<string | null>(null)
  // HubSpot-only: per-workspace meeting logging, on unless the workspace turned
  // it off (the route answers the effective value; absent = on).
  const [logMeetings, setLogMeetings] = useState<boolean | null>(null)
  const [savingLogMeetings, setSavingLogMeetings] = useState(false)
  // HubSpot-only: per-workspace contact-push opt-in.
  const [pushContacts, setPushContacts] = useState<boolean | null>(null)
  const [savingPushContacts, setSavingPushContacts] = useState(false)
  // HubSpot-only: which contacts push when the toggle is on ('manual' | 'all').
  const [pushScope, setPushScope] = useState<'manual' | 'all' | null>(null)
  const [savingPushScope, setSavingPushScope] = useState(false)
  // Asana-only: the per-workspace push destination (Asana workspace → project →
  // lifecycle-bucket section map). The config/saving/error/reconnect/retry
  // machinery lives in useDestinationPicker below; these are the picker OPTIONS
  // and the local browse state, which are per-provider.
  const [asanaWorkspaces, setAsanaWorkspaces] = useState<AsanaPickerOption[]>([])
  const [asanaProjects, setAsanaProjects] = useState<AsanaPickerOption[]>([])
  const [asanaSections, setAsanaSections] = useState<AsanaPickerOption[]>([])
  const [workspaceChoice, setWorkspaceChoice] = useState<string | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const [loadingProjects, setLoadingProjects] = useState(false)
  // Jira-only: the per-workspace push destination (site → project → issue type
  // → lifecycle-bucket status map). Same state shape as Asana's above, one step
  // longer because a Jira create needs an issue type.
  const [jiraSites, setJiraSites] = useState<JiraSiteOption[]>([])
  const [jiraProjects, setJiraProjects] = useState<JiraProjectOption[]>([])
  const [jiraIssueTypes, setJiraIssueTypes] = useState<JiraNamedOption[]>([])
  const [jiraStatuses, setJiraStatuses] = useState<JiraStatusOption[]>([])
  const [siteChoice, setSiteChoice] = useState<string | null>(null)
  const [jiraProjectQuery, setJiraProjectQuery] = useState('')
  const [loadingJiraProjects, setLoadingJiraProjects] = useState(false)
  // Linear-only: the per-workspace push destination (team → optional project),
  // plus the state map the SERVER derived for the chosen team. Two steps shorter
  // than Jira's — there is no site and no issue type — and the state map is
  // display-only, so it has no picker state of its own.
  const [linearTeams, setLinearTeams] = useState<LinearTeamOption[]>([])
  const [linearProjects, setLinearProjects] = useState<LinearProjectOption[]>([])
  const [loadingLinearProjects, setLoadingLinearProjects] = useState(false)
  /**
   * The connected Linear organization, learned from the teams call and stashed
   * for the destination save.
   *
   * A ref rather than state because nothing renders it: it is a fact about the
   * connection that travels with the team so the webhook read-back can
   * sanity-check deliveries against it. Holding it in state would re-render the
   * whole view for a value no pixel depends on.
   */
  const linearOrgRef = useRef<{ id: string; name: string } | null>(null)

  const isHubspotCrm = provider === 'hubspot' && capability === 'crm'
  const isAsanaTasks = provider === 'asana' && capability === 'tasks'
  const isJiraTasks = provider === 'jira' && capability === 'tasks'
  const isLinearTasks = provider === 'linear' && capability === 'tasks'
  // A connection missing the write scope can't log meetings until reconnected.
  const needsReconnect =
    isHubspotCrm &&
    accounts.length > 0 &&
    accounts.some((a) => !(a.scopes ?? []).includes(HUBSPOT_WRITE_SCOPE))

  // ---- the shared destination-picker plumbing, once per provider -----------
  //
  // Each instance owns that provider's saved config, its save funnel, and the
  // reconnect/load-error/retry triad. Everything BELOW the top-level picker —
  // the cascade effects, the derived ids, the bucket map — stays per-provider
  // further down, because those are where the three genuinely differ.

  const onAsanaWorkspacesLoad = useCallback((data: Record<string, unknown>) => {
    setAsanaWorkspaces((data.workspaces ?? []) as AsanaPickerOption[])
  }, [])
  const asana = useDestinationPicker<AsanaDestinationConfig, AsanaConfigPatch>({
    enabled: isAsanaTasks,
    settingsUrl: '/api/account/workspace/asana-settings',
    settingsLabel: 'your Asana settings',
    saveErrorMessage: 'Failed to save Asana settings',
    firstPicker: {
      url: '/api/account/asana/workspaces',
      label: 'your Asana workspaces',
      onLoad: onAsanaWorkspacesLoad,
    },
  })
  // Destructured for the cascade effects below, which list them as deps: both
  // are stable across renders, so the effects re-run only on retry.
  const asanaConfig = asana.config
  const { readPicker: asanaReadPicker, setLoadError: asanaSetLoadError, retryKey: asanaRetryKey } = asana

  const onJiraSitesLoad = useCallback((data: Record<string, unknown>) => {
    setJiraSites((data.sites ?? []) as JiraSiteOption[])
  }, [])
  const jira = useDestinationPicker<JiraDestinationConfig, JiraConfigPatch>({
    enabled: isJiraTasks,
    settingsUrl: '/api/account/workspace/jira-settings',
    settingsLabel: 'your Jira settings',
    saveErrorMessage: 'Failed to save Jira settings',
    firstPicker: {
      url: '/api/account/jira/sites',
      label: 'your Atlassian sites',
      onLoad: onJiraSitesLoad,
    },
  })
  const jiraConfig = jira.config
  const { readPicker: jiraReadPicker, setLoadError: jiraSetLoadError, retryKey: jiraRetryKey } = jira

  const onLinearTeamsLoad = useCallback((data: Record<string, unknown>) => {
    setLinearTeams((data.teams ?? []) as LinearTeamOption[])
    // Stashed so the destination save can persist it without a second
    // round trip. Not rendered anywhere.
    const org = data.organization as { id?: string; name?: string } | null
    if (org?.id) linearOrgRef.current = { id: org.id, name: org.name ?? org.id }
  }, [])
  const linear = useDestinationPicker<LinearDestinationConfig, LinearConfigPatch>({
    enabled: isLinearTasks,
    settingsUrl: '/api/account/workspace/linear-settings',
    settingsLabel: 'your Linear settings',
    saveErrorMessage: 'Failed to save Linear settings',
    firstPicker: {
      url: '/api/account/linear/teams',
      label: 'your Linear teams',
      onLoad: onLinearTeamsLoad,
    },
    // The two Linear-only divergences in the shared funnel. Both are OFF for
    // Asana and Jira and must stay off: only Linear's route derives state
    // server-side, so only its PATCH echoes a config worth adopting and only
    // its PATCH can answer `reconnect_required`.
    adoptResponseConfig: true,
    reconnectOnSaveFailure: true,
  })
  const linearConfig = linear.config
  const { readPicker: linearReadPicker, setLoadError: linearSetLoadError, retryKey: linearRetryKey } =
    linear

  // Icon + tint come from the shared catalog. The brand mark wins when the pair
  // has one; the tinted lucide icon is the fallback. 'text-blue-500' is the
  // historical default for a pair with no catalog entry (the route 404s before
  // reaching here, so it is unreachable in practice).
  const Icon = getCapabilityIcon(capability)
  const iconColor = getIntegration(provider, capability)?.iconColor ?? 'text-blue-500'
  const BrandIcon = getBrandIcon(provider, capability)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/oauth/status')
      if (res.ok) {
        const data = await res.json()
        const filtered = (data.accounts || []).filter(
          (a: ConnectedAccount) => a.provider === provider && a.capability === capability,
        )
        setAccounts(filtered)
      }
    } catch {
      // silently fail
    } finally {
      setIsLoading(false)
    }
  }, [provider, capability])

  useEffect(() => {
    fetchStatus()
    // Fetch user's workspaces for the workspace selector
    fetch('/api/account/workspace/list')
      .then((r) => r.ok ? r.json() : { workspaces: [] })
      .then((data) => setWorkspaces(data.workspaces || []))
      .catch(() => {})
  }, [fetchStatus])

  /**
   * Coming back from an OAuth connect that happened somewhere ELSE.
   *
   * The connect runs in a popup (web) or the system browser (desktop), so this
   * tab stays alive the whole time and nothing resets when the user switches
   * back — a newly connected tracker would sit behind a cached "not connected"
   * answer. `useConnectProvider`'s return covers a connect started HERE; focus
   * covers one finished anywhere else.
   *
   * Cheaper than it looks: this fires only while a tasks integration's settings
   * page is mounted, and the invalidation itself makes no request — the next
   * menu open does.
   */
  useEffect(() => {
    if (capability !== 'tasks') return
    const onFocus = () => {
      fetchStatus()
      notifyTaskDestinationsChanged()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [capability, fetchStatus])

  // HubSpot-only: load the current workspace's writeback settings. Meeting
  // logging is on by default, so a failed read leaves its switch unknown
  // (null, disabled) rather than showing it off; contact push is opt-in, so
  // off is the honest fallback there.
  useEffect(() => {
    if (!isHubspotCrm) return
    fetch('/api/account/workspace/hubspot-settings')
      .then((r) => {
        if (!r.ok) throw new Error(`hubspot-settings ${r.status}`)
        return r.json()
      })
      .then((data) => {
        setLogMeetings(data.log_meetings_to_hubspot === true)
        setPushContacts(data.push_contacts_to_hubspot === true)
        setPushScope(data.push_contacts_scope === 'all' ? 'all' : 'manual')
      })
      .catch(() => {
        setLogMeetings(null)
        setPushContacts(false)
        setPushScope('manual')
      })
  }, [isHubspotCrm])

  const handleToggleLogMeetings = async () => {
    if (logMeetings === null) return
    const next = !logMeetings
    // Optimistic update, revert on failure.
    setLogMeetings(next)
    setSavingLogMeetings(true)
    try {
      const res = await fetch('/api/account/workspace/hubspot-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_meetings_to_hubspot: next }),
      })
      if (!res.ok) setLogMeetings(!next)
    } catch {
      setLogMeetings(!next)
    } finally {
      setSavingLogMeetings(false)
    }
  }

  const handleTogglePushContacts = async () => {
    if (pushContacts === null) return
    const next = !pushContacts
    // Optimistic update, revert on failure.
    setPushContacts(next)
    setSavingPushContacts(true)
    try {
      const res = await fetch('/api/account/workspace/hubspot-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push_contacts_to_hubspot: next }),
      })
      if (!res.ok) setPushContacts(!next)
    } catch {
      setPushContacts(!next)
    } finally {
      setSavingPushContacts(false)
    }
  }

  const handleChangePushScope = async (next: 'manual' | 'all') => {
    if (pushScope === null || next === pushScope) return
    const prev = pushScope
    // Optimistic update, revert on failure.
    setPushScope(next)
    setSavingPushScope(true)
    try {
      const res = await fetch('/api/account/workspace/hubspot-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push_contacts_scope: next }),
      })
      if (!res.ok) setPushScope(prev)
    } catch {
      setPushScope(prev)
    } finally {
      setSavingPushScope(false)
    }
  }

  // The Asana workspace is a LOCAL choice until a project is picked: the API
  // rejects a half-written destination (all four fields travel together), so
  // switching workspaces browses without committing anything.
  const asanaWorkspaceGid = workspaceChoice ?? asanaConfig?.asana_workspace_gid ?? null
  const asanaProjectGid = asanaConfig?.project_gid ?? null

  // Asana speaks `gid`; the shared list widget speaks `id`. Asana projects carry
  // no key, so no leading mono span is rendered — that one is Jira's.
  const asanaProjectOptions = useMemo(
    () => asanaProjects.map((p) => ({ id: p.gid, name: p.name })),
    [asanaProjects],
  )

  // Project list for the chosen Asana workspace. Re-runs on every keystroke of
  // the search box: with a query it hits Asana's recency-ordered typeahead,
  // without one it shows the first page so the list is never empty on open.
  useEffect(() => {
    if (!isAsanaTasks || !asanaWorkspaceGid) {
      setAsanaProjects([])
      return
    }
    let cancelled = false
    setLoadingProjects(true)
    const params = new URLSearchParams({ workspace: asanaWorkspaceGid })
    if (projectQuery.trim()) params.set('query', projectQuery.trim())
    fetch(`/api/account/asana/projects?${params.toString()}`)
      .then((r) => asanaReadPicker(r, 'Asana projects', () => cancelled))
      .then((data) => {
        if (!cancelled && data) setAsanaProjects((data.projects ?? []) as AsanaPickerOption[])
      })
      .catch(() => {
        if (!cancelled) asanaSetLoadError("Couldn't load Asana projects.")
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAsanaTasks, asanaWorkspaceGid, projectQuery, asanaRetryKey, asanaReadPicker, asanaSetLoadError])

  // Sections of the chosen project — the options for the four bucket dropdowns.
  useEffect(() => {
    if (!isAsanaTasks || !asanaProjectGid) {
      setAsanaSections([])
      return
    }
    let cancelled = false
    fetch(`/api/account/asana/sections?project=${encodeURIComponent(asanaProjectGid)}`)
      .then((r) => asanaReadPicker(r, 'the project’s sections', () => cancelled))
      .then((data) => {
        if (!cancelled && data) setAsanaSections((data.sections ?? []) as AsanaPickerOption[])
      })
      .catch(() => {
        if (!cancelled) asanaSetLoadError("Couldn't load the project’s sections.")
      })
    return () => {
      cancelled = true
    }
  }, [isAsanaTasks, asanaProjectGid, asanaRetryKey, asanaReadPicker, asanaSetLoadError])

  /**
   * The section map the four dropdowns render.
   *
   * A saved map always wins — including the parts of it the user set to
   * "Don't move". Only a workspace that has NEVER saved one falls back to the
   * name heuristics, so a deliberate choice is never silently re-guessed on the
   * next visit.
   *
   * DISPLAY ONLY. The guessed values prefill the dropdowns so the common project
   * layout needs no work, but they are not the user's choices and are never sent
   * to the server — handleSelectAsanaSection patches the SAVED map, not this one.
   */
  const effectiveSectionMap = useMemo<Partial<Record<LifecycleBucket, string | null>>>(() => {
    const saved = asanaConfig?.section_map
    if (saved) return saved
    const guessed: Partial<Record<LifecycleBucket, string | null>> = {}
    for (const bucket of LIFECYCLE_BUCKETS) {
      const match = asanaSections.find((s) => BUCKET_NAME_HINTS[bucket].test(s.name))
      guessed[bucket] = match?.gid ?? null
    }
    return guessed
  }, [asanaConfig?.section_map, asanaSections])

  /**
   * PATCH the destination with optimistic UI + revert — the shared funnel (see
   * useDestinationPicker), with neither Linear-only option enabled: Asana's
   * route stores exactly what it is sent, so there is no echoed config worth
   * adopting, and its PATCH never answers `reconnect_required`, so a save
   * failure is always the inline error.
   */
  const saveAsanaConfig = asana.save

  const handleSelectAsanaProject = async (projectGid: string) => {
    const project = asanaProjects.find((p) => p.gid === projectGid)
    const workspace = asanaWorkspaces.find((w) => w.gid === asanaWorkspaceGid)
    if (!project || !workspace) return
    const projectChanged = project.gid !== (asanaConfig?.project_gid ?? null)
    // All four destination fields travel together — the API rejects a partial
    // destination, and a project without its workspace can't be re-validated.
    await saveAsanaConfig({
      project_gid: project.gid,
      project_name: project.name,
      asana_workspace_gid: workspace.gid,
      asana_workspace_name: workspace.name,
      // Section gids belong to the project they came from. On a switch, clear
      // the map explicitly rather than letting the server's read-modify-write
      // carry the old project's gids onto the new one, where they resolve to
      // nothing. (The route enforces this too — this keeps the optimistic local
      // state honest as well.)
      ...(projectChanged ? { section_map: emptySectionMap() } : {}),
    })
  }

  /**
   * Stop pushing anywhere. `{ project_gid: null }` alone is the route's explicit
   * clear shape — every other PATCH merges, so sending an empty destination
   * would simply keep the old one.
   */
  const handleClearAsanaDestination = async () => {
    // The server drops all four destination fields and resets the map, so the
    // optimistic state is that config, not a merge over the current one.
    //
    // DELIBERATELY ASYMMETRIC with the Jira and Linear clears, which build their
    // optimistic config by spreading the current one and DELETING keys. This one
    // passes a bare replacement, so it also drops asana_workspace_gid/_name from
    // local state — the workspace select keeps its value only because
    // `workspaceChoice` (the local browse state) survives. Nothing currently
    // tests that difference, so making the three "consistent" here would be an
    // untested behaviour change smuggled into a refactor. Left exactly as it
    // shipped; deciding what SHOULD happen is a separate, deliberate change.
    await saveAsanaConfig({ project_gid: null }, { section_map: emptySectionMap() })
  }

  /**
   * Toggle Native Intelligence's attribution on pushed Asana tasks.
   *
   * Provider-level, so it is NOT gated on a destination being picked — a user
   * can decide "don't brand my tasks" before ever choosing a project. Absent
   * reads as true (the server's default), which is why the checked state tests
   * `!== false` rather than truthiness. Reuses saveAsanaConfig, so it inherits
   * the same optimistic-update-and-revert-on-error behaviour as every other
   * control in this section.
   */
  const handleToggleAsanaAttribution = async (next: boolean) => {
    await saveAsanaConfig({ include_dial8_attribution: next })
  }

  const handleSelectAsanaSection = async (bucket: LifecycleBucket, value: string) => {
    // Build from the SAVED map, never from `effectiveSectionMap` — that one is
    // the DISPLAY map and may be entirely name-heuristic guesses. Spreading it
    // would persist all four buckets as if the user had chosen them, the first
    // time they touch any single dropdown.
    const next: Partial<Record<LifecycleBucket, string | null>> = {
      ...(asanaConfig?.section_map ?? {}),
      [bucket]: value === NO_SECTION ? null : value,
    }
    await saveAsanaConfig({ section_map: next })
  }

  // ---- Jira destination ----------------------------------------------------

  // The site is a LOCAL choice until a project is picked: the API rejects a
  // project whose site isn't set, and all three site fields travel together, so
  // switching sites browses without committing anything.
  const jiraCloudId = siteChoice ?? jiraConfig?.cloud_id ?? null

  /**
   * Is the user browsing a DIFFERENT site from the saved one?
   *
   * Everything below the site — the project, its issue type, its statuses — is
   * addressed by ids that Atlassian mints per-site and starts at the same
   * number on each, so a saved selection is not merely stale on another site,
   * it points at a real but unrelated object there. While a switch is in flight
   * the downstream selections are therefore treated as ABSENT: no project shown
   * as chosen, no issue-type or status-map section, and no picker request built
   * from the new cloudId plus the old project id.
   */
  const jiraSiteSwitched = !!siteChoice && siteChoice !== (jiraConfig?.cloud_id ?? null)
  const jiraProjectId = jiraSiteSwitched ? null : jiraConfig?.project_id ?? null

  // Project list for the chosen site. Re-runs on every keystroke of the search
  // box: `GET /project/search` matches name OR key and returns the first page
  // without a query, so one call covers both browse and search.
  useEffect(() => {
    if (!isJiraTasks || !jiraCloudId) {
      setJiraProjects([])
      return
    }
    let cancelled = false
    setLoadingJiraProjects(true)
    const params = new URLSearchParams({ cloudId: jiraCloudId })
    if (jiraProjectQuery.trim()) params.set('query', jiraProjectQuery.trim())
    fetch(`/api/account/jira/projects?${params.toString()}`)
      .then((r) => jiraReadPicker(r, 'Jira projects', () => cancelled))
      .then((data) => {
        if (!cancelled && data) setJiraProjects((data.projects ?? []) as JiraProjectOption[])
      })
      .catch(() => {
        if (!cancelled) jiraSetLoadError("Couldn't load Jira projects.")
      })
      .finally(() => {
        if (!cancelled) setLoadingJiraProjects(false)
      })
    return () => {
      cancelled = true
    }
  }, [isJiraTasks, jiraCloudId, jiraProjectQuery, jiraRetryKey, jiraReadPicker, jiraSetLoadError])

  // Issue types AND statuses of the chosen project. Both are per-PROJECT (a
  // team-managed project owns its own issue types, and each issue type can carry
  // its own workflow), so they reload together whenever the project moves.
  useEffect(() => {
    if (!isJiraTasks || !jiraCloudId || !jiraProjectId) {
      setJiraIssueTypes([])
      setJiraStatuses([])
      return
    }
    let cancelled = false
    const params = new URLSearchParams({ cloudId: jiraCloudId, projectId: jiraProjectId })

    fetch(`/api/account/jira/issue-types?${params.toString()}`)
      .then((r) => jiraReadPicker(r, 'the project’s issue types', () => cancelled))
      .then((data) => {
        if (!cancelled && data) setJiraIssueTypes((data.issueTypes ?? []) as JiraNamedOption[])
      })
      .catch(() => {
        if (!cancelled) jiraSetLoadError("Couldn't load the project’s issue types.")
      })

    fetch(`/api/account/jira/statuses?${params.toString()}`)
      .then((r) => jiraReadPicker(r, 'the project’s statuses', () => cancelled))
      .then((data) => {
        if (!cancelled && data) setJiraStatuses((data.statuses ?? []) as JiraStatusOption[])
      })
      .catch(() => {
        if (!cancelled) jiraSetLoadError("Couldn't load the project’s statuses.")
      })

    return () => {
      cancelled = true
    }
  }, [isJiraTasks, jiraCloudId, jiraProjectId, jiraRetryKey, jiraReadPicker, jiraSetLoadError])

  /**
   * What the echo would pick for a bucket with NO explicit mapping — shown as a
   * hint beside each "Automatic" dropdown.
   *
   * DISPLAY ONLY, and deliberately not a prefilled selection. Asana's picker
   * pre-selects a guessed section, which is safe there because an unmapped
   * bucket does nothing. Here an unmapped bucket still transitions the issue, by
   * statusCategory — so pre-selecting a guess would show a specific status as
   * "chosen" when nothing is stored and the real fallback might land elsewhere.
   * Naming the fallback instead is honest about both.
   *
   * It mirrors selectTransition's unmapped tiers exactly — same helpers, same
   * order, INCLUDING tier (c)'s exclusion — so the hint cannot drift from the
   * behaviour it describes. It is the fourth consumer of isCanceledStatusName
   * and the only one outside the echo; the exclusion was missed here once, and
   * a project that happened to list "Won't Do" first then told the user Done
   * would land on "Won't Do" while the echo skipped it and picked "Done".
   */
  const automaticStatusName = useCallback(
    (bucket: LifecycleBucket): string | null => {
      const category = jiraCategoryForBucket(bucket)
      const inCategory = jiraStatuses.filter((s) => s.category === category)
      // (b) canceled-by-name.
      if (bucket === 'canceled') {
        const byName = inCategory.find((s) => isCanceledStatusName(s.name))
        if (byName) return byName.name
      }
      // (c) first in category, never landing `done` on a cancellation. Status
      // order is the workflow's own and is arbitrary, so "first" is a real
      // coin-flip between "Done" and "Won't Do" for a great many projects.
      return (
        inCategory.find((s) => !(bucket === 'done' && isCanceledStatusName(s.name)))?.name ?? null
      )
    },
    [jiraStatuses],
  )

  /**
   * PATCH the destination with optimistic UI + revert — the shared funnel (see
   * useDestinationPicker), on the same terms as Asana's: neither Linear-only
   * option enabled. Jira's PATCH stores what it is sent and never answers
   * `reconnect_required`, so a save failure is always the inline error.
   */
  const saveJiraDestination = jira.save

  const handleSelectJiraProject = async (projectId: string) => {
    const project = jiraProjects.find((p) => p.id === projectId)
    const site = jiraSites.find((s) => s.id === jiraCloudId)
    if (!project || !site) return
    const projectChanged = project.id !== (jiraConfig?.project_id ?? null)
    // Comparing the project id ALONE is blind exactly when it matters: project
    // ids are per-site sequences that all start at 10000, so the equivalent
    // project on a different site routinely compares equal while every id below
    // it (issue type, statuses) belongs to the tenant we just left.
    const siteChanged = site.id !== (jiraConfig?.cloud_id ?? null)

    // The site triple travels with the project: the API refuses a project it
    // can't address, and a stored project without its site can't be re-read.
    //
    // `site_url` is sent as NULL when Atlassian didn't report one (the field is
    // documented as best-effort). It exists only to build `/browse/{KEY}`
    // permalinks, and a made-up value — the API gateway origin was the obvious
    // candidate — is written onto every link row and never resolves to
    // anything. No permalink beats a permanently broken one.
    const patch: JiraDestinationConfig = {
      cloud_id: site.id,
      site_name: site.name ?? site.id,
      site_url: site.url?.trim() ? site.url : null,
      project_id: project.id,
      project_key: project.key,
      project_name: project.name,
    }

    if (!projectChanged && !siteChanged) {
      await saveJiraDestination(patch)
      return
    }

    // Status ids belong to the workflow of the project that owns them, and in a
    // team-managed project so do the issue-type ids — and ALL of them belong to
    // the site above that. Clear both explicitly rather than relying on the
    // server's backstop, so the optimistic local state matches what was actually
    // stored. The optimistic config is a REPLACEMENT because it removes the
    // issue-type keys.
    const cleared: JiraDestinationConfig = {
      ...(jiraConfig ?? {}),
      ...patch,
      status_map: { not_started: null, in_progress: null, done: null, canceled: null },
    }
    delete cleared.issue_type_id
    delete cleared.issue_type_name
    await saveJiraDestination(
      { ...patch, status_map: { not_started: null, in_progress: null, done: null, canceled: null } },
      cleared,
    )
  }

  const handleSelectJiraIssueType = async (issueTypeId: string) => {
    const issueType = jiraIssueTypes.find((t) => t.id === issueTypeId)
    if (!issueType) return
    await saveJiraDestination({
      issue_type_id: issueType.id,
      issue_type_name: issueType.name,
    })
  }

  /**
   * Stop pushing anywhere. `{ project_id: null }` alone is the route's explicit
   * clear shape — every other PATCH merges, so sending an empty destination
   * would simply keep the old one.
   */
  const handleClearJiraDestination = async () => {
    // The server drops the project + issue type and resets the map, and KEEPS
    // the site (it is the API address, not the destination), so the optimistic
    // state is that config rather than a merge over the current one.
    const cleared: JiraDestinationConfig = {
      ...(jiraConfig ?? {}),
      status_map: { not_started: null, in_progress: null, done: null, canceled: null },
    }
    delete cleared.project_id
    delete cleared.project_key
    delete cleared.project_name
    delete cleared.issue_type_id
    delete cleared.issue_type_name
    await saveJiraDestination({ project_id: null }, cleared)
  }

  /**
   * Toggle Native Intelligence's attribution on pushed Jira issues. The Asana twin's
   * reasoning applies unchanged: provider-level, ungated on a destination,
   * absent = true.
   */
  const handleToggleJiraAttribution = async (next: boolean) => {
    await saveJiraDestination({ include_dial8_attribution: next })
  }

  const handleSelectJiraStatus = async (bucket: LifecycleBucket, value: string) => {
    // Built from the SAVED map only. There is no guessed display map to confuse
    // it with here (the automatic fallback is shown as a hint, never as a
    // selection), which is exactly why that choice was made.
    const next: Partial<Record<LifecycleBucket, string | null>> = {
      ...(jiraConfig?.status_map ?? {}),
      [bucket]: value === AUTO_STATUS ? null : value,
    }
    await saveJiraDestination({ status_map: next })
  }

  // ---- Linear destination --------------------------------------------------

  const linearTeamId = linearConfig?.team_id ?? null

  // Projects of the chosen team. Scoped THROUGH the team because a project the
  // team can't see is not a legal destination for its issues.
  useEffect(() => {
    if (!isLinearTasks || !linearTeamId) {
      setLinearProjects([])
      return
    }
    let cancelled = false
    setLoadingLinearProjects(true)
    fetch(`/api/account/linear/projects?teamId=${encodeURIComponent(linearTeamId)}`)
      .then((r) => linearReadPicker(r, "the team's projects", () => cancelled))
      .then((data) => {
        if (!cancelled && data) setLinearProjects((data.projects ?? []) as LinearProjectOption[])
      })
      .catch(() => {
        if (!cancelled) linearSetLoadError("Couldn't load the team's projects.")
      })
      .finally(() => {
        if (!cancelled) setLoadingLinearProjects(false)
      })
    return () => {
      cancelled = true
    }
  }, [isLinearTasks, linearTeamId, linearRetryKey, linearReadPicker, linearSetLoadError])

  /**
   * PATCH the destination with optimistic UI + revert — the shared funnel (see
   * useDestinationPicker), and the ONLY one of the three that turns on both of
   * its options, because Linear is the only provider whose route does work on
   * save rather than just storing what it was sent:
   *
   * - `adoptResponseConfig`: the response carries the config the server actually
   *   stored, INCLUDING the `state_map` it just derived. Adopting it is not a
   *   nicety — the map is the one part of this config the client cannot compute,
   *   and it is exactly what the read-only mapping below renders.
   * - `reconnectOnSaveFailure`: a save that could not verify the team's states
   *   comes back as `reconnect_required` and stores NOTHING, so the banner is
   *   the honest surface — retrying will not help. Asana's and Jira's PATCHes
   *   cannot produce that code, which is why they leave this off rather than
   *   enabling it "for consistency".
   */
  const saveLinearDestination = linear.save

  const handleSelectLinearTeam = async (teamId: string) => {
    const team = linearTeams.find((t) => t.id === teamId)
    if (!team) return
    const teamChanged = team.id !== (linearConfig?.team_id ?? null)

    // The org travels with the team: it is a fact about the connection that the
    // webhook read-back sanity-checks deliveries against, and the teams call is
    // the only place it is known.
    const org = linearOrgRef.current
    const patch: LinearDestinationConfig = {
      team_id: team.id,
      team_key: team.key ?? team.id,
      team_name: team.name,
      ...(org ? { organization_id: org.id, organization_name: org.name } : {}),
    }

    if (!teamChanged) {
      await saveLinearDestination(patch)
      return
    }

    // A project belongs to the teams it is shared with, so it cannot survive a
    // team switch. The server drops it too — this keeps the optimistic state
    // honest rather than briefly showing the old team's project under the new
    // team. The state_map is dropped for the same reason and re-derived
    // server-side, which is why the optimistic config omits it entirely rather
    // than carrying a map that describes the team we just left.
    const cleared: LinearDestinationConfig = { ...(linearConfig ?? {}), ...patch }
    delete cleared.project_id
    delete cleared.project_name
    delete cleared.state_map
    await saveLinearDestination(patch, cleared)
  }

  const handleSelectLinearProject = async (projectId: string) => {
    // The sentinel means "push to the team, not a project" — which is a real
    // destination for Linear, not an absence of one.
    if (projectId === NO_LINEAR_PROJECT) {
      const cleared: LinearDestinationConfig = { ...(linearConfig ?? {}) }
      delete cleared.project_id
      delete cleared.project_name
      await saveLinearDestination({ project_id: null }, cleared)
      return
    }
    const project = linearProjects.find((p) => p.id === projectId)
    if (!project) return
    await saveLinearDestination({ project_id: project.id, project_name: project.name })
  }

  /**
   * Stop pushing anywhere. `{ team_id: null }` alone is the route's explicit
   * clear shape — every other PATCH merges, so sending an empty destination
   * would simply keep the old one.
   */
  const handleClearLinearDestination = async () => {
    // The server drops the team, the project and the derived map, and KEEPS the
    // organization (a fact about the connection, not a destination), so the
    // optimistic state is that config rather than a merge over the current one.
    const cleared: LinearDestinationConfig = { ...(linearConfig ?? {}) }
    delete cleared.team_id
    delete cleared.team_key
    delete cleared.team_name
    delete cleared.project_id
    delete cleared.project_name
    delete cleared.state_map
    await saveLinearDestination({ team_id: null }, cleared)
  }

  /**
   * Toggle Native Intelligence's attribution on pushed Linear issues. The Asana and Jira
   * twins' reasoning applies unchanged: provider-level, ungated on a
   * destination, absent = true.
   */
  const handleToggleLinearAttribution = async (next: boolean) => {
    await saveLinearDestination({ include_dial8_attribution: next })
  }

  // Popup on the web (the old full-page redirect reloaded the whole shell),
  // system browser on desktop. A tracker that appeared changes the push menu's
  // destinations, so a return announces that as the focus refetch above does.
  const { connect, connectingId } = useConnectProvider({
    origin: 'settings',
    onReturn: () => {
      fetchStatus()
      if (capability === 'tasks') notifyTaskDestinationsChanged()
    },
  })
  const isConnecting = connectingId === `${provider}-${capability}`
  const handleConnect = () => {
    void connect(provider, capability)
  }

  const handleDisconnect = async () => {
    if (!disconnecting) return
    const accountId = disconnecting.id
    setDisconnectingId(accountId)
    setDisconnecting(null)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      const res = await fetch(
        `/api/oauth/${provider}/disconnect?account_id=${accountId}`,
        { method: 'POST', signal: controller.signal },
      ).finally(() => clearTimeout(timeout))

      if (!res.ok) {
        console.error('Disconnect failed:', await res.text())
        toast.error("Couldn't disconnect the account. Try again.")
      } else {
        // The loops that needed it were switched off rather than left to fail: say which.
        const json = (await res.json().catch(() => ({}))) as { loops_switched_off?: Array<{ name: string }> }
        const off = json.loops_switched_off ?? []
        if (off.length) {
          toast.message(
            `Switched off ${off.length === 1 ? 'a loop' : `${off.length} loops`} that needed it: ${off.map((l) => `"${l.name}"`).join(', ')}. Turn ${off.length === 1 ? 'it' : 'them'} back on after you reconnect.`,
          )
        }
      }
    } catch (err) {
      console.error('Disconnect request failed:', err)
      toast.error("Couldn't disconnect the account. Try again.")
    }
    await fetchStatus()
    // A disconnected tracker leaves the destinations array entirely, so the menu
    // must stop offering it. Announced unconditionally: the request may have
    // failed OR partially succeeded, and re-reading a still-connected provider
    // costs one request, while missing a real disconnect leaves a push that
    // 400s behind a row that looks ready.
    if (capability === 'tasks') notifyTaskDestinationsChanged()
    setDisconnectingId(null)
  }

  const handleSetPrimary = async (accountId: string) => {
    try {
      const res = await fetch(`/api/oauth/${provider}/disconnect`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, is_primary: true }),
      })
      if (!res.ok) toast.error("Couldn't make this the primary account")
      await fetchStatus()
    } catch {
      toast.error("Couldn't make this the primary account")
    }
  }

  const handleSaveDisplayName = async (accountId: string) => {
    if (!editNameValue.trim()) return
    try {
      const res = await fetch('/api/oauth/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, display_name: editNameValue }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchStatus()
    } catch {
      // Keep the editor open with the typed name so it can be retried.
      toast.error("Couldn't rename the account. Try again.")
      return
    }
    setEditingName(null)
  }

  const handleToggleWorkspace = async (accountId: string, workspaceId: string, currentIds: string[]) => {
    const isAssigned = currentIds.includes(workspaceId)
    const newIds = isAssigned
      ? currentIds.filter((id) => id !== workspaceId)
      : [...currentIds, workspaceId]

    // Optimistic update
    setAccounts((prev) =>
      prev.map((a) => a.id === accountId ? { ...a, workspace_ids: newIds } : a),
    )

    setSavingWorkspaces(accountId)
    try {
      const res = await fetch('/api/oauth/account-workspaces', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, workspace_ids: newIds }),
      })
      // fetch resolves on 4xx/5xx: revert those too, not only network errors.
      if (!res.ok) throw new Error(`account-workspaces ${res.status}`)
    } catch {
      // Revert on error
      setAccounts((prev) =>
        prev.map((a) => a.id === accountId ? { ...a, workspace_ids: currentIds } : a),
      )
      toast.error("Couldn't update the account's workspaces")
    } finally {
      setSavingWorkspaces(null)
    }
  }

  const formatSyncTime = (time: string | null | undefined) => {
    if (!time) return null
    const diff = Date.now() - new Date(time).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => settingsNavigate('/account/settings/connectors')}
            aria-label="Back to Connectors"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white dark:bg-zinc-800">
            {BrandIcon ? <BrandIcon className="h-5 w-5" /> : <Icon className={`h-5 w-5 ${iconColor}`} />}
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{name}</h1>
          </div>
          {accounts.length > 0 && (
            <Badge
              variant="outline"
              className="h-7 border-green-500/30 bg-green-500/10 text-green-500"
            >
              {accounts.length} connected
            </Badge>
          )}
        </div>

        <p className="mt-3 text-muted-foreground pl-[52px]">{description}</p>

        {/* Connected accounts */}
        <div className="mt-8 pl-[52px]">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-border p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-3 w-3 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="mt-1.5 h-3 w-48" />
                    </div>
                    <Skeleton className="h-7 w-16" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {accounts.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    Connected Accounts
                  </h3>
                  {accounts.map((account) => {
                    const isEditing = editingName === account.id
                    const isDisconnectingThis = disconnectingId === account.id
                    const syncTime = formatSyncTime(account.last_sync_at)

                    return (
                      <div
                        key={account.id}
                        className="group rounded-lg border border-border px-4 py-3 transition-colors hover:bg-muted/30"
                      >
                      <div className="flex items-center gap-3">
                        <div
                          className="h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: account.color }}
                        />
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <Input
                                value={editNameValue}
                                onChange={(e) => setEditNameValue(e.target.value)}
                                className="h-6 px-1 py-0 text-sm"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleSaveDisplayName(account.id)
                                  if (e.key === 'Escape') setEditingName(null)
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => handleSaveDisplayName(account.id)}
                              >
                                <Check className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium truncate">
                                {account.display_name || account.account_email}
                              </span>
                              <button
                                className="opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => {
                                  setEditingName(account.id)
                                  setEditNameValue(account.display_name || '')
                                }}
                              >
                                <Pencil className="h-3 w-3 text-muted-foreground" />
                              </button>
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-xs text-muted-foreground truncate">
                              {account.account_email}
                            </span>
                            {account.is_primary && (
                              <>
                                <span className="text-xs text-muted-foreground">·</span>
                                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                                  Primary
                                </Badge>
                              </>
                            )}
                            {syncTime && (
                              <>
                                <span className="text-xs text-muted-foreground">·</span>
                                <span className="text-xs text-muted-foreground">
                                  Synced {syncTime}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          {!account.is_primary && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              onClick={() => handleSetPrimary(account.id)}
                              title="Set as primary"
                            >
                              <Star className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-red-500"
                            onClick={() => setDisconnecting(account)}
                            disabled={isDisconnectingThis}
                          >
                            {isDisconnectingThis ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      </div>

                        {/* Workspace selector */}
                        {workspaces.length > 1 && (
                          <div className="flex items-center gap-2 pt-2.5 mt-2.5 border-t border-border/40 pl-6">
                            <span className="text-xs text-muted-foreground shrink-0">
                              Visible in
                            </span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {account.workspace_ids.map((wsId) => {
                                const ws = workspaces.find((w) => w.id === wsId)
                                return ws ? (
                                  <Badge
                                    key={wsId}
                                    variant="secondary"
                                    className="h-6 gap-1 pl-2 pr-1 text-xs font-normal"
                                  >
                                    {ws.name}
                                    <button
                                      onClick={() => handleToggleWorkspace(account.id, wsId, account.workspace_ids)}
                                      className="rounded-sm p-0.5 hover:bg-muted-foreground/20 transition-colors"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </Badge>
                                ) : null
                              })}
                              {account.workspace_ids.length === 0 && (
                                <span className="text-xs text-muted-foreground/60 italic">
                                  No workspaces
                                </span>
                              )}
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-xs text-muted-foreground"
                                    disabled={savingWorkspaces === account.id}
                                  >
                                    {savingWorkspaces === account.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <>
                                        <Plus className="h-3 w-3 mr-1" />
                                        Add
                                      </>
                                    )}
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-56 p-2" align="start">
                                  <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                                    Select workspaces
                                  </p>
                                  <div className="space-y-0.5">
                                    {workspaces.map((ws) => {
                                      const isAssigned = account.workspace_ids.includes(ws.id)
                                      return (
                                        <label
                                          key={ws.id}
                                          className="flex items-center gap-2.5 rounded-2xl px-2 py-1.5 text-sm cursor-pointer hover:bg-accent transition-colors"
                                        >
                                          <Checkbox
                                            checked={isAssigned}
                                            onCheckedChange={() =>
                                              handleToggleWorkspace(account.id, ws.id, account.workspace_ids)
                                            }
                                          />
                                          <span className="truncate">{ws.name}</span>
                                        </label>
                                      )
                                    })}
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* HubSpot writeback opt-ins (workspace-level): meeting logging +
                  contact push. Both gated behind the same reconnect banner. */}
              {isHubspotCrm && accounts.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    Writeback
                  </h3>

                  {needsReconnect && (
                    <div className="mb-3 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      <div className="flex-1">
                        <p className="text-sm font-medium">
                          Reconnect to enable meeting logging
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Your HubSpot connection was authorized before meeting
                          logging existed. Reconnect to grant Native Intelligence permission to
                          write meetings to your HubSpot timeline.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2.5 h-7 text-xs"
                          onClick={handleConnect}
                          disabled={isConnecting}
                        >
                          {isConnecting ? (
                            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                          ) : null}
                          Reconnect HubSpot
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                    <div className="flex-1 pr-4">
                      <p className="text-sm font-medium">
                        Log meetings to HubSpot
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        On by default. After each meeting is processed, Native Intelligence
                        adds it to every matched contact&apos;s HubSpot timeline
                        with the summary and action items. Private meetings never
                        leave Native Intelligence.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {savingLogMeetings && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      )}
                      <Switch
                        checked={logMeetings === true}
                        onCheckedChange={handleToggleLogMeetings}
                        disabled={
                          logMeetings === null ||
                          savingLogMeetings ||
                          needsReconnect
                        }
                        aria-label="Log meetings to HubSpot"
                      />
                    </div>
                  </div>

                  {/* Contact push (workspace-level opt-in). Shares the reconnect
                      banner above — a connection lacking the write scope can't
                      push contacts either, so this toggle is disabled too. */}
                  <div className="mt-3 flex items-center justify-between rounded-lg border border-border px-4 py-3">
                    <div className="flex-1 pr-4">
                      <p className="text-sm font-medium">
                        Create Native Intelligence contacts in HubSpot
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        New contacts you create in Native Intelligence are also created in your
                        HubSpot CRM.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {savingPushContacts && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      )}
                      <Switch
                        checked={pushContacts === true}
                        onCheckedChange={handleTogglePushContacts}
                        disabled={
                          pushContacts === null ||
                          savingPushContacts ||
                          needsReconnect
                        }
                        aria-label="Create Native Intelligence contacts in HubSpot"
                      />
                    </div>
                  </div>

                  {/* Scope selector — which contacts push. Only shown when the
                      push toggle is ON; HubSpot marketing tiers bill per contact
                      so 'all' must be a deliberate choice (default 'manual'). */}
                  {pushContacts === true && pushScope !== null && (
                    <div className="mt-3 rounded-lg border border-border px-4 py-3">
                      <div className="mb-2 flex items-center gap-2">
                        <p className="text-sm font-medium">Which contacts to sync</p>
                        {savingPushScope && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="radio"
                            name="push-contacts-scope"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                            checked={pushScope === 'manual'}
                            onChange={() => handleChangePushScope('manual')}
                            disabled={savingPushScope || needsReconnect}
                          />
                          <span className="text-xs text-foreground">
                            Only contacts I create manually
                          </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="radio"
                            name="push-contacts-scope"
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                            checked={pushScope === 'all'}
                            onChange={() => handleChangePushScope('all')}
                            disabled={savingPushScope || needsReconnect}
                          />
                          <span className="text-xs text-foreground">
                            All contacts (including auto-captured from meetings and
                            email)
                          </span>
                        </label>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Syncing all contacts may increase your HubSpot marketing
                        contact count.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Asana push destination (workspace-level): which Asana workspace
                  + project pushed actions land in, and how Native Intelligence's four
                  lifecycle buckets map onto that project's sections. */}
              {isAsanaTasks && accounts.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    Destination
                  </h3>

                  {/* The pickers can't populate without a live token, so a
                      reconnect code REPLACES them — an empty dropdown with no
                      explanation reads as "you have no projects". Mirrors the
                      HubSpot reconnect banner above. */}
                  {asana.reconnectRequired && (
                    <ReconnectBanner
                      provider="Asana"
                      pickerList="the workspace, project and section pickers"
                      onReconnect={handleConnect}
                      connecting={isConnecting}
                    />
                  )}

                  {!asana.reconnectRequired && (
                    <>
                      {asana.error && (
                        <p className="mb-3 text-xs text-red-500">{asana.error}</p>
                      )}

                      {asana.loadError && (
                        <PickerLoadError message={asana.loadError} onRetry={asana.retry} />
                      )}

                      <div className="rounded-lg border border-border px-4 py-3">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">Asana workspace</p>
                          {asana.saving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Pushed actions become tasks in this workspace&apos;s project.
                        </p>
                        <Select
                          value={asanaWorkspaceGid ?? undefined}
                          onValueChange={(gid) => {
                            setWorkspaceChoice(gid)
                            setProjectQuery('')
                          }}
                        >
                          <SelectTrigger className="mt-2.5 h-8 text-xs">
                            <SelectValue placeholder="Select a workspace" />
                          </SelectTrigger>
                          <SelectContent>
                            {asanaWorkspaces.map((ws) => (
                              <SelectItem key={ws.gid} value={ws.gid}>
                                {ws.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {asanaWorkspaceGid && (
                        <div className="mt-3 rounded-lg border border-border px-4 py-3">
                          <p className="text-sm font-medium">Project</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {asanaConfig?.project_name
                              ? `Currently pushing to “${asanaConfig.project_name}”.`
                              : 'Pick the project pushed actions land in.'}
                          </p>
                          <SearchableOptionList
                            query={projectQuery}
                            onQueryChange={setProjectQuery}
                            loading={loadingProjects}
                            options={asanaProjectOptions}
                            selectedId={asanaProjectGid}
                            onSelect={handleSelectAsanaProject}
                            emptyMessage="No projects found."
                          />

                          {/* The way back out. Only meaningful once a project is
                              set — the picker itself can only ever ADD one. */}
                          {asanaProjectGid && (
                            <button
                              type="button"
                              onClick={handleClearAsanaDestination}
                              disabled={asana.saving}
                              className="mt-2 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                            >
                              Clear destination
                            </button>
                          )}
                        </div>
                      )}

                      {asanaProjectGid && asanaSections.length > 0 && (
                        <AsanaSectionMap
                          sections={asanaSections}
                          effectiveSectionMap={effectiveSectionMap}
                          noSectionSentinel={NO_SECTION}
                          onSelect={handleSelectAsanaSection}
                        />
                      )}

                      {/* Attribution opt-out. NOT gated on a project being
                          picked: it is a provider-level preference about what
                          Native Intelligence writes into a task, not part of the destination,
                          and it survives a project switch and a clear. */}
                      <div className="mt-3 flex items-center justify-between rounded-lg border border-border px-4 py-3">
                        <div className="flex-1 pr-4">
                          <p className="text-sm font-medium">
                            Include a “Pushed from Native Intelligence” link on pushed tasks
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Adds the action&apos;s identifier and a link back to Native Intelligence
                            in the task description. Only affects tasks pushed from
                            now on.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {asana.saving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <Switch
                            checked={asanaConfig?.include_dial8_attribution !== false}
                            onCheckedChange={handleToggleAsanaAttribution}
                            disabled={asanaConfig === null || asana.saving}
                            aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Jira push destination (workspace-level): which Atlassian site,
                  project and issue type pushed actions become, and how Native Intelligence's
                  four lifecycle buckets map onto that project's statuses. */}
              {isJiraTasks && accounts.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    Destination
                  </h3>

                  {/* The pickers can't populate without a live token, so a
                      reconnect code REPLACES them. Atlassian rotates its refresh
                      token on every use, which gives this state one more way to
                      happen than it has for Asana. */}
                  {jira.reconnectRequired && (
                    <ReconnectBanner
                      provider="Jira"
                      pickerList="the site, project, issue type and status pickers"
                      onReconnect={handleConnect}
                      connecting={isConnecting}
                    />
                  )}

                  {!jira.reconnectRequired && (
                    <>
                      {jira.error && (
                        <p className="mb-3 text-xs text-red-500">{jira.error}</p>
                      )}

                      {jira.loadError && (
                        <PickerLoadError message={jira.loadError} onRetry={jira.retry} />
                      )}

                      <div className="rounded-lg border border-border px-4 py-3">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">Atlassian site</p>
                          {jira.saving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Pushed actions become issues in this site&apos;s project.
                        </p>
                        <Select
                          value={jiraCloudId ?? undefined}
                          onValueChange={(id) => {
                            setSiteChoice(id)
                            setJiraProjectQuery('')
                          }}
                        >
                          <SelectTrigger className="mt-2.5 h-8 text-xs">
                            <SelectValue placeholder="Select a site" />
                          </SelectTrigger>
                          <SelectContent>
                            {jiraSites.map((site) => (
                              <SelectItem key={site.id} value={site.id}>
                                {site.name ?? site.url ?? site.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {jiraCloudId && (
                        <div className="mt-3 rounded-lg border border-border px-4 py-3">
                          <p className="text-sm font-medium">Project</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {jiraConfig?.project_name && !jiraSiteSwitched
                              ? `Currently pushing to “${jiraConfig.project_name}”.`
                              : 'Pick the project pushed actions land in.'}
                          </p>
                          <SearchableOptionList
                            query={jiraProjectQuery}
                            onQueryChange={setJiraProjectQuery}
                            loading={loadingJiraProjects}
                            options={jiraProjects}
                            selectedId={jiraProjectId}
                            onSelect={handleSelectJiraProject}
                            emptyMessage="No projects found."
                          />

                          {/* The way back out. Only meaningful once a project is
                              set — the picker itself can only ever ADD one. */}
                          {jiraProjectId && (
                            <button
                              type="button"
                              onClick={handleClearJiraDestination}
                              disabled={jira.saving}
                              className="mt-2 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                            >
                              Clear destination
                            </button>
                          )}
                        </div>
                      )}

                      {/* Issue type — required, unlike everything below it: Jira
                          cannot create an issue without one, so a project with
                          no type picked is still "not configured". */}
                      {jiraProjectId && jiraIssueTypes.length > 0 && (
                        <div className="mt-3 rounded-lg border border-border px-4 py-3">
                          <p className="text-sm font-medium">Issue type</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Required. Pushed actions are created as this type.
                          </p>
                          <Select
                            value={jiraConfig?.issue_type_id ?? undefined}
                            onValueChange={handleSelectJiraIssueType}
                          >
                            <SelectTrigger className="mt-2.5 h-8 text-xs">
                              <SelectValue placeholder="Select an issue type" />
                            </SelectTrigger>
                            <SelectContent>
                              {jiraIssueTypes.map((type) => (
                                <SelectItem key={type.id} value={type.id}>
                                  {type.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {jiraProjectId && jiraStatuses.length > 0 && (
                        <JiraStatusMap
                          statuses={jiraStatuses}
                          statusMap={jiraConfig?.status_map}
                          autoSentinel={AUTO_STATUS}
                          automaticStatusName={automaticStatusName}
                          onSelect={handleSelectJiraStatus}
                        />
                      )}

                      {/* Attribution opt-out — the Asana twin. Provider-level,
                          ungated on a destination, and it survives the site and
                          project switches that reset everything else here. */}
                      <div className="mt-3 flex items-center justify-between rounded-lg border border-border px-4 py-3">
                        <div className="flex-1 pr-4">
                          <p className="text-sm font-medium">
                            Include a “Pushed from Native Intelligence” link on pushed tasks
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Adds the action&apos;s identifier and a link back to Native Intelligence
                            in the issue description. Only affects issues pushed from
                            now on.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {jira.saving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <Switch
                            checked={jiraConfig?.include_dial8_attribution !== false}
                            onCheckedChange={handleToggleJiraAttribution}
                            disabled={jiraConfig === null || jira.saving}
                            aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {isLinearTasks && accounts.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    Destination
                  </h3>

                  {/* The pickers can't populate without a live token, so a
                      reconnect code REPLACES them. Linear's access tokens last
                      24h and its refresh tokens rotate on every use, so this
                      state is reached more routinely here than for Asana. */}
                  {linear.reconnectRequired && (
                    <ReconnectBanner
                      provider="Linear"
                      pickerList="the team and project pickers"
                      onReconnect={handleConnect}
                      connecting={isConnecting}
                    />
                  )}

                  {!linear.reconnectRequired && (
                    <>
                      {linear.error && (
                        <p className="mb-3 text-xs text-red-500">{linear.error}</p>
                      )}

                      {linear.loadError && (
                        <PickerLoadError message={linear.loadError} onRetry={linear.retry} />
                      )}

                      {/* The team is THE destination — the only required id.
                          There is no site above it (a token belongs to exactly
                          one Linear organization) and no issue type below it. */}
                      <div className="rounded-lg border border-border px-4 py-3">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">Team</p>
                          {linear.saving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {linearConfig?.team_name
                            ? `Currently pushing to “${linearConfig.team_name}”.`
                            : 'Pushed actions become issues on this team.'}
                        </p>
                        <Select
                          value={linearTeamId ?? undefined}
                          onValueChange={handleSelectLinearTeam}
                        >
                          <SelectTrigger className="mt-2.5 h-8 text-xs">
                            <SelectValue placeholder="Select a team" />
                          </SelectTrigger>
                          <SelectContent>
                            {linearTeams.map((team) => (
                              <SelectItem key={team.id} value={team.id}>
                                {team.key ? `${team.key} · ${team.name}` : team.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {/* The way back out. Only meaningful once a team is
                            set — the picker itself can only ever ADD one. */}
                        {linearTeamId && (
                          <button
                            type="button"
                            onClick={handleClearLinearDestination}
                            disabled={linear.saving}
                            className="mt-2 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                          >
                            Clear destination
                          </button>
                        )}
                      </div>

                      {/* Project — OPTIONAL, and the structural difference from
                          Jira: a Linear issue belongs to a team and may have no
                          project at all, so this refines a destination that is
                          already complete. */}
                      {linearTeamId && (
                        <div className="mt-3 rounded-lg border border-border px-4 py-3">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">Project</p>
                            {loadingLinearProjects && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Optional. Pushed issues can sit in one of the
                            team&apos;s projects, or directly under the team.
                          </p>
                          <Select
                            value={linearConfig?.project_id ?? NO_LINEAR_PROJECT}
                            onValueChange={handleSelectLinearProject}
                          >
                            <SelectTrigger className="mt-2.5 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_LINEAR_PROJECT}>No project</SelectItem>
                              {linearProjects.map((project) => (
                                <SelectItem key={project.id} value={project.id}>
                                  {project.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* The state mapping — READ-ONLY, and that is the whole
                          point rather than a missing feature.

                          `WorkflowState.type` is a stable seven-value enum, so
                          which state a lifecycle bucket maps to is a FACT about
                          the team, not a preference: the server derives it when
                          the destination is saved (deriveLinearStateMap) and
                          re-derives it when a saved id goes stale. Showing it
                          rather than letting it be chosen means the display can
                          never disagree with what a push and an echo will
                          actually do. Where a bucket came out EMPTY — a team
                          with no canceled-type state is ordinary, not broken —
                          the honest warning replaces the state name. */}
                      {linearTeamId && <LinearStateMap stateMap={linearConfig?.state_map} />}

                      {/* Attribution opt-out — the Asana and Jira twin.
                          Provider-level, ungated on a destination, and it
                          survives the team and project switches that reset
                          everything else here. */}
                      <div className="mt-3 flex items-center justify-between rounded-lg border border-border px-4 py-3">
                        <div className="flex-1 pr-4">
                          <p className="text-sm font-medium">
                            Include a “Pushed from Native Intelligence” link on pushed tasks
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Adds the action&apos;s identifier and a link back to Native Intelligence
                            in the issue description. Only affects issues pushed from
                            now on.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {linear.saving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <Switch
                            checked={linearConfig?.include_dial8_attribution !== false}
                            onCheckedChange={handleToggleLinearAttribution}
                            disabled={linearConfig === null || linear.saving}
                            aria-label="Include a “Pushed from Native Intelligence” link on pushed tasks"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Which repository is the business's website (roadmap track E). */}
              {provider === 'github' && accounts.length > 0 && <WebsiteSection />}

              {/* Add account button */}
              <div className="mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleConnect}
                  disabled={isConnecting}
                >
                  {isConnecting ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="mr-1.5 h-3 w-3" />
                  )}
                  {accounts.length > 0 ? 'Add another account' : 'Connect'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!disconnecting}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {disconnecting?.display_name || disconnecting?.account_email}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Native Intelligence will no longer be able to access your{' '}
              {capability === 'calendar' ? 'calendar' : capability === 'github' ? 'repositories' : capability === 'crm' ? 'CRM data' : capability === 'tasks' ? (isJiraTasks ? 'Jira issues' : isLinearTasks ? 'Linear issues' : 'Asana tasks') : 'email'} from{' '}
              {disconnecting?.account_email}. You can reconnect at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
