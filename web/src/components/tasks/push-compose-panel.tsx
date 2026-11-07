'use client'

/**
 * The compose form — pick a destination for THIS push, then create.
 *
 * Before this existed, a push had exactly one destination: whatever an admin
 * picked in Settings, workspace-wide, for every action forever. That is still
 * the DEFAULT — every field below opens prefilled from `task_sync_state.config`
 * — but it is no longer the only answer. The three things Liam wanted are all
 * the same thing: push one action to a Jira board and assign a teammate who
 * doesn't use Dial8; send a Linear ticket to a friend with the details already
 * filled; put two actions from one meeting into two different projects without
 * touching Settings.
 *
 * IT IS NOT A DIALOG ANY MORE. It used to be, and Liam's verbatim objection was
 * the whole reason for this rework: "When I choose Jira or Linear or Asana, I
 * don't want it to be a pop-up. We already have a property view on every action
 * item. I just want all the properties to populate in the property view and just
 * make it so that it scrolls horizontally." So compose happens IN the row, in
 * the same strip the action's own property chips occupy, as a horizontally
 * scrollable line of controls with Create at the far right end. A pop-up made
 * pushing a modal errand; a strip makes it an edit to the row you were already
 * looking at.
 *
 * TWO LAYOUTS, ONE FORM. The fields, their order, their gating and every byte
 * they produce are identical in both; only the box they sit in differs.
 *   - `strip`  — the row surfaces. One line, `overflow-x-auto`, fixed height.
 *   - `stack`  — the detail panel's properties sidebar, which is already a
 *                narrow vertical column and has nowhere to scroll sideways.
 * `ComposeFields` renders the provider forms and knows nothing about either;
 * `ComposeSurface` picks the box. That is what keeps "the sidebar variant" from
 * becoming a second copy of the Jira cascade.
 *
 * WHAT IT IS: a CREATE composer. Everything it collects is a one-shot override
 * sent with one POST and then forgotten (src/lib/tasks/push-overrides.ts). It
 * is not a live editor of the remote task — after the push, status remains the
 * only field the two sides sync, exactly as before.
 *
 * THE FIELDS ARE NOT A DESIGN CHOICE PER PROVIDER — they are what each provider
 * can actually accept, which is why they differ so much:
 *  - Jira asks the site what its create screen holds (compose-meta) and renders
 *    exactly that. No due-date input when `duedate` isn't on the screen, because
 *    sending it 400s with "not on the appropriate screen". A required custom
 *    field with no selectable values DISABLES Create and links to Jira's own
 *    create form, because the create is known to fail and failing before minting
 *    anything is strictly better than a 400 nobody can read.
 *  - Asana has NO priority field. Not hidden — absent from the product. Faking
 *    one from a per-project enum custom field is a real feature and a different
 *    one; it is not in v1.
 *  - Linear's priority is a fixed 0-4 with no per-team variation, so it is a
 *    static list rather than a fetch. Its workflow STATE is never asked for: the
 *    push derives the chosen team's own not-started state server-side, because a
 *    state belongs to exactly one team and the config's belongs to another.
 *
 * THE ONE THING THE FORM CANNOT CHANGE is the Jira SITE. Every option route
 * addresses one cloud id, the link row stores it as `external_scope`, and a
 * cross-site compose would need its own token story — so compose stays within
 * the configured site and says so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  AlertTriangle,
  CircleDot,
  ExternalLink,
  Flag,
  Folder,
  Loader2,
  Rows3,
  Tag,
  User,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchableOptionList } from '@/app/account/settings/integrations/[provider]/[capability]/destination-picker-slots'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
/**
 * THE SHARED FIELD FURNITURE, which used to live in this file.
 *
 * `Field`/`OptionSelect`/`DateField`/`ComposeFailure`, the chip class strings,
 * the `NONE` sentinel and the `YYYY-MM-DD` date helpers moved to
 * `./compose-fields` unchanged so the property lens can read a linked ticket's
 * live fields through the SAME controls instead of a second copy that drifts.
 * `ComposeProvider`/`ComposeLayout` are declared there too (the controls take
 * the layout) and re-exported below, so every existing importer of this module
 * keeps working untouched.
 *
 * Not imported here: `NONE` and `parseWireDate`/`formatWireDate`. They were only
 * ever read by `OptionSelect` and `DateField`, so they left with them — a caller
 * that needs the date helpers on its own write path takes them from
 * `./compose-fields` directly rather than through this module.
 */
import {
  ComposeFailure,
  DateField,
  Field,
  OptionSelect,
  chipErrorClass,
  chipTriggerClass,
  type ComposeLayout,
  type ComposeProvider,
} from './compose-fields'
import {
  COMPOSE_RECONNECT_CODES,
  useOptionSlots,
  type AsanaProjectOption,
  type AsanaSectionOption,
  type AsanaUserOption,
  type ComposeLoadFailure,
  type JiraComposeMeta,
  type JiraIssueTypeOption,
  type JiraProjectOption,
  type JiraUserOption,
  type LinearLabelOption,
  type LinearMemberOption,
  type LinearProjectOption,
  type LinearTeamOption,
} from './use-compose-options'

/** Linear's fixed priority scale — workspace-wide, no per-team restriction. */
const LINEAR_PRIORITIES = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
] as const

/**
 * Declared with the controls in `./compose-fields` (they take the layout), and
 * re-exported from here because this is the module every caller already imports
 * them from — `push-to-tracker-menu.tsx` among them.
 */
export type { ComposeLayout, ComposeProvider }

/** The override body this form produces, shaped per provider. */
export type ComposeOverrides = Record<string, unknown>

export interface PushComposePanelProps {
  provider: ComposeProvider
  /** Display name from the destination row ("Jira"). */
  providerName: string
  /** The action's own title — the form's starting summary. */
  defaultTitle: string
  /** Runs the push. Returns true when it succeeded (the form then closes). */
  onCreate: (overrides: ComposeOverrides) => Promise<boolean>
  /** Leave compose mode — the X, Escape, and a successful Create all call it. */
  onCancel: () => void
  /** Open the settings overlay — the reconnect banner's way out. */
  onOpenSettings?: (subPath?: string) => void
  /** Strip (row surfaces) or stack (detail-panel sidebar). Defaults to strip. */
  layout?: ComposeLayout
}

/** `task_sync_state.config`, read through the member-readable settings GET. */
type ProviderConfig = Record<string, unknown>

