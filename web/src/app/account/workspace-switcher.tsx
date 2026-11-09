'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useOptionalSettingsOverlay } from './(dashboard)/settings-overlay'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useWorkspaceTransition } from './workspace-transition'
import { cn } from '@/lib/utils'
import { LiquidPill, LiquidPillCard, LiquidPillFace, useLiquidPillHover } from '@/components/ui/liquid-pill'
import { toast } from 'sonner'
import { isDesktopApp } from '@/lib/platform'
import { useModKeyLabel } from '@/lib/hotkeys'
import { setClientWorkspaceId, getClientWorkspaceId, patchFetch } from '@/lib/workspace-fetch'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Layers,
  LayoutGrid,
  LogOut,
  Plus,
  Settings,
  Users,
} from 'lucide-react'
import { CreateWorkspaceWizard } from './create-workspace-wizard'
import { openWorkspacesVeil } from './workspaces-veil-events'
import {
  applyAccountWorkspaceSpan,
  beginWorkspaceSpanRead,
  setShowAllWorkspaces,
  useShowAllWorkspaces,
  useWorkspaceSpanAccountSync,
} from '@/lib/workspace-span'
import { applyAccountSettings, beginAccountSettingsRead } from '@/lib/account-setting'
// Sign-out must both remove the persisted per-user state (each workspace's
// main chat + Claude CLI session ids — none keyed by user, so on a shared
// device the next person would boot into them) AND disarm MainChatProvider's
// storage writers: the /sign-out navigation fires its pagehide flush, which
// would otherwise re-persist the chat right after the wipe. The helper lives
// in a leaf module (imports nothing from app code) because the main chat
// already imports from THIS file — importing it back would be a cycle.
import { beginPersistedTabStateWipe } from '@/app/account/(dashboard)/main-chat/state-wipe'
import {
  DEFAULT_EDITION_ID,
  withEffectiveSurface,
  getEdition,
  normalizeEditionId,
  normalizeFeatureOverrides,
  type EditionDefinition,
  type EditionId,
  type FeatureOverrides,
} from '@/lib/editions'

export interface WorkspaceItem {
  id: string
  name: string
  slug: string
  logo_url: string | null
  plan: string
  role: string
  description?: string | null
  member_count?: number
  /** The workspace's persona edition, already normalized (`full` when unset or
   *  unrecognized — see lib/editions). Drives which surfaces the client
   *  renders; see useWorkspaceEdition. */
  edition: EditionId
  /** Per-feature tri-state overrides on top of the edition, already normalized
   *  (`{}` when unset or garbage). Carried alongside the edition because the
   *  effective surface is the composition of the two — resolving one without
   *  the other would offer pages the workspace did not ask for. */
  featureOverrides: FeatureOverrides
}

// ─── Workspace cache context ─────────────────────────────────
// Prevents re-fetching workspace data every time SidebarNav remounts
// (e.g. peek overlay open/close).

interface WorkspaceCacheValue {
  workspaces: WorkspaceItem[]
  currentId: string | null
  /** Active workspace's normalized edition id. Read straight off the
   *  /api/account/workspace GET (which selects `*`), so it reflects an edition
   *  change as soon as the cache refreshes. */
  currentEdition: EditionId
  /** Active workspace's normalized feature overrides, from the same GET. */
  currentFeatureOverrides: FeatureOverrides
  /**
   * WHICH workspace `currentEdition`/`currentFeatureOverrides` were fetched
   * FOR. The freshness signal: those two are trustworthy only while this equals
   * `currentId`. Null before the first GET lands.
   *
   * Identity rather than a value heuristic, because "`full` with no overrides"
   * is genuinely ambiguous — it is both the commonest real answer and the
   * pre-fetch default — and an SPA workspace switch sets `currentId`
   * synchronously while `refresh()` is fire-and-forget. Without this the OLD
   * workspace's edition governed the NEW one until (and, if the refetch failed,
   * long after) the GET returned.
   */
  currentEditionWorkspaceId: string | null
  currentMemberId: string | null
  currentMemberDisplayName: string | null
  currentMemberAvatarUrl: string | null
  userEmail: string | null
  userAvatarUrl: string | null
  loaded: boolean
  setCurrentId: (id: string) => void
  refresh: () => Promise<void>
  /** `refresh` with one retry when the active-workspace GET didn't land. Used
   *  by the switch path, where a silently-failed refetch used to strand the new
   *  workspace on the previous one's edition. */
  refreshWithRetry: () => Promise<void>
}

const WorkspaceCacheCtx = createContext<WorkspaceCacheValue>({
  workspaces: [],
  currentId: null,
  currentEdition: DEFAULT_EDITION_ID,
  currentFeatureOverrides: {},
  currentEditionWorkspaceId: null,
  currentMemberId: null,
  currentMemberDisplayName: null,
  currentMemberAvatarUrl: null,
  userEmail: null,
  userAvatarUrl: null,
  loaded: false,
  setCurrentId: () => {},
  refresh: async () => {},
  refreshWithRetry: async () => {},
})

/** Shallow equality over a normalized override map (values are string literals,
 *  so a key/value walk is exact). Lets the provider keep the previous object
 *  identity when a refresh brought back the same overrides. */
function sameOverrides(a: FeatureOverrides, b: FeatureOverrides): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => a[k as keyof FeatureOverrides] === b[k as keyof FeatureOverrides])
}

export function WorkspaceCacheProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  // Defaults to `full` = today's behavior, so the app renders identically for
  // the whole window between mount and the first workspace fetch.
  const [currentEdition, setCurrentEdition] = useState<EditionId>(DEFAULT_EDITION_ID)
  // Empty = "no overrides" = follow the edition, which is also what every
  // workspace that never touched a toggle carries. Same zero-behavior default.
  const [currentFeatureOverrides, setCurrentFeatureOverrides] = useState<FeatureOverrides>({})
  // Set in the SAME fetchData pass that sets the two above, so the trio can
  // never disagree about which workspace they describe. Null until the first
  // /api/account/workspace GET lands.
  const [currentEditionWorkspaceId, setCurrentEditionWorkspaceId] = useState<string | null>(null)
  const [currentMemberId, setCurrentMemberId] = useState<string | null>(null)
  const [currentMemberDisplayName, setCurrentMemberDisplayName] = useState<string | null>(null)
  const [currentMemberAvatarUrl, setCurrentMemberAvatarUrl] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  /** Armed for the first `fetchData` pass only — see the diagnostic in it. */
  const firstFetchRef = useRef(true)

  /**
   * Returns whether the ACTIVE-workspace GET landed — i.e. whether
   * `currentEditionWorkspaceId` was advanced. The switch path uses it to retry
   * rather than leaving the new workspace running on its list row forever; the
   * boot path and plain refreshes ignore it (a failure there is already
   * recoverable by the identity fallback).
   */
  const fetchData = useCallback(async (signal?: { cancelled: boolean }): Promise<boolean> => {
    // Dev-only diagnostic for the boot race below. If the client workspace id
    // is still null when the FIRST of these GETs goes out, the interceptor has
    // nothing to put in `x-workspace-id`, so the server resolves the workspace
    // from the cookie and falls back to the user's OLDEST membership (see
    // lib/workspace.ts getCurrentWorkspaceId). That is precisely how a desktop
    // window opened with `?switch_to=` ends up rendering the wrong workspace —
    // a symptom that otherwise has to be inferred from the pages offered.
    if (firstFetchRef.current) {
      firstFetchRef.current = false
      if (process.env.NODE_ENV !== 'production' && getClientWorkspaceId() === null) {
        console.warn(
          '[workspace] first /api/account/workspace GET sent without x-workspace-id — resolving from cookie/oldest membership',
        )
      }
    }
    try {
      // The profile also carries the account's "Show all workspaces" answer
      // and its agent's look and name; the tokens let a flip or a save made
      // while this is in flight win over it.
      const spanReadToken = beginWorkspaceSpanRead()
      const settingsRead = beginAccountSettingsRead()
      const [listRes, currentRes, profileRes] = await Promise.all([
        fetch('/api/account/workspace/list'),
        fetch('/api/account/workspace'),
        fetch('/api/account/profile'),
      ])
      if (signal?.cancelled) return false
      if (listRes.ok) {
        const { workspaces: ws } = await listRes.json()
        // `settings` is the raw jsonb policy blob; only the edition and its
        // feature overrides are lifted out of it (normalized here so no
        // consumer ever handles a raw value) and the blob itself is dropped
        // rather than carried around the client.
        const rows = (ws ?? []) as (Record<string, unknown> & {
          settings?: { edition?: unknown; feature_overrides?: unknown } | null
        })[]
        setWorkspaces(
          rows.map(({ settings, ...w }) => ({
            ...(w as unknown as Omit<WorkspaceItem, 'edition' | 'featureOverrides'>),
            edition: normalizeEditionId(settings?.edition),
            featureOverrides: normalizeFeatureOverrides(settings?.feature_overrides),
          })),
        )
      }
      if (currentRes.ok) {
        const data = await currentRes.json()
        const activeId = (data.workspace?.id ?? null) as string | null
        setCurrentId(activeId)
        // The active workspace's row comes from `select('*')`, so it is the
        // freshest read of settings.edition / settings.feature_overrides —
        // newer than the list payload when either was just changed in settings.
        // Held separately so the hook resolves correctly even before the list
        // refetch lands.
        const activeSettings = (
          data.workspace as
            | { settings?: { edition?: unknown; feature_overrides?: unknown } | null }
            | undefined
        )?.settings
        setCurrentEdition(normalizeEditionId(activeSettings?.edition))
        // Kept identity-stable across refreshes: `normalizeFeatureOverrides`
        // returns a fresh object every call, and useWorkspaceEdition memoizes
        // on this reference — swapping in an equal-but-new object on every
        // poll would rebuild the edition object and re-render the tab bar
        // and the composer for nothing.
        setCurrentFeatureOverrides((prev) => {
          const next = normalizeFeatureOverrides(activeSettings?.feature_overrides)
          return sameOverrides(prev, next) ? prev : next
        })
        // Stamped LAST of the trio and from the same payload: this is what
        // makes the edition/overrides above trustworthy (see
        // currentEditionWorkspaceId). A GET that answered for workspace A can
        // never be mistaken for an answer about B.
        setCurrentEditionWorkspaceId(activeId)
        // Extract the current member's email + profile from the members list
        const members = data.members as {
          id: string
          user_id: string
          email: string
          display_name?: string | null
          avatar_url?: string | null
        }[] | undefined
        const memberId = data.currentMemberId as string | undefined
        if (memberId) setCurrentMemberId(memberId)
        if (members && memberId) {
          const me = members.find((m) => m.id === memberId)
          if (me?.email) setUserEmail(me.email)
          // Member display identity — consumed via useCurrentMemberProfile by
          // surfaces (e.g. capture comments) that would otherwise have to
          // refetch /api/account/workspace per mount just for these two fields.
          setCurrentMemberDisplayName(me?.display_name ?? null)
          setCurrentMemberAvatarUrl(me?.avatar_url ?? null)
        }
      }
      if (profileRes.ok) {
        // The signed-in user's profile picture (e.g. from Google OAuth),
        // used as the top-right avatar with a fallback to the workspace letter.
        const profile = await profileRes.json()
        setUserAvatarUrl(profile.avatar_url ?? null)
        // The switch follows the account across devices (lib/workspace-span).
        applyAccountWorkspaceSpan(profile, spanReadToken)
        // So does the agent's look and name: signing into another account
        // brings that account's (lib/account-setting).
        applyAccountSettings(profile, settingsRead)
      }
      return currentRes.ok
    } catch {
      // silently fail
      return false
    }
  }, [])

  const refresh = useCallback(async () => {
    await fetchData()
  }, [fetchData])

  /**
   * `refresh` with ONE retry when the active-workspace GET didn't land.
   *
   * Used by the switch path only. Before the identity check the harm of a
   * failed refetch was unbounded (the previous workspace's edition governed the
   * new one until something else reloaded); the identity check already caps
   * that at "falls back to the new workspace's list row", so this retry is the
   * cheap second half rather than the fix. Deliberately bounded — a retry loop
   * against a down API would just churn.
   */
  const refreshWithRetry = useCallback(async () => {
    if (await fetchData()) return
    await fetchData()
  }, [fetchData])

  // Patch window.fetch once to inject x-workspace-id header on /api/ calls
  useEffect(() => { patchFetch() }, [])

  // "Show all workspaces" set on another device (or another desktop window)
  // reaches this one when it comes back into view. The boot read is the
  // profile fetch above.
  useWorkspaceSpanAccountSync()

  // Keep the global workspace ID in sync so the fetch interceptor always sends
  // the right one — but NEVER on the null first commit.
  //
  // `currentId` is null until the first /api/account/workspace GET below lands,
  // and `setClientWorkspaceId(null)` clears BOTH the module-level id and
  // localStorage['dial8-workspace-id']. Unguarded, this effect therefore WIPED
  // the seed that workspace-fetch had just restored at module load (from
  // localStorage, or from a `?switch_to=<uuid>` URL param) — and it wiped it
  // before the load effect below fired its first GET, because effects run in
  // declaration order. That GET then went out with no `x-workspace-id` header,
  // so the server resolved the workspace from the cookie and fell back to the
  // user's OLDEST membership (lib/workspace.ts getCurrentWorkspaceId): a
  // freshly-opened desktop workspace window booted into the wrong workspace.
  //
  // Only a real id is ever pushed down from here. Clearing the client id is
  // sign-out's job, not this effect's.
  useEffect(() => { if (currentId) setClientWorkspaceId(currentId) }, [currentId])

  useEffect(() => {
    const signal = { cancelled: false }
    async function load() {
      await fetchData(signal)
      if (!signal.cancelled) setLoaded(true)
    }
    load()
    return () => { signal.cancelled = true }
  }, [fetchData])

  // Memoized over every field so a provider re-render that changed nothing
  // does not hand each useContext(WorkspaceCacheCtx) reader (the tab bar, the composer,
  // every useWorkspaceId() caller) a fresh object. This only
  // pays off because the fields themselves are identity-stable —
  // currentFeatureOverrides in particular is kept stable across refreshes (see
  // the setCurrentFeatureOverrides note in fetchData); setCurrentId is a state
  // setter and refresh / refreshWithRetry are useCallbacks.
  const value = useMemo<WorkspaceCacheValue>(
    () => ({
      workspaces,
      currentId,
      currentEdition,
      currentFeatureOverrides,
      currentEditionWorkspaceId,
      currentMemberId,
      currentMemberDisplayName,
      currentMemberAvatarUrl,
      userEmail,
      userAvatarUrl,
      loaded,
      setCurrentId,
      refresh,
      refreshWithRetry,
    }),
    [
      workspaces,
      currentId,
      currentEdition,
      currentFeatureOverrides,
      currentEditionWorkspaceId,
      currentMemberId,
      currentMemberDisplayName,
      currentMemberAvatarUrl,
      userEmail,
      userAvatarUrl,
      loaded,
      setCurrentId,
      refresh,
      refreshWithRetry,
    ],
  )

  return <WorkspaceCacheCtx.Provider value={value}>{children}</WorkspaceCacheCtx.Provider>
}