function str(config: ProviderConfig, key: string): string | null {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Comma-separated freeform strings — Jira labels.
 *
 * A chip input would be prettier; this is one text field whose parse rule is
 * visible in its own hint, and it cannot get into a state where a half-typed
 * chip is silently dropped on Create.
 */
function parseLabels(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

// ---------------------------------------------------------------------------
// The compose form
// ---------------------------------------------------------------------------

export function PushComposePanel({
  provider,
  providerName,
  defaultTitle,
  onCreate,
  onCancel,
  onOpenSettings,
  layout = 'strip',
}: PushComposePanelProps) {
  const workspaceId = useWorkspaceId()
  const { slot, load, reset, clearAll, failure } = useOptionSlots(workspaceId ?? 'no-workspace')

  const [config, setConfig] = useState<ProviderConfig | null>(null)
  const [configFailure, setConfigFailure] = useState<ComposeLoadFailure | null>(null)
  const [creating, setCreating] = useState(false)
  /**
   * Bumped by the failure banner's Retry, and a dependency of EVERY option
   * effect below — not just the config and compose-meta ones.
   *
   * A slot failure replaces the whole field form with the banner, so Retry is
   * the only affordance the user has left: they cannot change the parent field
   * to force a reload, because the parent field is not on screen. When the child
   * effects keyed only off derived strings (the selected project, team, issue
   * type), a retry changed none of them, nothing was re-requested, the slot's
   * failure was never cleared, and the banner re-rendered identically no matter
   * how many times it was clicked — the form was stuck until cancel and re-open.
   * `load()` clears a slot's failure when its reload starts, so one click now
   * re-attempts every failed slot.
   */
  const [retryKey, setRetryKey] = useState(0)

  /**
   * Has a typed search REPLACED the project slot's options?
   *
   * Only then does emptying the box need to re-issue the browse list — on a
   * form that was never searched the slot already holds it, and re-fetching
   * would double every open.
   */
  const jiraSearchRan = useRef(false)
  const asanaSearchRan = useRef(false)

  /**
   * Fields the USER touched, for the ones that have a server-side fallback.
   *
   * The form only sends differences, which is what keeps an untouched Create
   * byte-identical to the old one-click push. But "the user cleared this" and
   * "the user never touched this" both look like an empty value, and they mean
   * opposite things: absent tells the push to fall back (to the config's project
   * or section, to the action's own assignee and due date), while a clear must
   * suppress that fallback. Tracking WHO emptied the field is the only way to
   * tell them apart — so a cleared field the user touched travels as an explicit
   * `null`, and an untouched one is still omitted entirely.
   */
  const dirtyFields = useRef(new Set<string>())
  const markDirty = useCallback(<T,>(field: string, set: (value: T) => void) => {
    return (value: T) => {
      dirtyFields.current.add(field)
      set(value)
    }
  }, [])

  // Jira
  const [jiraProjectId, setJiraProjectId] = useState<string | null>(null)
  const [jiraProjectKey, setJiraProjectKey] = useState<string | null>(null)
  const [jiraProjectQuery, setJiraProjectQuery] = useState('')
  const [jiraIssueTypeId, setJiraIssueTypeId] = useState<string | null>(null)
  const [jiraAssignee, setJiraAssignee] = useState<string | null>(null)
  const [jiraPriority, setJiraPriority] = useState<string | null>(null)
  const [jiraDueDate, setJiraDueDate] = useState('')
  const [jiraLabels, setJiraLabels] = useState('')
  const [jiraCustom, setJiraCustom] = useState<Record<string, string>>({})
  const [jiraMeta, setJiraMeta] = useState<JiraComposeMeta | null>(null)
  const [jiraMetaLoading, setJiraMetaLoading] = useState(false)
  /** Held separately from the slot failures — this read is not a slot. */
  const [jiraMetaFailure, setJiraMetaFailure] = useState<ComposeLoadFailure | null>(null)
  const [jiraNativeUrl, setJiraNativeUrl] = useState<string | null>(null)

  // Asana
  const [asanaProjectGid, setAsanaProjectGid] = useState<string | null>(null)
  const [asanaProjectQuery, setAsanaProjectQuery] = useState('')
  const [asanaSectionGid, setAsanaSectionGid] = useState<string | null>(null)
  const [asanaAssignee, setAsanaAssignee] = useState<string | null>(null)
  const [asanaDue, setAsanaDue] = useState('')

  // Linear
  const [linearTeamId, setLinearTeamId] = useState<string | null>(null)
  const [linearProjectId, setLinearProjectId] = useState<string | null>(null)
  const [linearAssignee, setLinearAssignee] = useState<string | null>(null)
  const [linearPriority, setLinearPriority] = useState<number | null>(null)
  const [linearLabels, setLinearLabels] = useState<string[]>([])
  const [linearDue, setLinearDue] = useState('')

  /**
   * The config values the form opened with.
   *
   * Kept so Create can tell "the user picked the configured project" from "the
   * user picked a different one" — only the latter is an override. Sending the
   * config's own project back as an override would be harmless for Asana and
   * WRONG for Linear, where an overridden team re-derives its workflow state
   * server-side and would therefore throw away the config's carefully-derived
   * state map for an identical one. Same answer, an extra round trip, and a
   * behaviour that silently diverges the day the derivation changes.
   */
  const configured = useMemo(
    () => ({
      jiraProjectId: config ? str(config, 'project_id') : null,
      jiraIssueTypeId: config ? str(config, 'issue_type_id') : null,
      asanaProjectGid: config ? str(config, 'project_gid') : null,
      linearTeamId: config ? str(config, 'team_id') : null,
      linearProjectId: config ? str(config, 'project_id') : null,
    }),
    [config],
  )

  const cloudId = config ? str(config, 'cloud_id') : null
  const siteName = config ? str(config, 'site_name') : null
  const asanaWorkspaceGid = config ? str(config, 'asana_workspace_gid') : null

  /**
   * ENTERING compose mode is this component MOUNTING, and leaving it is this
   * component unmounting.
   *
   * The dialog it replaced was rendered permanently and toggled with `open`, so
   * it carried a large effect that reset twenty-odd fields on the true→false
   * edge and a matching `open &&` guard on every loader. The strip has no such
   * state: each surface renders `<PushComposePanel>` only while `composing` is
   * set, so a cancel unmounts it and a re-open mounts a fresh one with fresh
   * `useState` initialisers. Every one of those resets is now the absence of a
   * component, which cannot drift out of sync with the field list the way an
   * enumerated reset could — and the reset bug class ("a field added in June
   * that nobody added to the reset") stops being possible.
   *
   * `clearAll` on unmount is still needed and is the one piece that does not
   * come free: the slot generation counters live in `useOptionSlots`, whose
   * state unmounts with us, but an in-flight request holds a closure over
   * `setSlots` and React will warn if it lands after unmount. Bumping every
   * generation makes those answers no-ops.
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearAll()
    }
  }, [clearAll])

  /**
   * ESCAPE LEAVES COMPOSE MODE.
   *
   * The Dialog gave this for free; a strip inside a row has to say it. Bound on
   * the document rather than the strip because the focus may legitimately be
   * inside a Radix Select popover (rendered in a portal, outside the strip's
   * subtree) when the user gives up on it.
   *
   * `creating` guards it for the same reason the dialog's `onOpenChange` did:
   * a push is in flight, the row is about to change underneath, and unmounting
   * mid-request would drop the only UI that can report the result.
   *
   * `stopPropagation` is deliberately NOT called — an Escape that also closes
   * an open Select popover is the correct outcome of one keypress, and Radix's
   * own handler runs on the element, ahead of this document-level listener.
   */
  const creatingRef = useRef(false)
  useEffect(() => {
    creatingRef.current = creating
  }, [creating])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (creatingRef.current) return
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  // THE TITLE IS NO LONGER THIS FORM'S BUSINESS. It used to be a field here,
  // seeded once from `defaultTitle` so a live rename could not type over what
  // the user had written mid-compose. The card now renders the title itself and
  // compose only swaps the property row beneath it, so there is no copy of the
  // title to keep in sync and no seeding hazard left to defend against.
  // `defaultTitle` survives as the prop that names the thing being pushed.

  /**
   * Step 1 on mount: read the saved destination.
   *
   * NOT `cachedJson` — the settings GET is the source of the prefill, and a
   * minute-stale answer here means the form opens pointing at the project the
   * admin just moved away from. One request per compose session is nothing; the
   * option LISTS underneath it are the expensive part and those are cached.
   */
  useEffect(() => {
    let cancelled = false
    setConfigFailure(null)
    fetch(`/api/account/workspace/${provider}-settings`)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          setConfigFailure({ kind: 'error', message: body.error || 'Could not load your settings' })
          return
        }
        const body = (await res.json()) as { config?: ProviderConfig }
        if (cancelled) return
        setConfig(body.config ?? {})
      })
      .catch(() => {
        if (!cancelled) {
          setConfigFailure({ kind: 'error', message: 'Could not load your settings' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [provider, retryKey])

  // The config's picks seed the form ONCE per provider. A Retry refetches the
  // config, and seeding again would put the configured project's issue type
  // (or project) back under a project the user has since picked instead.
  const seededProviderRef = useRef<string | null>(null)

  // ---- Jira cascade --------------------------------------------------------

  // Projects, and the config's project as the opening pick.
  useEffect(() => {
    if (provider !== 'jira' || !config) return
    if (seededProviderRef.current !== provider) {
      seededProviderRef.current = provider
      setJiraProjectId((prev) => prev ?? str(config, 'project_id'))
      setJiraProjectKey((prev) => prev ?? str(config, 'project_key'))
      setJiraIssueTypeId((prev) => prev ?? str(config, 'issue_type_id'))
    }
    if (!cloudId) return
    void load<JiraProjectOption>(
      'jira-projects',
      `/api/account/jira/projects?cloudId=${encodeURIComponent(cloudId)}`,
      (d) => (d as { projects?: JiraProjectOption[] }).projects ?? [],
    )
  }, [provider, config, cloudId, load, retryKey])

  // Typed project search — uncached, and it REPLACES the browse list rather than
  // filtering it client-side, because Jira's `/project/search` matches on key as
  // well as name and a client filter would miss "ENG".
  useEffect(() => {
    if (provider !== 'jira' || !cloudId) return
    const query = jiraProjectQuery.trim()
    if (!query) {
      // Emptying the box must put the BROWSE list back. The search replaced the
      // slot wholesale, and the browse effect will not re-run on its own (its
      // deps are unchanged), so without this the last search's results stayed
      // the only options for the rest of the session — with an empty search
      // box beside them, reading as "my projects have vanished". Guarded so an
      // untouched form does not double-fetch on open; the restore is a
      // cachedJson hit, and the slot's generation counter handles any race with
      // an in-flight search response.
      if (jiraSearchRan.current) {
        jiraSearchRan.current = false
        void load<JiraProjectOption>(
          'jira-projects',
          `/api/account/jira/projects?cloudId=${encodeURIComponent(cloudId)}`,
          (d) => (d as { projects?: JiraProjectOption[] }).projects ?? [],
        )
      }
      return
    }
    const timer = setTimeout(() => {
      jiraSearchRan.current = true
      void load<JiraProjectOption>(
        'jira-projects',
        `/api/account/jira/projects?cloudId=${encodeURIComponent(cloudId)}&query=${encodeURIComponent(query)}`,
        (d) => (d as { projects?: JiraProjectOption[] }).projects ?? [],
        { cache: false },
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [provider, cloudId, jiraProjectQuery, load, retryKey])

  // Issue types for the chosen project. Per-project ALWAYS: in a team-managed
  // project the types are project-local copies, so "Task" here is a different id
  // from "Task" next door.
  useEffect(() => {
    if (provider !== 'jira' || !cloudId || !jiraProjectId) return
    void load<JiraIssueTypeOption>(
      'jira-issue-types',
      `/api/account/jira/issue-types?cloudId=${encodeURIComponent(cloudId)}&projectId=${encodeURIComponent(jiraProjectId)}`,
      (d) => (d as { issueTypes?: JiraIssueTypeOption[] }).issueTypes ?? [],
    )
  }, [provider, cloudId, jiraProjectId, load, retryKey])

  // The create screen itself — which fields exist, which are required, and
  // whether a create is possible at all.
  useEffect(() => {
    if (provider !== 'jira' || !cloudId || !jiraProjectId || !jiraIssueTypeId) {
      setJiraMeta(null)
      // Every re-run that does NOT start a fetch must leave the flag false. The
      // cancelled previous fetch cannot do it — its `finally` is skipped once
      // `cancelled` is set — so a project change (which nulls the issue type and
      // lands here) otherwise left "Reading this issue type's create screen…" on
      // screen forever with nothing in flight. Covers a provider change and an
      // unmount-mid-flight the same way.
      setJiraMetaLoading(false)
      return
    }
    let cancelled = false
    setJiraMetaLoading(true)
    setJiraMetaFailure(null)
    fetch(
      `/api/account/jira/compose-meta?cloudId=${encodeURIComponent(cloudId)}` +
        `&projectId=${encodeURIComponent(jiraProjectId)}` +
        `&issueTypeId=${encodeURIComponent(jiraIssueTypeId)}`,
    )
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          // A create screen we could not read is not a create screen with no
          // requirements — it is an unknown, and composing against an unknown is
          // the create-and-pray this whole module exists to refuse. So the
          // failure is RAISED rather than absorbed into an empty meta, and Create
          // stays off until a retry answers.
          const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
          if (cancelled) return
          setJiraMeta(null)
          setJiraMetaFailure(
            body.code && COMPOSE_RECONNECT_CODES.has(body.code)
              ? { kind: 'reconnect' }
              : { kind: 'error', message: body.error || "Couldn't read this issue type's fields." },
          )
          return
        }
        const body = (await res.json()) as {
          meta: JiraComposeMeta
          native_create_url: string | null
        }
        if (cancelled) return
        setJiraMeta(body.meta)
        setJiraNativeUrl(body.native_create_url)
        // A field that vanished from the new screen must not still be sent —
        // and this is the SYSTEM emptying it, so the dirty flag goes with it.
        // Jira rejects a field that is off the create screen whatever its value,
        // so sending an explicit null here would be a guaranteed 400.
        if (!body.meta.has_due_date) {
          setJiraDueDate('')
          dirtyFields.current.delete('due_date')
        }
        if (!body.meta.has_labels) setJiraLabels('')
        if (!body.meta.has_priority) setJiraPriority(null)
        if (!body.meta.has_assignee) {
          setJiraAssignee(null)
          dirtyFields.current.delete('assignee_account_id')
        }
        setJiraCustom({})
      })
      .catch(() => {
        if (cancelled) return
        setJiraMeta(null)
        setJiraMetaFailure({ kind: 'error', message: "Couldn't read this issue type's fields." })
      })
      .finally(() => {
        if (!cancelled) setJiraMetaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [provider, cloudId, jiraProjectId, jiraIssueTypeId, retryKey])

  // Assignees, keyed by project KEY — the one Jira endpoint that wants the key
  // rather than the id, which is why the key is carried alongside it everywhere.
  useEffect(() => {
    if (provider !== 'jira' || !cloudId || !jiraProjectKey) return
    if (jiraMeta && !jiraMeta.has_assignee) return
    void load<JiraUserOption>(
      'jira-users',
      `/api/account/jira/assignable-users?cloudId=${encodeURIComponent(cloudId)}&projectKey=${encodeURIComponent(jiraProjectKey)}`,
      (d) => (d as { users?: JiraUserOption[] }).users ?? [],
    )
  }, [provider, cloudId, jiraProjectKey, jiraMeta, load, retryKey])

  // ---- Asana cascade -------------------------------------------------------

  useEffect(() => {
    if (provider !== 'asana' || !config) return
    if (seededProviderRef.current !== provider) {
      seededProviderRef.current = provider
      setAsanaProjectGid((prev) => prev ?? str(config, 'project_gid'))
    }
    if (!asanaWorkspaceGid) return
    void load<AsanaProjectOption>(
      'asana-projects',
      `/api/account/asana/projects?workspace=${encodeURIComponent(asanaWorkspaceGid)}`,
      (d) => (d as { projects?: AsanaProjectOption[] }).projects ?? [],
    )
    void load<AsanaUserOption>(
      'asana-users',
      `/api/account/asana/users?workspace=${encodeURIComponent(asanaWorkspaceGid)}`,
      (d) => (d as { users?: AsanaUserOption[] }).users ?? [],
    )
  }, [provider, config, asanaWorkspaceGid, load, retryKey])

  useEffect(() => {
    if (provider !== 'asana' || !asanaWorkspaceGid) return
    const query = asanaProjectQuery.trim()
    if (!query) {
      // Same restore as Jira's above, for the same reason.
      if (asanaSearchRan.current) {
        asanaSearchRan.current = false
        void load<AsanaProjectOption>(
          'asana-projects',
          `/api/account/asana/projects?workspace=${encodeURIComponent(asanaWorkspaceGid)}`,
          (d) => (d as { projects?: AsanaProjectOption[] }).projects ?? [],
        )
      }
      return
    }
    const timer = setTimeout(() => {
      asanaSearchRan.current = true
      void load<AsanaProjectOption>(
        'asana-projects',
        `/api/account/asana/projects?workspace=${encodeURIComponent(asanaWorkspaceGid)}&query=${encodeURIComponent(query)}`,
        (d) => (d as { projects?: AsanaProjectOption[] }).projects ?? [],
        { cache: false },
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [provider, asanaWorkspaceGid, asanaProjectQuery, load, retryKey])

  // Sections belong to ONE project, so changing the project invalidates both the
  // list and any pick made from it.
  useEffect(() => {
    if (provider !== 'asana' || !asanaProjectGid) {
      return
    }
    // The SYSTEM is clearing this, not the user: a section belongs to one
    // project, so a project change invalidates the old pick. That must not read
    // as "the user chose no section" — it would send `section_gid: null` and
    // suppress the new project's own section_map, which nobody asked for.
    setAsanaSectionGid(null)
    dirtyFields.current.delete('section_gid')
    void load<AsanaSectionOption>(
      'asana-sections',
      `/api/account/asana/sections?project=${encodeURIComponent(asanaProjectGid)}`,
      (d) => (d as { sections?: AsanaSectionOption[] }).sections ?? [],
    )
  }, [provider, asanaProjectGid, load, retryKey])

  // ---- Linear cascade ------------------------------------------------------

  useEffect(() => {
    if (provider !== 'linear' || !config) return
    if (seededProviderRef.current !== provider) {
      seededProviderRef.current = provider
      setLinearTeamId((prev) => prev ?? str(config, 'team_id'))
      setLinearProjectId((prev) => prev ?? str(config, 'project_id'))
    }
    void load<LinearTeamOption>(
      'linear-teams',
      '/api/account/linear/teams',
      (d) => (d as { teams?: LinearTeamOption[] }).teams ?? [],
    )
  }, [provider, config, load, retryKey])

  useEffect(() => {
    if (provider !== 'linear' || !linearTeamId) {
      reset('linear-labels')
      return
    }
    void load<LinearProjectOption>(
      'linear-projects',
      `/api/account/linear/projects?teamId=${encodeURIComponent(linearTeamId)}`,
      (d) => (d as { projects?: LinearProjectOption[] }).projects ?? [],
    )
    void load<LinearMemberOption>(
      'linear-members',
      `/api/account/linear/members?teamId=${encodeURIComponent(linearTeamId)}`,
      (d) => (d as { members?: LinearMemberOption[] }).members ?? [],
    )
    void load<LinearLabelOption>(
      'linear-labels',
      `/api/account/linear/labels?teamId=${encodeURIComponent(linearTeamId)}`,
      (d) => (d as { labels?: LinearLabelOption[] }).labels ?? [],
    )
  }, [provider, linearTeamId, load, reset, retryKey])

  /**
   * A team change invalidates the project chosen under the old one — Linear
   * projects are many-to-many with teams, so the old pick may simply not be
   * associated with the new team, and `issueCreate` would reject it.
   */
  const previousTeam = useRef<string | null>(null)
  useEffect(() => {
    if (provider !== 'linear') return
    if (previousTeam.current !== null && previousTeam.current !== linearTeamId) {
      setLinearProjectId(null)
      setLinearAssignee(null)
      setLinearLabels([])
      // System-driven, exactly as in the Asana cascade above: these are being
      // invalidated by the team change, not cleared by the user, so they must
      // not travel as explicit nulls.
      dirtyFields.current.delete('project_id')
      dirtyFields.current.delete('assignee_id')
    }
    previousTeam.current = linearTeamId
  }, [provider, linearTeamId])

  // ---- Create --------------------------------------------------------------

  /**
   * Which fields the user actually CHANGED, as the override body.
   *
   * Only differences travel. An untouched form produces `{}`, which the route
   * folds to "no overrides" and pushes down the exact path it took before this
   * form existed — which is what keeps "open the icon, hit Create" identical to
   * the old one-click push rather than merely equivalent to it.
   *
   * A CLEARED field is a difference too, and the one this used to get wrong.
   * Picking "No project" or emptying the date box produced no key, and every
   * push then fell back to the config or the action — so the issue landed in the
   * project the user had just removed. Those fields now travel as an explicit
   * `null`, but ONLY when the user touched them (see dirtyFields): an untouched
   * empty field is still omitted, which is what preserves `{}`.
   */
  const buildOverrides = useCallback((): ComposeOverrides => {
    const overrides: ComposeOverrides = {}
    const dirty = (field: string) => dirtyFields.current.has(field)

    // NO TITLE OVERRIDE IS EVER PRODUCED HERE. The strip stopped offering a
    // title field (the card's own heading is the title — see ComposeFields), so
    // there is no user input that could differ from `defaultTitle`, and sending
    // the action's title back as an "override" of itself would be a no-op the
    // route still has to reason about.
    //
    // `overrides.title` REMAINS A VALID KEY on the wire — the push routes and
    // the MCP/AI callers that compose a push programmatically still set it.
    // This form simply is not one of those callers.

    if (provider === 'jira') {
      const projectChanged = !!jiraProjectId && jiraProjectId !== configured.jiraProjectId
      if (projectChanged) {
        overrides.project_id = jiraProjectId
        if (jiraProjectKey) overrides.project_key = jiraProjectKey
        // The dependent-field rule, enforced here as well as at the route: a
        // project override without its issue type is rejected server-side, and
        // producing it would be this form's bug rather than the user's.
        if (jiraIssueTypeId) overrides.issue_type_id = jiraIssueTypeId
      } else if (jiraIssueTypeId && jiraIssueTypeId !== configured.jiraIssueTypeId) {
        overrides.issue_type_id = jiraIssueTypeId
      }
      // A field the user CLEARED travels as an explicit null so the push
      // suppresses its fallback; one they never touched is omitted and inherits.
      if (jiraAssignee) overrides.assignee_account_id = jiraAssignee
      else if (dirty('assignee_account_id')) overrides.assignee_account_id = null
      if (jiraPriority) overrides.priority_id = jiraPriority
      if (jiraDueDate) overrides.due_date = jiraDueDate
      else if (dirty('due_date')) overrides.due_date = null
      const labels = parseLabels(jiraLabels)
      if (labels.length > 0) overrides.labels = labels
      const customEntries = Object.entries(jiraCustom).filter(([, id]) => !!id)
      if (customEntries.length > 0) {
        overrides.custom_fields = Object.fromEntries(
          customEntries.map(([fieldId, id]) => [fieldId, { id }]),
        )
      }
      return overrides
    }

    if (provider === 'asana') {
      if (asanaProjectGid && asanaProjectGid !== configured.asanaProjectGid) {
        overrides.project_gid = asanaProjectGid
      }
      if (asanaSectionGid) overrides.section_gid = asanaSectionGid
      else if (dirty('section_gid')) overrides.section_gid = null
      if (asanaAssignee) overrides.assignee_gid = asanaAssignee
      else if (dirty('assignee_gid')) overrides.assignee_gid = null
      if (asanaDue) overrides.due_on = asanaDue
      else if (dirty('due_on')) overrides.due_on = null
      return overrides
    }

    if (linearTeamId && linearTeamId !== configured.linearTeamId) {
      overrides.team_id = linearTeamId
    }
    if (linearProjectId && linearProjectId !== configured.linearProjectId) {
      overrides.project_id = linearProjectId
    } else if (!linearProjectId && dirty('project_id')) {
      // "No project" on a config that HAS one — the case that used to land the
      // issue in the config's project while the form said otherwise.
      overrides.project_id = null
    }
    if (linearAssignee) overrides.assignee_id = linearAssignee
    else if (dirty('assignee_id')) overrides.assignee_id = null
    if (linearPriority !== null) overrides.priority = linearPriority
    if (linearLabels.length > 0) overrides.label_ids = linearLabels
    if (linearDue) overrides.due_date = linearDue
    else if (dirty('due_date')) overrides.due_date = null
    return overrides
  }, [
    provider,
    configured,
    jiraProjectId,
    jiraProjectKey,
    jiraIssueTypeId,
    jiraAssignee,
    jiraPriority,
    jiraDueDate,
    jiraLabels,
    jiraCustom,
    asanaProjectGid,
    asanaSectionGid,
    asanaAssignee,
    asanaDue,
    linearTeamId,
    linearProjectId,
    linearAssignee,
    linearPriority,
    linearLabels,
    linearDue,
  ])

  /**
   * Why Create is unavailable, as the sentence shown beside the button — or null
   * when it is available.
   *
   * Everything that can block a create is collected in one place so the button
   * and its explanation can never disagree, which is the failure mode of
   * scattering `disabled={...}` conditions across three provider forms.
   */
  const blockedReason: string | null = (() => {
    // Still a wall, now pointing at the CARD. Every provider rejects an
    // untitled issue, so this must stay a create-blocker — but the strip no
    // longer owns a title box to fix it in, so the sentence names where the
    // title actually lives rather than implying a field the user can't find.
    if (!defaultTitle.trim()) return 'This action needs a title before it can be pushed.'
    if (provider === 'jira') {
      if (!cloudId) return `Pick a ${providerName} site in Settings first.`
      if (!jiraProjectId) return 'Pick a project.'
      if (!jiraIssueTypeId) return 'Pick an issue type.'
      // CREATE WAITS FOR THE CREATE SCREEN. Until compose-meta answers, the wall
      // is unknown — and a create that goes ahead in ignorance of a required
      // custom field is exactly the create-and-pray this form exists to
      // prevent. A blocked half-second beats a 400 naming a customfield_10099
      // the user has never heard of.
      if (jiraMetaLoading) return 'Reading this issue type’s create screen…'
      if (jiraMeta) {
        if (jiraMeta.blocking_fields.length > 0) {
          const names = jiraMeta.blocking_fields.map((f) => f.name).join(', ')
          return `This issue type requires fields Dial8 can't fill: ${names}.`
        }
        if (jiraMeta.due_date_required && !jiraDueDate) return 'A due date is required.'
        if (jiraMeta.assignee_required && !jiraAssignee) return 'An assignee is required.'
        if (jiraMeta.priority_required && !jiraPriority) return 'A priority is required.'
        if (jiraMeta.labels_required && parseLabels(jiraLabels).length === 0) {
          return 'At least one label is required.'
        }
        const missingCustom = jiraMeta.custom_fields.find((f) => f.required && !jiraCustom[f.field_id])
        if (missingCustom) return `${missingCustom.name} is required.`
      }
      return null
    }
    if (provider === 'asana') {
      if (!asanaWorkspaceGid) return `Pick an ${providerName} workspace in Settings first.`
      if (!asanaProjectGid) return 'Pick a project.'
      return null
    }
    if (!linearTeamId) return 'Pick a team.'
    return null
  })()

  // ONE banner, whichever read failed first. The config, the option slots and
  // the create-screen read all fail the same way to the user (a dead token
  // fails all three at once), and three banners would be three times the noise
  // for the same fact.
  const activeFailure = configFailure ?? failure ?? jiraMetaFailure

  async function handleCreate() {
    if (blockedReason || creating) return
    setCreating(true)
    try {
      // LEAVING compose mode on success is the CALLER's job, not this form's.
      // The caller is what knows the whole outcome — it also closes the menu and
      // republishes the links — and a form that additionally called `onCancel`
      // would fire the transition twice, which every `onComposeChange` listener
      // would see as a second, spurious end. A failed push leaves compose mode
      // open with every choice intact: the fixable failures (a required field, a
      // project that rejected the type) are fixed right here, and tearing the
      // strip down would make the user rebuild the form to change one field.
      await onCreate(buildOverrides())
    } finally {
      // A SUCCESSFUL push unmounts this form (the caller ends compose mode), so
      // the state update would land on a dead component. The failure path is the
      // one that needs the flag cleared — it stays mounted for the retry.
      if (mountedRef.current) setCreating(false)
    }
  }

  const loadingConfig = !config && !configFailure

  const fields = (
    <ComposeFields
      layout={layout}
      provider={provider}
      providerName={providerName}
      siteName={siteName}
      slot={slot}
      // Jira
      jiraProjectQuery={jiraProjectQuery}
      onJiraProjectQueryChange={setJiraProjectQuery}
      jiraProjectId={jiraProjectId}
      onJiraProjectChange={(id) => {
        const picked = slot<JiraProjectOption>('jira-projects').options.find((p) => p.id === id)
        setJiraProjectId(id)
        setJiraProjectKey(picked?.key ?? null)
        // Everything below a project is scoped to it. These are invalidated BY
        // the project change, not cleared by the user, so the dirty flag goes
        // with them — otherwise switching project would silently start sending
        // "unassigned".
        setJiraIssueTypeId(null)
        setJiraAssignee(null)
        dirtyFields.current.delete('assignee_account_id')
        setJiraPriority(null)
        setJiraCustom({})
        setJiraMeta(null)
      }}
      jiraIssueTypeId={jiraIssueTypeId}
      onJiraIssueTypeChange={setJiraIssueTypeId}
      jiraMeta={jiraMeta}
      jiraMetaLoading={jiraMetaLoading}
      jiraNativeUrl={jiraNativeUrl}
      jiraAssignee={jiraAssignee}
      onJiraAssigneeChange={markDirty('assignee_account_id', setJiraAssignee)}
      jiraPriority={jiraPriority}
      onJiraPriorityChange={setJiraPriority}
      jiraDueDate={jiraDueDate}
      onJiraDueDateChange={markDirty('due_date', setJiraDueDate)}
      jiraLabels={jiraLabels}
      onJiraLabelsChange={setJiraLabels}
      jiraCustom={jiraCustom}
      onJiraCustomChange={(fieldId, id) =>
        setJiraCustom((prev) => ({ ...prev, [fieldId]: id ?? '' }))
      }
      // Asana
      asanaProjectQuery={asanaProjectQuery}
      onAsanaProjectQueryChange={setAsanaProjectQuery}
      asanaProjectGid={asanaProjectGid}
      onAsanaProjectChange={setAsanaProjectGid}
      asanaSectionGid={asanaSectionGid}
      onAsanaSectionChange={markDirty('section_gid', setAsanaSectionGid)}
      asanaSectionSuppressed={!!asanaProjectGid && asanaProjectGid !== configured.asanaProjectGid}
      asanaAssignee={asanaAssignee}
      onAsanaAssigneeChange={markDirty('assignee_gid', setAsanaAssignee)}
      asanaDue={asanaDue}
      onAsanaDueChange={markDirty('due_on', setAsanaDue)}
      // Linear
      linearTeamId={linearTeamId}
      onLinearTeamChange={setLinearTeamId}
      linearProjectId={linearProjectId}
      onLinearProjectChange={markDirty('project_id', setLinearProjectId)}
      linearAssignee={linearAssignee}
      onLinearAssigneeChange={markDirty('assignee_id', setLinearAssignee)}
      linearPriority={linearPriority}
      onLinearPriorityChange={setLinearPriority}
      linearSelectedLabels={linearLabels}
      onLinearToggleLabel={(id) =>
        setLinearLabels((prev) =>
          prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
        )
      }
      linearDue={linearDue}
      onLinearDueChange={markDirty('due_date', setLinearDue)}
    />
  )

  const failureNode = activeFailure ? (
    <ComposeFailure
      failure={activeFailure}
      provider={provider}
      providerName={providerName}
      onOpenSettings={onOpenSettings}
      onRetry={() => setRetryKey((k) => k + 1)}
      layout={layout}
    />
  ) : null

  const loadingNode = (
    <div
      className={cn(
        'flex items-center gap-2 text-xs text-muted-foreground',
        layout === 'stack' && 'py-6',
      )}
    >
      <ThinkingOrb state="working" size={20} theme="auto" />
      Loading {providerName}…
    </div>
  )

  /**
   * The wall's way out. Only offered when Jira itself is the reason Create is
   * off, and only when the site url was known — a link that 404s is worse than
   * no link.
   */
  // The pinned actions sit at chip height in `strip` so the row has ONE line,
  // and keep the app's button idiom (filled primary, outline secondary) — a
  // Create that looked like a property pill would stop reading as the button
  // that commits the push.
  const actionHeight = layout === 'strip' ? 'h-7' : 'h-8'

  const linkOut =
    provider === 'jira' && jiraMeta && jiraMeta.blocking_fields.length > 0 && jiraNativeUrl ? (
      <Button
        variant="outline"
        size="sm"
        className={cn('shrink-0 rounded-full text-xs', actionHeight)}
        onClick={() => void openExternalUrl(jiraNativeUrl)}
      >
        <ExternalLink className="mr-1.5 h-3 w-3" />
        Create in {providerName}
      </Button>
    ) : null

  const createButton = (
    <Button
      size="sm"
      className={cn('shrink-0 rounded-full text-xs', actionHeight)}
      disabled={!!blockedReason || !!activeFailure || creating || loadingConfig}
      onClick={() => void handleCreate()}
    >
      {creating && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
      Create in {providerName}
    </Button>
  )

  const cancelButton = (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        'shrink-0 text-xs',
        layout === 'strip' ? 'h-7 w-7 rounded-full p-0' : 'h-8',
      )}
      onClick={onCancel}
      disabled={creating}
      aria-label={`Cancel push to ${providerName}`}
    >
      {layout === 'strip' ? <X className="h-3.5 w-3.5" /> : 'Cancel'}
    </Button>
  )

  const reasonText = blockedReason && !activeFailure && !loadingConfig ? blockedReason : ''

  if (layout === 'stack') {
    return (
      <div className="space-y-3" data-compose-surface="stack" data-compose-provider={provider}>
        {failureNode ?? (loadingConfig ? loadingNode : <div className="space-y-4">{fields}</div>)}
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
            {reasonText}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {linkOut}
            {cancelButton}
            {createButton}
          </div>
        </div>
      </div>
    )
  }

  /**
   * THE STRIP.
   *
   * `overflow-x-auto` with `overflow-y-hidden` is the shape of the whole
   * feature: fields keep their width and the LINE gets longer, so an issue type
   * with nine custom fields scrolls rather than wrapping the row to three times
   * its height. `overflow-y-hidden` is not decoration — a lone `overflow-x-auto`
   * computes `overflow-y: auto`, which would make the strip a vertical scroll
   * container too and let a trackpad flick inside it swallow the page's own
   * scroll.
   *
   * ROW-CLICK SUPPRESSION. Every surface this mounts in has a gesture
   * underneath: the list row opens the detail panel on click, the board card
   * begins a drag on pointer-down. Picking a project inside the strip must do
   * neither. Both are stopped at the wrapper — the same belt-and-braces
   * ActionPlatformIcon uses, and for the same two reasons.
   *
   * CREATE IS PINNED AT THE FAR RIGHT, outside the scroller: it is the strip's
   * terminal action, and a Create that scrolled out of view with the fields
   * would be a button the user has to go looking for. `justify-end` on a
   * shrink-0 flex child keeps it against the row's right edge whatever the
   * scroller does.
   */
  return (
    <div
      // `items-center`, not `items-end`. Bottom-alignment was what the old
      // strip needed: fields were columns of different heights (caption +
      // control + optional hint) and only their bottom edges could be made to
      // agree. Every chip is now h-7, so there is ONE line to sit on and
      // centring it is what removes the last of the staircase.
      className="flex min-w-0 flex-1 items-center gap-2"
      data-compose-surface="strip"
      data-compose-provider={provider}
      // NOT preventDefault: the controls inside need their own default
      // behaviour (a date input opening its picker, a text field taking focus).
      // Only the BUBBLE to the row is cut.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-hide',
          // Room for the focus ring on the first and last controls, which a
          // scroll container otherwise clips.
          'px-0.5 py-1',
        )}
        data-compose-scroller=""
      >
        {failureNode ?? (loadingConfig ? loadingNode : fields)}
      </div>
      {reasonText && (
        <p
          className="max-w-[180px] shrink-0 truncate text-[10px] text-muted-foreground"
          title={reasonText}
          data-compose-blocked=""
        >
          {reasonText}
        </p>
      )}
      <div className="flex shrink-0 items-center gap-1.5" data-compose-actions="">
        {linkOut}
        {createButton}
        {cancelButton}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The fields, in both layouts
// ---------------------------------------------------------------------------

interface Slot<T> {
  options: T[]
  loading: boolean
}

type SlotReader = <T,>(name: string) => Slot<T>

interface ComposeFieldsProps {
  layout: ComposeLayout
  provider: ComposeProvider
  providerName: string
  siteName: string | null
  slot: SlotReader

  jiraProjectQuery: string
  onJiraProjectQueryChange: (value: string) => void
  jiraProjectId: string | null
  onJiraProjectChange: (id: string) => void
  jiraIssueTypeId: string | null
  onJiraIssueTypeChange: (id: string | null) => void
  jiraMeta: JiraComposeMeta | null
  jiraMetaLoading: boolean
  jiraNativeUrl: string | null
  jiraAssignee: string | null
  onJiraAssigneeChange: (id: string | null) => void
  jiraPriority: string | null
  onJiraPriorityChange: (id: string | null) => void
  jiraDueDate: string
  onJiraDueDateChange: (value: string) => void
  jiraLabels: string
  onJiraLabelsChange: (value: string) => void
  jiraCustom: Record<string, string>
  onJiraCustomChange: (fieldId: string, id: string | null) => void

  asanaProjectQuery: string
  onAsanaProjectQueryChange: (value: string) => void
  asanaProjectGid: string | null
  onAsanaProjectChange: (gid: string) => void
  asanaSectionGid: string | null
  onAsanaSectionChange: (gid: string | null) => void
  asanaSectionSuppressed: boolean
  asanaAssignee: string | null
  onAsanaAssigneeChange: (gid: string | null) => void
  asanaDue: string
  onAsanaDueChange: (value: string) => void

  linearTeamId: string | null
  onLinearTeamChange: (id: string | null) => void
  linearProjectId: string | null
  onLinearProjectChange: (id: string | null) => void
  linearAssignee: string | null
  onLinearAssigneeChange: (id: string | null) => void
  linearPriority: number | null
  onLinearPriorityChange: (value: number | null) => void
  linearSelectedLabels: string[]
  onLinearToggleLabel: (id: string) => void
  linearDue: string
  onLinearDueChange: (value: string) => void
}

/**
 * Every field, in the order the dialog rendered them, for whichever provider.
 *
 * The ONE component both layouts share. It takes `layout` and hands it to each
 * `Field`, which is the only thing that varies — the gating (`meta?.has_*`), the
 * option sources and the values are identical, which is what makes "the sidebar
 * variant" a prop rather than a fork.
 */
function ComposeFields(props: ComposeFieldsProps) {
  const { layout, provider, providerName, siteName, slot } = props

  return (
    <>
      {/* THE TITLE IS NOT A FIELD HERE. The card already renders it — as the
          wrapping heading beside the platform mark on a row, as the panel
          header in the sidebar — and compose is a swap of the PROPERTY row
          underneath it, not a second place to say the same thing. A title chip
          beside the card's own title showed the value twice and invited the
          user to edit the copy that was not the one they were looking at.

          `overrides.title` is untouched at the API: AI and MCP callers still
          send a per-push title, and `buildOverrides` simply never produces one
          from this form now (see its comment). The UI stopped offering the
          choice; the wire protocol did not change.

          THE SITE IS NOT A CAPTION either. "In {siteName}" was a leading label
          for a value nobody can change in v1, and on the common setup where the
          Jira site is named for the workspace it read as noise ("In dial8", on
          a Dial8 screen). It survives where it is actually useful — as the
          Project chip's `title`, i.e. on hover of the field the site scopes. */}

      {provider === 'jira' && (
        <JiraFields
          layout={layout}
          providerName={providerName}
          siteName={siteName}
          projectQuery={props.jiraProjectQuery}
          onProjectQueryChange={props.onJiraProjectQueryChange}
          projects={slot<JiraProjectOption>('jira-projects')}
          projectId={props.jiraProjectId}
          onProjectChange={props.onJiraProjectChange}
          issueTypes={slot<JiraIssueTypeOption>('jira-issue-types')}
          issueTypeId={props.jiraIssueTypeId}
          onIssueTypeChange={props.onJiraIssueTypeChange}
          meta={props.jiraMeta}
          metaLoading={props.jiraMetaLoading}
          nativeCreateUrl={props.jiraNativeUrl}
          users={slot<JiraUserOption>('jira-users')}
          assignee={props.jiraAssignee}
          onAssigneeChange={props.onJiraAssigneeChange}
          priority={props.jiraPriority}
          onPriorityChange={props.onJiraPriorityChange}
          dueDate={props.jiraDueDate}
          onDueDateChange={props.onJiraDueDateChange}
          labels={props.jiraLabels}
          onLabelsChange={props.onJiraLabelsChange}
          custom={props.jiraCustom}
          onCustomChange={props.onJiraCustomChange}
        />
      )}

      {provider === 'asana' && (
        <AsanaFields
          layout={layout}
          projectQuery={props.asanaProjectQuery}
          onProjectQueryChange={props.onAsanaProjectQueryChange}
          projects={slot<AsanaProjectOption>('asana-projects')}
          projectGid={props.asanaProjectGid}
          onProjectChange={props.onAsanaProjectChange}
          sections={slot<AsanaSectionOption>('asana-sections')}
          sectionGid={props.asanaSectionGid}
          onSectionChange={props.onAsanaSectionChange}
          sectionSuppressed={props.asanaSectionSuppressed}
          users={slot<AsanaUserOption>('asana-users')}
          assignee={props.asanaAssignee}
          onAssigneeChange={props.onAsanaAssigneeChange}
          due={props.asanaDue}
          onDueChange={props.onAsanaDueChange}
        />
      )}

      {provider === 'linear' && (
        <LinearFields
          layout={layout}
          teams={slot<LinearTeamOption>('linear-teams')}
          teamId={props.linearTeamId}
          onTeamChange={props.onLinearTeamChange}
          projects={slot<LinearProjectOption>('linear-projects')}
          projectId={props.linearProjectId}
          onProjectChange={props.onLinearProjectChange}
          members={slot<LinearMemberOption>('linear-members')}
          assignee={props.linearAssignee}
          onAssigneeChange={props.onLinearAssigneeChange}
          priority={props.linearPriority}
          onPriorityChange={props.onLinearPriorityChange}
          labels={slot<LinearLabelOption>('linear-labels')}
          selectedLabels={props.linearSelectedLabels}
          onToggleLabel={props.onLinearToggleLabel}
          due={props.linearDue}
          onDueChange={props.onLinearDueChange}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Per-provider forms
// ---------------------------------------------------------------------------

/**
 * The project picker, which is a SEARCHABLE LIST rather than a select.
 *
 * In `stack` that list is rendered inline, as the dialog did. In `strip` it
 * cannot be — a list box is 200px tall and the strip's whole contract is a
 * stable single-line height — so it moves into a popover whose trigger is a
 * normal-looking field control showing the current pick. The list INSIDE the
 * popover is the same `SearchableOptionList`, with the same search semantics
 * (server-side, replacing the browse list), so the Jira "matches on key" rule
 * and the clear-restores-browse fix both carry over untouched.
 */
function ProjectField({
  layout,
  label,
  hint,
  query,
  onQueryChange,
  loading,
  options,
  selectedId,
  onSelect,
  emptyMessage,
  placeholder,
}: {
  layout: ComposeLayout
  label: string
  /** Context for the field, shown as the chip's tooltip in `strip`. */
  hint?: string
  query: string
  onQueryChange: (value: string) => void
  loading: boolean
  options: Array<{ id: string; key?: string; name: string }>
  selectedId: string | null
  onSelect: (id: string) => void
  emptyMessage: string
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.id === selectedId) ?? null
  const list = (
    <SearchableOptionList
      query={query}
      onQueryChange={onQueryChange}
      loading={loading}
      options={options}
      selectedId={selectedId}
      onSelect={(id) => {
        onSelect(id)
        setOpen(false)
      }}
      emptyMessage={emptyMessage}
    />
  )

  if (layout === 'stack') {
    return (
      <Field label={label} hint={hint} required layout={layout}>
        {list}
      </Field>
    )
  }

  return (
    <Field label={label} hint={hint} required layout={layout}>
      {/* PORTALLED, because absolute positioning cannot escape this scroller.
          The strip is `overflow-x-auto` + `overflow-y-hidden`, and an
          absolutely-positioned descendant of a scroll container is CLIPPED BY
          it — the y-hidden axis crops the panel to the strip's own ~40px height,
          leaving a sliver, and changing the project is the whole point of the
          field. (An earlier comment here claimed the opposite; it was wrong.
          `position: absolute` escapes `overflow` only when an ancestor between
          the two establishes a new containing block, which nothing here does.)

          So: Radix Popover, whose content is portalled to the body — the same
          way the strip's `<Select>`s have always escaped, which is why they were
          never clipped and this field was. The extra focus layer the old comment
          feared is the accepted cost of a visible list; `modal={false}` keeps it
          from trapping focus or locking the page behind it, so the strip's own
          Escape binding still governs leaving compose once the popover is shut.

          Radix portals through the REACT tree, so events from the content still
          bubble to the strip's wrapper and hit its click/pointer-down
          suppression — the row underneath neither selects nor starts a drag.
          That is inherited, not re-implemented; do not "fix" it by removing the
          wrapper's handlers. */}
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            // The `Field` wrapper also carries this, but the wrapper is a
            // zero-padding shrink-0 box exactly the chip's size — putting it on
            // the trigger too means the tooltip answers wherever the pointer
            // actually lands, including over the chip's own text.
            title={hint}
            data-compose-project-trigger=""
            className={cn(
              chipTriggerClass,
              'max-w-[180px]',
              // Unpicked reads as the field's NAME, muted — the same "Project"
              // placeholder the action's own project pill shows when empty.
              !selected && 'text-muted-foreground',
              // The project is required for every provider that shows this
              // field, so an empty one is the wall in chip form.
              !selected && 'border-destructive/60',
            )}
          >
            <Folder className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate">
              {selected ? (selected.key ? `${selected.key} · ${selected.name}` : selected.name) : placeholder}
            </span>
            {loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[260px] p-1"
          data-compose-project-popover=""
          // The trigger keeps focus: this list's first control is its own search
          // input, and Radix's default autofocus-the-content would fight the
          // typing the user is about to do there.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {list}
        </PopoverContent>
      </Popover>
    </Field>
  )
}

function JiraFields({
  layout,
  providerName,
  siteName,
  projectQuery,
  onProjectQueryChange,
  projects,
  projectId,
  onProjectChange,
  issueTypes,
  issueTypeId,
  onIssueTypeChange,
  meta,
  metaLoading,
  nativeCreateUrl,
  users,
  assignee,
  onAssigneeChange,
  priority,
  onPriorityChange,
  dueDate,
  onDueDateChange,
  labels,
  onLabelsChange,
  custom,
  onCustomChange,
}: {
  layout: ComposeLayout
  providerName: string
  siteName: string | null
  projectQuery: string
  onProjectQueryChange: (value: string) => void
  projects: Slot<JiraProjectOption>
  projectId: string | null
  onProjectChange: (id: string) => void
  issueTypes: Slot<JiraIssueTypeOption>
  issueTypeId: string | null
  onIssueTypeChange: (id: string | null) => void
  meta: JiraComposeMeta | null
  metaLoading: boolean
  nativeCreateUrl: string | null
  users: Slot<JiraUserOption>
  assignee: string | null
  onAssigneeChange: (id: string | null) => void
  priority: string | null
  onPriorityChange: (id: string | null) => void
  dueDate: string
  onDueDateChange: (value: string) => void
  labels: string
  onLabelsChange: (value: string) => void
  custom: Record<string, string>
  onCustomChange: (fieldId: string, id: string | null) => void
}) {
  return (
    <>
      <ProjectField
        layout={layout}
        label="Project"
        // WHERE THE SITE NAME WENT. It used to be a leading caption on the
        // strip ("In dial8") — a label for a value v1 cannot change, which on a
        // site named after the workspace read as noise rather than as context.
        // The project is the thing the site actually scopes, so the fact rides
        // on that chip's tooltip: reachable when someone wonders which Jira
        // they are pushing into, absent from the line when they don't.
        hint={siteName ? `In ${siteName}` : undefined}
        query={projectQuery}
        onQueryChange={onProjectQueryChange}
        loading={projects.loading}
        options={projects.options.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
        selectedId={projectId}
        onSelect={onProjectChange}
        emptyMessage="No projects match."
        placeholder="Select a project"
      />

      <Field label="Issue type" required layout={layout}>
        <OptionSelect
          layout={layout}
          icon={<CircleDot className="h-3 w-3 shrink-0 opacity-70" />}
          error={!issueTypeId}
          ariaLabel="Issue type"
          value={issueTypeId}
          onChange={onIssueTypeChange}
          options={issueTypes.options}
          // In `strip` the placeholder IS the chip's label, so it is the field's
          // name rather than an instruction — "Select an issue type" in a pill
          // reads as a value. The "pick a project first" state still says so,
          // because that one is a reason the chip is dead, not a name.
          placeholder={
            projectId
              ? layout === 'strip'
                ? 'Issue type'
                : 'Select an issue type'
              : 'Pick a project first'
          }
          loading={issueTypes.loading}
          // Unpickable WHILE LOADING, not just before a project is chosen. The
          // slot deliberately keeps the previous parent's options during the
          // flight (so the field doesn't flash empty), which means what is
          // listed right now belongs to the project the user just navigated
          // AWAY from. A pick made there is a per-project type id that does not
          // exist in the new project — and it lands in the compose-meta fetch as
          // an invalid pair, whose failure banner then hides the very field
          // needed to correct it.
          disabled={!projectId || issueTypes.loading}
        />
      </Field>

      {metaLoading && (
        <p
          className={cn(
            'flex items-center gap-1.5 text-[11px] text-muted-foreground',
            layout === 'strip' && 'shrink-0 whitespace-nowrap',
          )}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Reading this issue type&apos;s create screen…
        </p>
      )}

      {/* THE WALL. A required field with no selectable values and no default
          cannot be composed generically — the create is known to fail, so it is
          named rather than attempted. In `strip` it is one line (the strip's
          height is fixed) with the full sentence on the title attribute; the
          way THROUGH it is the link-out button pinned beside Create. */}
      {meta && meta.blocking_fields.length > 0 && (
        layout === 'stack' ? (
          <div
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5"
            data-jira-blocking-wall=""
          >
            <p className="text-xs font-medium">This issue type needs more than Dial8 can fill</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {meta.blocking_fields.map((f) => f.name).join(', ')}{' '}
              {meta.blocking_fields.length === 1 ? 'is required' : 'are required'} on this create
              screen and {meta.blocking_fields.length === 1 ? 'has' : 'have'} no values Dial8 can
              choose from.
              {nativeCreateUrl ? ` Create it in ${providerName} instead, then link it back.` : ''}
            </p>
          </div>
        ) : (
          <div
            // The wall is a CHIP too — same height and radius as the fields, in
            // the warning colours it already carried. It sits in the row where
            // the fields it is blocking would be, and the way through it is the
            // link-out pinned beside Create.
            className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5"
            data-jira-blocking-wall=""
            title={`${meta.blocking_fields.map((f) => f.name).join(', ')} ${
              meta.blocking_fields.length === 1 ? 'is required' : 'are required'
            } on this create screen and ${
              meta.blocking_fields.length === 1 ? 'has' : 'have'
            } no values Dial8 can choose from.`}
          >
            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
            <span className="text-[10px]">
              Needs {meta.blocking_fields.map((f) => f.name).join(', ')}
            </span>
          </div>
        )
      )}

      {/* Each of the four natives is rendered ONLY when this project+type's
          create screen actually holds it. Sending one that isn't there 400s
          with "not on the appropriate screen". */}
      {meta?.has_assignee && (
        <Field label="Assignee" required={meta.assignee_required} layout={layout}>
          <OptionSelect
            layout={layout}
            icon={<User className="h-3 w-3 shrink-0 opacity-70" />}
            error={meta.assignee_required && !assignee}
            ariaLabel="Assignee"
            value={assignee}
            onChange={onAssigneeChange}
            options={users.options.map((u) => ({
              id: u.account_id,
              // Email is decorative and nullable by design (Jira honours each
              // user's privacy setting) — never the identity.
              name: u.email ? `${u.display_name} · ${u.email}` : u.display_name,
            }))}
            placeholder={meta.assignee_required && layout === 'strip' ? 'Assignee' : 'Unassigned'}
            {...(meta.assignee_required ? {} : { noneLabel: 'Unassigned' })}
            loading={users.loading}
          />
        </Field>
      )}

      {meta?.has_priority && (
        <Field label="Priority" required={meta.priority_required} layout={layout}>
          <OptionSelect
            layout={layout}
            icon={<Flag className="h-3 w-3 shrink-0 opacity-70" />}
            error={meta.priority_required && !priority}
            ariaLabel="Priority"
            value={priority}
            onChange={onPriorityChange}
            options={meta.priorities}
            placeholder={
              meta.priority_required && layout === 'strip' ? 'Priority' : 'Default priority'
            }
            {...(meta.priority_required ? {} : { noneLabel: 'Default priority' })}
          />
        </Field>
      )}

      {meta?.has_due_date && (
        <Field label="Due date" required={meta.due_date_required} layout={layout}>
          <DateField
            layout={layout}
            error={meta.due_date_required && !dueDate}
            value={dueDate}
            onChange={onDueDateChange}
            ariaLabel="Due date"
          />
        </Field>
      )}

      {meta?.has_labels && (
        <Field
          label="Labels"
          required={meta.labels_required}
          hint="Comma-separated. Jira labels are freeform text."
          layout={layout}
        >
          {layout === 'stack' ? (
            <Input
              value={labels}
              onChange={(e) => onLabelsChange(e.target.value)}
              className="h-8 text-xs"
              placeholder="backend, q3"
              aria-label="Labels"
            />
          ) : (
            // Freeform text, so a chip-shaped input for the same reason Title
            // is one. The comma rule moved from a caption under the box to the
            // placeholder and the Field's `title`, since a chip row has no
            // second line to put a hint on.
            <div className="relative">
              <Tag className="pointer-events-none absolute left-2.5 top-2 h-3 w-3 text-muted-foreground" />
              <input
                value={labels}
                onChange={(e) => onLabelsChange(e.target.value)}
                aria-label="Labels"
                placeholder="Labels"
                className={cn(
                  chipTriggerClass,
                  'w-[140px] pl-7 outline-hidden focus:ring-1 focus:ring-ring',
                  meta.labels_required && parseLabels(labels).length === 0 && chipErrorClass,
                )}
              />
            </div>
          )}
        </Field>
      )}

      {/* Required customs the form CAN collect: they carry allowedValues, so
          they become ordinary dropdowns keyed by fieldId. These are the fields
          that make the strip necessary — an issue type with six of them is what
          a fixed-width dialog could not show and a scroller can. */}
      {meta?.custom_fields.map((field) => (
        <Field key={field.field_id} label={field.name} required={field.required} layout={layout}>
          <OptionSelect
            layout={layout}
            icon={<CircleDot className="h-3 w-3 shrink-0 opacity-70" />}
            error={field.required && !custom[field.field_id]}
            ariaLabel={field.name}
            value={custom[field.field_id] || null}
            onChange={(id) => onCustomChange(field.field_id, id)}
            options={field.options}
            // The custom field's own name is the chip's placeholder — these are
            // the fields whose names nobody recognises, so "Select X" would
            // spend the chip's width on the word "Select".
            placeholder={layout === 'strip' ? field.name : `Select ${field.name}`}
          />
        </Field>
      ))}
    </>
  )
}

function AsanaFields({
  layout,
  projectQuery,
  onProjectQueryChange,
  projects,
  projectGid,
  onProjectChange,
  sections,
  sectionGid,
  onSectionChange,
  sectionSuppressed,
  users,
  assignee,
  onAssigneeChange,
  due,
  onDueChange,
}: {
  layout: ComposeLayout
  projectQuery: string
  onProjectQueryChange: (value: string) => void
  projects: Slot<AsanaProjectOption>
  projectGid: string | null
  onProjectChange: (gid: string) => void
  sections: Slot<AsanaSectionOption>
  sectionGid: string | null
  onSectionChange: (gid: string | null) => void
  /** The project was overridden, so the config's section map no longer applies. */
  sectionSuppressed: boolean
  users: Slot<AsanaUserOption>
  assignee: string | null
  onAssigneeChange: (gid: string | null) => void
  due: string
  onDueChange: (value: string) => void
}) {
  return (
    <>
      <ProjectField
        layout={layout}
        label="Project"
        query={projectQuery}
        onQueryChange={onProjectQueryChange}
        loading={projects.loading}
        options={projects.options.map((p) => ({ id: p.gid, name: p.name }))}
        selectedId={projectGid}
        onSelect={onProjectChange}
        emptyMessage="No projects match."
        placeholder="Select a project"
      />

      <Field
        label="Section"
        layout={layout}
        hint={
          sectionSuppressed
            ? // Not a warning — a fact about how Asana models sections. A gid
              // belongs to exactly one project, so the configured mapping is
              // meaningless the moment the project changes.
              "This project's own sections. Your workspace's section mapping doesn't apply here."
            : undefined
        }
      >
        <OptionSelect
          layout={layout}
          icon={<Rows3 className="h-3 w-3 shrink-0 opacity-70" />}
          ariaLabel="Section"
          value={sectionGid}
          onChange={onSectionChange}
          options={sections.options.map((s) => ({ id: s.gid, name: s.name }))}
          placeholder={projectGid ? 'No section' : 'Pick a project first'}
          noneLabel="No section"
          loading={sections.loading}
          // Same rule as Jira's issue type: mid-flight the list still holds the
          // OLD project's sections, and a section gid from another project is
          // sent as-is into `memberships`, which Asana rejects.
          disabled={!projectGid || sections.loading}
        />
      </Field>

      <Field label="Assignee" layout={layout}>
        <OptionSelect
          layout={layout}
          icon={<User className="h-3 w-3 shrink-0 opacity-70" />}
          ariaLabel="Assignee"
          value={assignee}
          onChange={onAssigneeChange}
          options={users.options.map((u) => ({
            id: u.gid,
            name: u.email ? `${u.name} · ${u.email}` : u.name,
          }))}
          placeholder="Unassigned"
          noneLabel="Unassigned"
          loading={users.loading}
        />
      </Field>

      <Field label="Due date" hint="Asana due dates are date-only." layout={layout}>
        <DateField layout={layout} value={due} onChange={onDueChange} ariaLabel="Due date" />
      </Field>
      {/* NO PRIORITY, deliberately. Asana has no native priority field — it is a
          per-project enum custom field or nothing at all — and a fake one would
          write to whatever field happened to be named "Priority" in the project
          the user picked. */}
    </>
  )
}

/**
 * Linear's label multiselect, in both layouts.
 *
 * The TOGGLES are byte-identical to what the strip rendered inline before —
 * same `aria-pressed`, same colour dot, same `data-linear-labels` container —
 * because they are what the suite drives and what `label_ids` is built from.
 * The only change is WHERE they live in `strip`: behind a summary chip, in a
 * popover portalled out of the scroller (the same escape `ProjectField` makes,
 * for the same clipping reason).
 */
function LinearLabelsControl({
  layout,
  teamId,
  labels,
  selectedLabels,
  onToggleLabel,
}: {
  layout: ComposeLayout
  teamId: string | null
  labels: Slot<LinearLabelOption>
  selectedLabels: string[]
  onToggleLabel: (id: string) => void
}) {
  const [open, setOpen] = useState(false)

  const toggles = labels.loading ? (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      Loading labels…
    </p>
  ) : labels.options.length === 0 ? (
    <p className="truncate text-[11px] text-muted-foreground/60">
      {teamId ? 'This team has no labels.' : 'Pick a team first.'}
    </p>
  ) : (
    <div
      className={cn(
        'flex gap-1.5',
        layout === 'stack'
          ? 'max-h-28 flex-wrap overflow-y-auto'
          : 'max-h-48 flex-wrap overflow-y-auto',
      )}
      data-linear-labels=""
    >
      {labels.options.map((label) => {
        const selected = selectedLabels.includes(label.id)
        return (
          <button
            key={label.id}
            type="button"
            onClick={() => onToggleLabel(label.id)}
            aria-pressed={selected}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              selected
                ? 'border-foreground/40 bg-accent'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {label.color && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: label.color }}
              />
            )}
            {label.name}
          </button>
        )
      })}
    </div>
  )

  if (layout === 'stack') return toggles

  const count = selectedLabels.length
  const chosen = labels.options.filter((l) => selectedLabels.includes(l.id))
  // One pick names itself; several become a count, because three label names in
  // a pill is the widest thing on the row.
  const summary = count === 0 ? 'Labels' : count === 1 ? chosen[0]?.name ?? '1 label' : `${count} labels`

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Labels"
          data-compose-labels-trigger=""
          disabled={!teamId}
          className={cn(chipTriggerClass, 'max-w-[160px]', count === 0 && 'text-muted-foreground')}
        >
          <Tag className="h-3 w-3 shrink-0 opacity-70" />
          <span className="truncate">{summary}</span>
          {labels.loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[240px] p-2">
        {toggles}
      </PopoverContent>
    </Popover>
  )
}

function LinearFields({
  layout,
  teams,
  teamId,
  onTeamChange,
  projects,
  projectId,
  onProjectChange,
  members,
  assignee,
  onAssigneeChange,
  priority,
  onPriorityChange,
  labels,
  selectedLabels,
  onToggleLabel,
  due,
  onDueChange,
}: {
  layout: ComposeLayout
  teams: Slot<LinearTeamOption>
  teamId: string | null
  onTeamChange: (id: string | null) => void
  projects: Slot<LinearProjectOption>
  projectId: string | null
  onProjectChange: (id: string | null) => void
  members: Slot<LinearMemberOption>
  assignee: string | null
  onAssigneeChange: (id: string | null) => void
  priority: number | null
  onPriorityChange: (value: number | null) => void
  labels: Slot<LinearLabelOption>
  selectedLabels: string[]
  onToggleLabel: (id: string) => void
  due: string
  onDueChange: (value: string) => void
}) {
  return (
    <>
      <Field label="Team" required layout={layout}>
        <OptionSelect
          layout={layout}
          icon={<Users className="h-3 w-3 shrink-0 opacity-70" />}
          error={!teamId}
          ariaLabel="Team"
          value={teamId}
          onChange={onTeamChange}
          options={teams.options.map((t) => ({
            id: t.id,
            name: t.key ? `${t.key} · ${t.name}` : t.name,
          }))}
          placeholder={layout === 'strip' ? 'Team' : 'Select a team'}
          loading={teams.loading}
        />
      </Field>

      <Field
        label="Project"
        hint="Optional — a Linear issue can live directly under its team."
        layout={layout}
      >
        <OptionSelect
          layout={layout}
          icon={<Folder className="h-3 w-3 shrink-0 opacity-70" />}
          ariaLabel="Project"
          value={projectId}
          onChange={onProjectChange}
          options={projects.options}
          placeholder={teamId ? 'No project' : 'Pick a team first'}
          noneLabel="No project"
          loading={projects.loading}
          // Mid-flight this still lists the previous team's projects.
          disabled={!teamId || projects.loading}
        />
      </Field>

      <Field label="Assignee" layout={layout}>
        <OptionSelect
          layout={layout}
          icon={<User className="h-3 w-3 shrink-0 opacity-70" />}
          ariaLabel="Assignee"
          value={assignee}
          onChange={onAssigneeChange}
          options={members.options.map((m) => ({
            id: m.id,
            name: m.full_name && m.full_name !== m.name ? `${m.name} · ${m.full_name}` : m.name,
          }))}
          placeholder="Unassigned"
          noneLabel="Unassigned"
          loading={members.loading}
          // Mid-flight this still lists the previous team's members.
          disabled={!teamId || members.loading}
        />
      </Field>

      <Field label="Priority" layout={layout}>
        <OptionSelect
          layout={layout}
          icon={<Flag className="h-3 w-3 shrink-0 opacity-70" />}
          ariaLabel="Priority"
          value={priority === null ? null : String(priority)}
          onChange={(value) => onPriorityChange(value === null ? null : Number(value))}
          // Static: Linear's scale is workspace-wide with no per-team variation,
          // so there is nothing to fetch.
          options={LINEAR_PRIORITIES.map((p) => ({ id: String(p.value), name: p.label }))}
          placeholder="Team default"
          noneLabel="Team default"
        />
      </Field>

      {/* Group labels are already excluded server-side — a group is a container
          whose id `issueCreate` rejects, so it can never appear here. */}
      {/* LABELS ARE MULTI-SELECT, so in `strip` they collapse into ONE chip
          that summarises the picks and opens the toggle list in a popover.
          Spilling every one of a team's labels straight onto the strip was the
          old behaviour, and it made a nested horizontal scroller inside a
          horizontal scroller — two scrollbars on one axis, and a Labels field
          that could be wider than every other field combined. One chip reading
          "3 labels" keeps the row uniform; the toggles are unchanged inside.
          `stack` still renders them inline, where wrapping is free. */}
      <Field
        label="Labels"
        hint={teamId ? undefined : 'Pick a team first.'}
        layout={layout}
      >
        <LinearLabelsControl
          layout={layout}
          teamId={teamId}
          labels={labels}
          selectedLabels={selectedLabels}
          onToggleLabel={onToggleLabel}
        />
      </Field>

      <Field label="Due date" layout={layout}>
        <DateField layout={layout} value={due} onChange={onDueChange} ariaLabel="Due date" />
      </Field>
      {/* NO WORKFLOW STATE. The push derives the chosen team's own not-started
          state server-side (resolveStartState in linear-push.ts) — a state
          belongs to exactly one team, so the configured team's state map is not
          a legal target for a different one, and asking the user to pick one
          would be asking them to know that. */}
    </>
  )
}