function WorkspaceAvatar({
  name,
  logoUrl,
  size = 'md',
}: {
  name: string
  logoUrl?: string | null
  size?: 'sm' | 'md'
}) {
  const dim = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-8 w-8 text-xs'

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={name}
        className={`${dim} rounded-md object-cover`}
      />
    )
  }

  return (
    <div
      className={`${dim} flex shrink-0 items-center justify-center font-semibold`}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

export function useWorkspaceId() {
  return useContext(WorkspaceCacheCtx).currentId
}

/**
 * The ACTIVE workspace's EFFECTIVE surface — its persona edition composed with
 * its per-feature overrides.
 *
 * This is the single client-side source of truth for surface gating — the
 * page cards (`/` pages, page kinds), the chat's starters and its tools all
 * read it. Derived from the workspace cache (no fetch of its own), and
 * it returns the `full` edition — today's exact behavior — while the cache is
 * still loading and for any workspace with no edition or overrides set, so an
 * unstamped workspace is indistinguishable from the pre-editions app.
 *
 * The return type is `EditionDefinition` (unchanged): the composed surface is
 * written back over the manifest entry's own fields, so every consumer reads
 * the composed one.
 *
 * The active workspace's own row is preferred over its entry in the list
 * payload: the list is a projection refreshed alongside it, but the row is the
 * authoritative `select('*')` read. Edition and overrides are taken from the
 * SAME source so a half-fresh composition is impossible.
 *
 * FRESHNESS IS IDENTITY-BASED, not value-based. The obvious heuristic — trust
 * the fetched edition unless it looks like the pre-fetch default (`full`, no
 * overrides) — conflates "genuinely full" with "not loaded yet", and the two
 * need opposite answers. It also silently outlives its own window: an SPA
 * workspace switch sets `currentId` synchronously while `refresh()` is
 * fire-and-forget with a bare catch, so a failed refetch left workspace A's
 * edition governing workspace B indefinitely. So the provider records WHICH
 * workspace the edition/overrides were fetched for, and this hook trusts them
 * only when that matches the active workspace; otherwise it falls back to the
 * list row for the active id, and to the `full` default when there is no row
 * either. A failed refetch now shows B's list-row edition, not A's.
 */
export function useWorkspaceEdition(): EditionDefinition {
  return useResolvedWorkspaceEdition().edition
}

/**
 * `useWorkspaceEdition` plus the provenance the caller needs to know whether
 * the answer is AUTHORITATIVE for the active workspace or a provisional
 * fallback (the list row, or the `full` default while nothing has loaded).
 *
 * Consumed by MainChatProvider's boot correction: the app must not treat the
 * pre-fetch `full` default as the workspace's real answer and permanently land
 * a sales/notes/brain workspace on My Actions. Surface gating should keep using
 * `useWorkspaceEdition` — being wrong-then-corrected for one frame of pages offered
 * is harmless, whereas a tab's history is a user-visible artifact.
 */
export function useResolvedWorkspaceEdition(): {
  edition: EditionDefinition
  /** True once the active workspace's OWN row has been read. */
  authoritative: boolean
} {
  const { workspaces, currentId, currentEdition, currentFeatureOverrides, currentEditionWorkspaceId } =
    useContext(WorkspaceCacheCtx)
  return useMemo(() => {
    // The ONE freshness test: was this edition fetched for the workspace that
    // is active right now? (`currentId` is null only before the first GET, when
    // nothing can be authoritative anyway.)
    const authoritative = !!currentId && currentEditionWorkspaceId === currentId
    const listed = currentId ? workspaces.find((w) => w.id === currentId) : undefined
    const id = authoritative ? currentEdition : listed?.edition ?? DEFAULT_EDITION_ID
    const overrides = authoritative ? currentFeatureOverrides : listed?.featureOverrides ?? {}

    return { edition: withEffectiveSurface(getEdition(id), overrides), authoritative }
  }, [workspaces, currentId, currentEdition, currentFeatureOverrides, currentEditionWorkspaceId])
}

export function useCurrentMemberId() {
  return useContext(WorkspaceCacheCtx).currentMemberId
}

/**
 * The current member's display identity (name + avatar), already fetched by
 * WorkspaceCacheProvider at app startup. Lets surfaces that need an authoring
 * identity (e.g. inline comments) build it synchronously instead of refetching
 * /api/account/workspace on every mount. Null until the cache resolves.
 */
export function useCurrentMemberProfile() {
  const { currentMemberId, currentMemberDisplayName, currentMemberAvatarUrl } =
    useContext(WorkspaceCacheCtx)
  return {
    memberId: currentMemberId,
    displayName: currentMemberDisplayName,
    avatarUrl: currentMemberAvatarUrl,
  }
}

/**
 * Refetch the workspace cache — nothing else.
 *
 * For surfaces that CHANGE a workspace's server-side state and must make the
 * app reflect it without a page reload. The workspace settings view is the
 * motivating case: switching edition or toggling a feature PATCHes settings,
 * but the tab bar and the composer render from this cache via
 * `useWorkspaceEdition`, so without a refetch they keep showing the old surface
 * until something else happens to reload the page.
 *
 * Deliberately narrower than `useWorkspaces`: that hook returns the workspaces
 * array too, which would subscribe a caller that only wants to invalidate to
 * every cache change and re-render it on each refresh. `refresh` is a stable
 * useCallback, so this hook's result is referentially stable and safe in a
 * dependency array.
 *
 * A caller mounted OUTSIDE WorkspaceCacheProvider (the standalone
 * /account/settings/* routes, which get only SettingsShell) receives the
 * context default — an async no-op. That is the correct behavior there: those
 * routes are full page loads with no live surface to go stale.
 */
export function useWorkspaceCacheRefresh(): () => Promise<void> {
  return useContext(WorkspaceCacheCtx).refresh
}

/**
 * The active workspace's feature overrides, straight from the cache.
 *
 * The surface (tab bar, composer) already renders from this cache, so
 * a control that TOGGLES features should read the same value rather than
 * fetching its own, so it shows exactly what the surface renders from,
 * including changes made in the settings card or in another tab.
 *
 * Outside WorkspaceCacheProvider this is the context default, `{}` — i.e. "no
 * overrides", which resolves to the edition's own preset.
 */
export function useWorkspaceFeatureOverrides(): FeatureOverrides {
  return useContext(WorkspaceCacheCtx).currentFeatureOverrides
}

/**
 * All workspaces the current user is a member of, plus the currently active
 * workspace id. Used by features like "move capture to workspace…" that need
 * to render a picker over the user's other workspaces.
 */
export function useWorkspaces() {
  const { workspaces, currentId, refresh } = useContext(WorkspaceCacheCtx)
  return { workspaces, currentId, refresh }
}

/**
 * Switch the active workspace behind the wipe/reveal curtain. Encapsulates the
 * full orchestration (recording guard, transition, switch POST, client header
 * + context update) so any surface — the switcher dropdown OR the workspaces
 * veil — switches identically. No-op when the target is already active.
 *
 * `{ curtain: false }` switches at once, with no curtain — for a caller that
 * already has the app out of sight while it happens (the workspaces veil).
 *
 * Returns whether a switch actually STARTED — false for every refusal (already
 * active, a capture is recording, not a workspace this member has). Callers
 * that only want the side effect can ignore it; callers that staged something
 * to happen on the other side (the main chat parks a card to open once the new
 * workspace's chat is in) need to know
 * that nothing is coming, so they can unstage it rather than leave it to
 * replay into an unrelated switch later.
 */
export function useSwitchWorkspace() {
  const { workspaces, currentId, setCurrentId, refreshWithRetry } = useContext(WorkspaceCacheCtx)
  const recordingCtx = useOptionalRecordingStable()
  const { beginTransition } = useWorkspaceTransition()

  return useCallback(
    (workspaceId: string, { curtain = true }: { curtain?: boolean } = {}): boolean => {
      if (workspaceId === currentId) return false
      if (recordingCtx?.isRecording) {
        toast.error('Stop the active capture before switching workspaces')
        return false
      }
      const target = workspaces.find((w) => w.id === workspaceId)
      if (!target) return false

      // Run the actual switch behind the full-screen wipe. The commit fn fires
      // once the curtain has fully covered the content panel, so the
      // teardown/refetch churn is never visible. Without the curtain it runs
      // at once: the caller is hiding the churn itself.
      const behind: typeof beginTransition = curtain ? beginTransition : (_target, commit) => commit()
      behind(
        { id: target.id, name: target.name, logoUrl: target.logo_url },
        () => {
          // Fire-and-forget: whatever hides the switch owns the reveal timing
          // (the curtain and the veil both watch teams loading), so we don't
          // await the POST here.
          fetch('/api/account/workspace/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace_id: workspaceId }),
          }).catch(() => {
            /* server still verifies membership on every API call */
          })
          // Update the fetch interceptor BEFORE setCurrentId so any API calls
          // triggered by context consumers already carry the new workspace
          // header (other providers' effects may fire first → race otherwise).
          setClientWorkspaceId(workspaceId)
          setCurrentId(workspaceId)
          // Re-fetch the member-scoped cache for the NEW workspace (mirrors
          // handleWorkspaceCreated). Member rows are workspace-scoped: without
          // this, currentMemberId/display name/avatar keep workspace A's member
          // row after an SPA switch, so surfaces that build an authoring
          // identity from the cache (capture inline comments) attribute with a
          // member id that doesn't exist in workspace B — own-comment
          // edit/delete affordances vanish until a full reload. The interceptor
          // was updated above, so refresh()'s /api/account/workspace GET
          // already carries the switched workspace header.
          //
          // Retrying variant: until this GET lands, the fetched edition and
          // overrides still describe the OUTGOING workspace, so
          // useWorkspaceEdition deliberately falls back to the new workspace's
          // list row. One retry gets the authoritative row back in the common
          // transient case rather than leaving it on that projection.
          void refreshWithRetry()
        },
      )
      return true
    },
    [currentId, workspaces, setCurrentId, refreshWithRetry, recordingCtx?.isRecording, beginTransition],
  )
}

export function WorkspaceSwitcher({
  variant = 'icon',
}: {
  /** `pill` — the top bar's far-right [ ◍ ] pill: the avatar alone (the
   *  workspace's name heads the menu it opens), opening the workspace/account
   *  menu. Replaces the old `tab-joined` pill, which also carried the
   *  content-panel collapse toggle; that toggle now lives beside the new-tab
   *  button in tab-bar.tsx.
   *  `rail` — the app rail's foot (rail/app-rail.tsx): the avatar, its menu
   *  opening up and to the right of it (Liam, 11-09: the one workspace menu,
   *  at the bottom left; the top bar's pill is a phone's only now). */
  variant?: 'icon' | 'full' | 'tab' | 'pill' | 'rail'
}) {
  const router = useRouter()
  const { workspaces, currentId, userEmail, userAvatarUrl, loaded, setCurrentId, refresh } = useContext(WorkspaceCacheCtx)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(false)
  // The pill's menu stays mounted (closed, it's a drop in the liquid), so its
  // rows would stagger in only once, at page load. Counting opens and keying
  // the rows by it replays their entrance every time the menu pours out.
  const [openCount, setOpenCount] = useState(0)
  useEffect(() => {
    if (open) setOpenCount((count) => count + 1)
  }, [open])
  const [userAvatarFailed, setUserAvatarFailed] = useState(false)
  const settingsOverlay = useOptionalSettingsOverlay()
  const switchTo = useSwitchWorkspace()

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The pill opens its menu on hover, the Capture pill's way (the other
  // variants open on click only).
  const faceRef = useRef<HTMLDivElement>(null)
  const { openNow, closeSoon, onPointerEnter } = useLiquidPillHover({
    open,
    setOpen,
    enabled: variant === 'pill',
    faceRef,
    cardRef: panelRef,
  })
  // Popover position (fixed coords). The panel is portaled to <body> so it
  // escapes the tab bar's overflow-hidden / overflow-x-auto clipping — without
  // a portal the menu would be cut off by the bar's fixed-height row.
  const [pos, setPos] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null)

  // Measure the trigger and place the panel just beneath it. Re-measures on
  // open and on scroll/resize while open.
  useLayoutEffect(() => {
    // The pill's menu pours out of its own liquid instead (see the pill below).
    if (!open || variant === 'pill') return
    const place = () => {
      const el = triggerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setPos({
        top: r.bottom + 8,
        // The rail's menu opens beside it, to the right, its foot level with the avatar's.
        left: variant === 'rail' ? r.right + 12 : r.left,
        right: window.innerWidth - r.right,
        bottom: window.innerHeight - r.bottom,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, variant])

  // Close the popover on outside-click and Escape. The panel is portaled, so it
  // isn't a DOM child of rootRef — check both the trigger root and the panel.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      setOpen(false)
      switchTo(workspaceId)
    },
    [switchTo],
  )

  const openInNewWindow = useCallback(async (ws: WorkspaceItem) => {
    try {
      const { tauriBridge } = await import('@/lib/tauri-bridge')
      await tauriBridge.openWorkspaceWindow(ws.id, ws.name)
    } catch (err) {
      toast.error('Failed to open workspace window')
      console.error(err)
    }
  }, [])

  const handleWorkspaceCreated = useCallback(async (workspaceId: string) => {
    setCreating(false)
    // Synchronously update the fetch interceptor so refresh() sends the new workspace ID
    setClientWorkspaceId(workspaceId)
    setCurrentId(workspaceId)
    await refresh()
    // No router.refresh() — context providers react to workspaceId change
  }, [setCurrentId, refresh])

  // Reset the broken-image flag when the user switches to a new avatar URL.
  useEffect(() => { setUserAvatarFailed(false) }, [userAvatarUrl])

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]

  // The signed-in user's photo (e.g. Google profile picture) takes priority
  // for the top-right icon. Falls back to the workspace letter when there's
  // no photo or it fails to load.
  const showUserAvatar = !!userAvatarUrl && !userAvatarFailed

  if (!loaded || !current) {
    // rail: the avatar's place, still (no pulse: the rail runs nothing at rest).
    if (variant === 'rail') {
      return (
        <div className="flex size-9 items-center justify-center">
          <div className="size-7 rounded-full bg-muted" />
        </div>
      )
    }
    // pill: mirror the live pill — the avatar alone — so the cold→loaded
    // handoff is seamless.
    if (variant === 'pill') {
      return (
        <div ref={rootRef} className="relative min-w-0 shrink">
          <div className="flex h-9 min-w-0 max-w-[260px] items-center overflow-hidden rounded-full border border-border bg-white px-1.5 shadow-sm dark:bg-black dark:shadow-none">
            <div className="h-6 w-6 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      )
    }
    if (variant === 'full' || variant === 'tab') {
      return (
        <div className="flex h-9 items-center gap-2 rounded-md px-2">
          <div className="h-5 w-5 animate-pulse rounded-md bg-background/60" />
          <div className="h-3.5 w-28 animate-pulse rounded bg-background/60" />
        </div>
      )
    }
    return (
      <div className="flex h-9 w-9 items-center justify-center">
        <div className="h-8 w-8 animate-pulse rounded-md bg-sidebar-accent" />
      </div>
    )
  }

  const openSettings = (section?: string) => {
    setOpen(false)
    if (settingsOverlay) settingsOverlay.openSettings(section)
    else router.push(section ? `/account/settings/${section}` : '/account/settings')
  }

  // Right-anchored variants (the profile avatar + the far-right pill) open
  // toward the left so the panel doesn't overflow the viewport edge.
  const align = variant === 'icon' || variant === 'pill' ? 'end' : 'start'

  const panelProps = {
    current,
    workspaces,
    currentId,
    onSwitch: switchWorkspace,
    onOpenInNewWindow: openInNewWindow,
    onSettings: () => openSettings(),
    onMembers: () => openSettings('workspace'),
    onCreate: () => {
      setOpen(false)
      setCreating(true)
    },
    onViewAll: () => {
      setOpen(false)
      // An event, not a call: this component also renders in the legacy
      // icon-rail, outside the dashboard that holds the veil.
      openWorkspacesVeil()
    },
  }

  // Morphing popover, portaled to <body> so it escapes the tab bar's overflow
  // clipping. Positioned fixed beneath the trigger; entrance is a CSS keyframe
  // (tailwindcss-animate `animate-in`) anchored to the trigger corner. The
  // resting state is fully visible, so it degrades gracefully without animation.
  // (The pill variant pours its menu out of its liquid instead.)
  const panel =
    open && pos && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={panelRef}
            role="menu"
            style={
              variant === 'rail'
                ? { position: 'fixed', left: pos.left, bottom: pos.bottom, transformOrigin: 'bottom left' }
                : {
                    position: 'fixed',
                    top: pos.top,
                    ...(align === 'end' ? { right: pos.right } : { left: pos.left }),
                    transformOrigin: align === 'end' ? 'top right' : 'top left',
                  }
            }
            className={cn(
              'z-[60] w-72 overflow-hidden rounded-3xl border border-border bg-popover p-2 text-popover-foreground shadow-xl',
              'animate-in fade-in-0 zoom-in-95 duration-200 ease-out',
              variant === 'rail' ? 'slide-in-from-left-1' : 'slide-in-from-top-1',
            )}
          >
            <WorkspacePanelContent {...panelProps} />
          </div>,
          document.body,
        )
      : null

  const createOverlay = creating ? (
    <CreateWorkspaceWizard
      userEmail={userEmail}
      onClose={() => setCreating(false)}
      onCreated={handleWorkspaceCreated}
    />
  ) : null

  if (variant === 'pill') {
    // The far-right top-bar pill: [ ◍ ]. One bordered+shadowed pill in
    // the bar's segmented-pill language; the whole pill is the trigger for the
    // workspace/account menu (triggerRef anchors the popover and must never
    // unmount). Sits LAST in the TabBar's trailing cluster, so it ends the bar
    // at the window's right edge.
    //
    // THE AVATAR ALONE, a round pill (Liam, 10-19: no caret, "just the
    // thumbnail", and no name: the workspace's name heads the menu it opens).
    //
    // The pill is made of the nav's liquid, like the chat composer's Capture
    // pill (see LiquidPill): the liquid is its surface — painted the plain header
    // pills' size and colour. HOVERING it (or a click, or keyboard focus)
    // pours the menu out of the pill. The button is
    // transparent with its own hover/open `bg-muted` on top of the liquid.
    return (
      <div ref={rootRef} className="relative min-w-0 shrink">
        <LiquidPill
          open={open}
          className="flex min-w-0 max-w-full"
          onFocus={openNow}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeSoon()
          }}
        >
          <LiquidPillFace
            ref={faceRef}
            className="min-w-0 max-w-[260px] overflow-hidden"
            onPointerEnter={onPointerEnter}
          >
            <button
              ref={triggerRef}
              onMouseDown={(e) => e.stopPropagation()}
              // Opens rather than toggles: the menu is usually open already
              // from the hover, and a click that shut it again would fight
              // the hand. Escape, a press outside, or moving away close it.
              onClick={openNow}
              aria-expanded={open}
              aria-haspopup="menu"
              aria-label="Workspace and account menu"
              className={cn(
                // w-full: a <button> with display:flex still sizes to fit-content,
                // so without it the pill ignores a squeezed parent and overflows.
                // px-1.5 round the 24px avatar: a 36px circle.
                'group flex h-full w-full min-w-0 items-center rounded-full px-1.5 text-[12px] font-normal transition-colors',
                open
                  ? 'bg-muted text-sidebar-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-muted hover:text-sidebar-foreground',
              )}
            >
              {/* Avatar — LEADS the pill. The signed-in user's photo, falling back
                  to the workspace logo then its letter. Ring tightens when open so
                  it still reads as the active affordance. */}
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full border bg-background text-[10px] font-semibold text-sidebar-foreground/70 transition-all',
                  open ? 'border-primary/40 ring-2 ring-primary/15' : 'border-border/60',
                )}
              >
                {showUserAvatar ? (
                  <img
                    src={userAvatarUrl ?? undefined}
                    alt={userEmail ?? 'Your profile'}
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                    onError={() => setUserAvatarFailed(true)}
                  />
                ) : current.logo_url ? (
                  <img src={current.logo_url} alt={current.name} className="h-full w-full object-cover" />
                ) : (
                  current.name.charAt(0).toUpperCase()
                )}
              </span>
            </button>
          </LiquidPillFace>
          {/* The workspace / account menu. Mounted all along — closed, it's
              collapsed into the pill and inert — so its height is known before
              it opens (where it parks depends on it); the rows remount on each
              open to replay their stagger. */}
          <LiquidPillCard ref={panelRef} width={288} role="menu" className="rounded-3xl p-2 text-popover-foreground">
            <WorkspacePanelContent key={openCount} {...panelProps} />
          </LiquidPillCard>
        </LiquidPill>
        {createOverlay}
      </div>
    )
  }

  if (variant === 'rail') {
    // The app rail's foot: the avatar, as the rail's other buttons are sized
    // (a 36px square holding a 28px circle); the menu opens beside it.
    return (
      <div ref={rootRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Workspace and account menu"
          title={current.name}
          className={cn(
            'flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            open && 'bg-foreground/[0.08]',
          )}
        >
          <span
            className={cn(
              'grid size-7 place-items-center overflow-hidden rounded-full border bg-background text-[10px] font-semibold text-sidebar-foreground/70',
              open ? 'border-primary/40 ring-2 ring-primary/15' : 'border-border/60',
            )}
          >
            {showUserAvatar ? (
              <img
                src={userAvatarUrl ?? undefined}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
                onError={() => setUserAvatarFailed(true)}
              />
            ) : current.logo_url ? (
              <img src={current.logo_url} alt="" className="h-full w-full object-cover" />
            ) : (
              current.name.charAt(0).toUpperCase()
            )}
          </span>
        </button>
        {panel}
        {createOverlay}
      </div>
    )
  }

  if (variant === 'tab') {
    return (
      <div ref={rootRef} className="relative shrink-0">
        <button
          ref={triggerRef}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Switch workspace"
          className={cn(
            // Matches the header's Getting-started pill: solid h-8 rounded-full
            // with a real border, white/black surface, and shadow-sm.
            'group flex h-8 max-w-[260px] shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] font-medium shadow-sm transition-colors',
            'bg-white dark:bg-black dark:shadow-none',
            open
              ? 'text-foreground'
              : 'text-foreground/80 hover:bg-muted hover:text-foreground',
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {current.name}
          </span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-foreground/40 transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </button>
        {panel}
        {createOverlay}
      </div>
    )
  }

  if (variant === 'full') {
    return (
      <div ref={rootRef} className="relative">
        <button
          ref={triggerRef}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
        >
          <div className="shrink-0">
            <WorkspaceAvatar name={current.name} logoUrl={current.logo_url} size="sm" />
          </div>
          <span className="min-w-0 truncate text-[13px] font-semibold text-sidebar-foreground">
            {current.name}
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 text-sidebar-foreground/50 transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </button>
        {panel}
        {createOverlay}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Workspace menu"
        className={cn(
          'flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border bg-white text-sidebar-foreground/70 shadow-sm transition-all hover:bg-muted hover:text-sidebar-foreground dark:bg-black dark:shadow-none',
          open ? 'border-primary/40 ring-2 ring-primary/15' : 'border-border/60',
        )}
      >
        {showUserAvatar ? (
          <img
            src={userAvatarUrl ?? undefined}
            alt={userEmail ?? 'Your profile'}
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setUserAvatarFailed(true)}
          />
        ) : (
          <WorkspaceAvatar name={current.name} logoUrl={current.logo_url} />
        )}
      </button>
      {panel}
      {createOverlay}
    </div>
  )
}

/**
 * Inner content of the morphing popover. Lists every workspace name-forward
 * (active highlighted), then the workspace actions. Rows stagger in via the
 * `animate-in` keyframe with a per-row animation delay; their resting state is
 * fully visible so they degrade gracefully if animations don't run.
 */
function WorkspacePanelContent({
  current,
  workspaces,
  currentId,
  onSwitch,
  onOpenInNewWindow,
  onSettings,
  onMembers,
  onCreate,
  onViewAll,
}: {
  current: WorkspaceItem
  workspaces: WorkspaceItem[]
  currentId: string | null
  onSwitch: (id: string) => void
  onOpenInNewWindow: (ws: WorkspaceItem) => void
  onSettings: () => void
  onMembers: () => void
  onCreate: () => void
  onViewAll: () => void
}) {
  const desktop = isDesktopApp()
  const settingsKey = useModKeyLabel(',')
  const headerName = current.name.toLowerCase().includes('workspace')
    ? current.name
    : `${current.name} workspace`

  return (
    <>
      {/* Header: the current workspace, name-forward. */}
      <div className="flex items-center gap-2.5 px-2 py-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-background">
          <WorkspaceAvatar name={current.name} logoUrl={current.logo_url} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{headerName}</div>
          {current.role && (
            <div className="truncate text-[11px] capitalize text-muted-foreground">
              {current.role}
            </div>
          )}
        </div>
      </div>

      <div className="my-1 h-px bg-border" />

      {/* Workspace list — name-forward, active one highlighted. */}
      <div className="px-1 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto py-0.5">
        {workspaces.map((ws, i) => {
          const active = ws.id === currentId
          return (
            <button
              key={ws.id}
              role="menuitem"
              onClick={() => (active ? undefined : onSwitch(ws.id))}
              style={{ animationDelay: `${30 + i * 25}ms` }}
              className={cn(
                'group flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left',
                'animate-in fade-in-0 slide-in-from-left-1 fill-mode-both duration-200 ease-out',
                'transition-colors',
                active
                  ? 'bg-accent'
                  : 'hover:bg-accent/60 focus-visible:bg-accent/60',
              )}
            >
              <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
                <WorkspaceAvatar name={ws.name} logoUrl={ws.logo_url} size="sm" />
              </div>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-sm',
                  active ? 'font-semibold' : 'font-medium',
                )}
              >
                {ws.name}
              </span>
              {active ? (
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <Check className="h-3.5 w-3.5" />
                </span>
              ) : desktop ? (
                <span
                  role="button"
                  tabIndex={0}
                  title="Open in new window"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenInNewWindow(ws)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground/40 opacity-0 transition hover:bg-background hover:text-muted-foreground group-hover:opacity-100"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <button
        role="menuitem"
        onClick={onCreate}
        className="mt-0.5 flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-dashed border-border">
          <Plus className="h-3.5 w-3.5" />
        </span>
        Create workspace
      </button>

      {/* View all workspaces — sends the app into the background and shows
          every workspace (the workspaces veil). */}
      <button
        role="menuitem"
        onClick={onViewAll}
        className="group/all mt-0.5 flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border">
          <LayoutGrid className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1">View all workspaces</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover/all:translate-x-0.5" />
      </button>

      {/* The app's one workspace-span switch — see lib/workspace-span. Only
          offered to someone in more than one workspace: with one, "all" and
          "this one" are the same list. */}
      {workspaces.length > 1 && (
        <>
          <div className="my-1 h-px bg-border" />
          <ShowAllWorkspacesToggle />
        </>
      )}

      <div className="my-1 h-px bg-border" />

      {/* Actions */}
      <PanelAction icon={<Settings className="h-4 w-4" />} label="Settings" shortcut={settingsKey} onClick={onSettings} />
      <PanelAction icon={<Users className="h-4 w-4" />} label="Invite and manage members" onClick={onMembers} />
      <a
        role="menuitem"
        href="/sign-out"
        onClick={beginPersistedTabStateWipe}
        className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-sm transition-colors hover:bg-accent/60"
      >
        <LogOut className="h-4 w-4" />
        <span>Sign out</span>
      </a>
    </>
  )
}

/**
 * "Show all workspaces": whether Actions, Projects, the bots, agent alerts and
 * the inbox show every workspace or only the active one. The whole row is the
 * control (a `menuitemcheckbox`), so the switch drawn at its end is a picture
 * of the state rather than a second, nested button. The menu stays open on a
 * flip, so the switch can be seen to move.
 */
function ShowAllWorkspacesToggle() {
  const showAll = useShowAllWorkspaces()
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={showAll}
      onClick={() => setShowAllWorkspaces(!showAll)}
      className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Show all workspaces</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          Actions, projects, agents and banners
        </span>
      </span>
      {/* Drawn like ui/switch (h-5 w-9 track, h-4 thumb), inert. */}
      <span
        aria-hidden
        className={cn(
          'inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm transition-colors',
          showAll ? 'bg-primary' : 'bg-input',
        )}
      >
        <span
          className={cn(
            'block h-4 w-4 rounded-full bg-background shadow-lg transition-transform',
            showAll ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  )
}

function PanelAction({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60"
    >
      {icon}
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-xs tracking-widest text-muted-foreground">{shortcut}</span>
      )}
    </button>
  )
}
