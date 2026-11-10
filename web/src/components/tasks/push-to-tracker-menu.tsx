'use client'

import { PreferenceActionButton } from '@/components/views/preference-action'

/**
 * "Push to…" — the ONE surface for sending a Native Intelligence action to an external task
 * tracker, wherever an action is shown.
 *
 * It replaces the per-provider "Asana" section that used to sit in the action
 * detail panel's properties sidebar. That section had to be rendered
 * unconditionally to be discoverable, which meant every workspace — including
 * the ones with no task tracker at all — carried a permanent Asana block in the
 * sidebar, and every new provider would have added another one. Here the
 * providers are DATA (GET /api/account/task-destinations), so a second tracker
 * is a row in an array, not another section.
 *
 * Two shapes of caller, both driven by the same menu:
 *   - an action that EXISTS (`actionId`) — the detail panel, an accepted
 *     capture row: picking a destination pushes it.
 *   - an action that does NOT exist yet (`onResolveAction`) — a still-suggested
 *     capture row: picking a destination CONFIRMS the suggestion first (the
 *     normal apply route, which drives apply-engine's createAction) and pushes
 *     the action it creates. The two steps are reported honestly: a confirm that
 *     succeeds and a push that fails says exactly that, and the row is left in
 *     its confirmed state so this same menu can retry the push alone.
 *
 * PICKING AN UNLINKED DESTINATION NOW OPENS INLINE COMPOSE rather than pushing
 * on the spot. The old gesture was one click and no choices: every push in a
 * workspace went to the one project an admin picked in Settings. The new one is
 * two clicks with every field prefilled from exactly that config — so the
 * default outcome is unchanged and the second click is where "actually, this one
 * goes to the design board, assigned to Ada" became possible at all. See
 * push-compose-panel.tsx.
 *
 * THE MENU DOES NOT DRAW THE COMPOSE FORM. It used to — a Dialog, rendered right
 * here — and that is exactly what Liam rejected ("I don't want it to be a
 * pop-up… we already have a property view on every action item"). The form now
 * belongs to the SURFACE, which is the only thing that knows where its own
 * property strip is: a list row puts it where the property chips were, the
 * detail panel puts it in the sidebar, the board card routes to the panel. So
 * this menu owns the compose STATE (which destination, and the push itself) and
 * hands the surface a `renderCompose` render prop plus `onComposeChange` so it
 * can react. A menu that rendered the form would be a menu deciding page layout.
 *
 * The LINKED half of the menu is untouched: Open-in and Unlink still act
 * immediately, because neither has anything to compose.
 *
 * Everything provider-specific is derived from the destination row, including
 * the routes — `/api/account/actions/[id]/[provider]` and its `[linkId]` unlink
 * twin — so a row for a provider that ships those endpoints needs no change to
 * the rendering or the request flow. Asana, Jira and Linear all go through here today;
 * the only per-provider literals are LINK_PROVIDERS and ProviderIcon below, and
 * both exist purely to keep server-only modules out of this client bundle.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ExternalLink, Loader2, MoreHorizontal, Plug, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { openExternalUrl } from '@/lib/open-external'
import { AsanaIcon, JiraIcon, LinearIcon } from '@/components/brand-icons'
import {
  PushComposePanel,
  type ComposeLayout,
  type ComposeOverrides,
  type ComposeProvider,
} from './push-compose-panel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cachedJson } from '@/lib/cached-fetch'
import { emitEntityUpdated } from '@/lib/entity-events'
import {
  TASK_DESTINATIONS_CHANGED,
  TASK_DESTINATIONS_URL,
} from '@/lib/tasks/destinations-events'
import { cn } from '@/lib/utils'
import { useWorkspaceId } from '@/app/account/workspace-switcher'

/** One configurable destination, as returned by /api/account/task-destinations. */
export interface TaskDestination {
  provider: string
  name: string
  /** False = connected but nothing picked to push INTO (a push would 400). */
  configured: boolean
  destinationLabel: string | null
}

/** A row of `action_external_task` — one action linked to one remote task. */
export interface ExternalTaskLink {
  id: string
  provider: string
  external_id: string
  external_url: string | null
  external_title: string | null
  completed: boolean
}

/**
 * Providers that expose `/api/account/actions/[id]/[provider]` link routes.
 *
 * Deliberately a literal rather than an import from `@/lib/tasks/*-config`:
 * those modules reach for the service-role Supabase client, which must never be
 * pulled into a client bundle. The cost of the literal is that a new provider
 * must be added HERE too, or its existing links are never fetched on load and
 * the menu silently offers to push an already-linked action again.
 */
const LINK_PROVIDERS = ['asana', 'jira', 'linear'] as const

/** Failure codes that are fixed in Settings rather than by retrying. */
const SETUP_CODES = new Set(['not_configured', 'not_connected', 'reconnect_required'])

function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  if (provider === 'asana') return <AsanaIcon className={className} />
  if (provider === 'jira') return <JiraIcon className={className} />
  if (provider === 'linear') return <LinearIcon className={className} />

  // A provider we have no brand mark for still gets a sensible glyph rather
  // than a hole in the menu.
  return <Upload className={className} />
}

export interface PushToTrackerMenuProps {
  /**
   * The action to push. Omit when the entity doesn't exist yet — then
   * `onResolveAction` must create it.
   */
  actionId?: string | null
  /**
   * Existing link rows. Pass them to own link state yourself; omit to let the
   * menu fetch (and then own) them — the action panel does the latter, which is
   * why the panel no longer fetches links itself.
   */
  links?: ExternalTaskLink[]
  /**
   * Does the controlled caller actually KNOW that `links` is the answer yet?
   *
   * Controlled mode normally implies knowledge — a caller passing rows owns them.
   * But a caller that fetches its own rows has a window before the first read
   * lands, and during it the only array it can pass is `[]`, which the trigger
   * reads as an affirmative "this action is in no tracker". For an action sitting
   * in Jira that is a lie, and it is precisely the lie the uncontrolled path's
   * `linksResolvedFor` hedge exists to prevent — a hedge a controlled caller had
   * no way to reach for.
   *
   * Pass `false` while a read is outstanding and the trigger hedges (neutral
   * glyph, neutral label) instead of claiming either way. Omitted means "yes,
   * these rows are the truth", which keeps every existing controlled caller
   * behaving exactly as before.
   */
  linksKnown?: boolean
  /** Fired after a successful push, with the link row the server returned. */
  onPushed?: (link: ExternalTaskLink, context: { created: boolean }) => void
  /**
   * Fired after a successful unlink (NI-side only — the remote task lives on).
   *
   * The provider rides along in `context` because the caller usually knows the
   * action by its PROVIDERS rather than by link id — a row payload's
   * `external_links` carries `{ provider }` and nothing else — and re-deriving
   * it would mean the caller keeping a second copy of the rows this menu owns.
   */
  onUnlinked?: (linkId: string, context: { provider: string }) => void
  /**
   * Create the action this push targets, returning its id — the confirm half of
   * the suggested-row gesture. Return null to abort the push (the caller has
   * already surfaced the confirm failure). Ignored when `actionId` is set.
   */
  onResolveAction?: () => Promise<string | null>
  /**
   * Open the in-dashboard settings overlay at `subPath`. Omit outside the
   * dashboard — the menu then hard-navigates to the same settings page.
   */
  onOpenSettings?: (subPath?: string) => void
  /**
   * Row-density variant (capture item rows): an outlined button matching the
   * row's other controls, and links are fetched only when the menu is opened
   * rather than on mount — a capture can render dozens of rows.
   */
  compact?: boolean
  /**
   * The caller has its own work in flight for this row (an accept/dismiss), so
   * the menu must not be opened against it — picking a destination now would
   * race a confirm that is already running.
   */
  disabled?: boolean
  /**
   * The action's title, used as the compose panel's starting summary.
   *
   * Optional because the panel degrades honestly without it (an empty title
   * field blocks Create until the user types one) and because two of the four
   * mount sites — the detail panel and the capture row — genuinely know it while
   * a bare menu might not.
   */
  actionTitle?: string | null
  /**
   * Replace the menu's own button with the caller's trigger — how the row
   * surfaces mount their far-left ActionPlatformIcon as the thing that opens
   * this menu.
   *
   * A RENDER PROP rather than `children`, because the trigger needs the state
   * the menu owns: whether links have resolved, and whether a push is in
   * flight. A caller that rendered its own icon blind would claim "Native Intelligence only"
   * for an action whose links nothing has read yet.
   */
  renderTrigger?: (state: {
    links: ExternalTaskLink[]
    linksKnown: boolean
    busy: boolean
    disabled: boolean
  }) => ReactNode
  /**
   * Draw the compose form where THIS surface's properties live.
   *
   * The menu owns which destination is being composed for and runs the push;
   * the surface owns the box. A list row swaps its property chips for the
   * returned node, the detail panel drops it into the properties sidebar as a
   * "Push to {Provider}" group. `null` means nothing is being composed, and the
   * surface renders its normal properties.
   *
   * A render prop rather than a `<PushComposePanel>` the caller mounts itself:
   * the props that form needs (the provider row, the push closure with its
   * confirm-then-push and toast handling) are all state this menu holds, and a
   * caller assembling them would be a second copy of `handlePush`.
   */
  renderCompose?: (node: ReactNode, state: { provider: string; providerName: string }) => ReactNode
  /**
   * Compose mode started or ended. For surfaces that must react beyond drawing
   * the form — the board card, which has no room for a strip and instead opens
   * the detail panel with compose pre-armed.
   */
  onComposeChange?: (destination: TaskDestination | null) => void
  /**
   * Where the compose form is drawn: a horizontal strip (row surfaces, the
   * default) or a vertical stack (the detail panel's sidebar).
   */
  composeLayout?: ComposeLayout
  /**
   * Enter compose mode for this provider on mount, without the menu being
   * opened at all — how the board card's click arrives at the detail panel with
   * the form already up. Ignored once the user has composed anything by hand.
   */
  autoComposeProvider?: string | null
}

export function PushToTrackerMenu({
  actionId,
  links: linksProp,
  linksKnown: linksKnownProp,
  onPushed,
  onUnlinked,
  onResolveAction,
  onOpenSettings,
  compact = false,
  disabled = false,
  actionTitle,
  renderTrigger,
  renderCompose,
  onComposeChange,
  composeLayout = 'strip',
  autoComposeProvider,
}: PushToTrackerMenuProps) {
  const workspaceId = useWorkspaceId()
  const controlled = linksProp !== undefined

  const [open, setOpen] = useState(false)
  /**
   * The destination being composed for, or null.
   *
   * Held as the whole destination row rather than a provider string because the
   * panel's heading, its Create button and every toast the push produces all
   * want the display NAME, and re-deriving it from a provider key would put a
   * second source of truth next to the one the menu already renders from.
   */
  const [composing, setComposing] = useState<TaskDestination | null>(null)
  const [links, setLinks] = useState<ExternalTaskLink[]>(linksProp ?? [])
  /**
   * The action whose link rows we have actually READ (or learned by pushing).
   * Compact rows defer the fetch to first open, so until this matches `actionId`
   * an empty `links` means "not asked yet", not "not linked" — and the trigger
   * must not dress itself as either. See `linksKnown`.
   */
  const [linksResolvedFor, setLinksResolvedFor] = useState<string | null>(null)
  /** null until the first open resolves — that's also the "Loading…" state. */
  const [destinations, setDestinations] = useState<TaskDestination[] | null>(null)
  /** The provider currently being pushed to — also the button's pending state. */
  const [pushing, setPushing] = useState<string | null>(null)
  const linksLoadedFor = useRef<string | null>(null)
  /**
   * Bumped by every local link mutation (push / unlink). An in-flight link
   * fetch that started before one of those must not land on top of it — the
   * fetch's answer predates the mutation, so applying it would silently undo a
   * push the user just watched succeed.
   */
  const linksVersion = useRef(0)
  /**
   * The same guard for destinations: bumped whenever Settings announces a
   * change, so a read that left before it can't overwrite the newer answer.
   */
  const destinationsVersion = useRef(0)
  /**
   * `open` for the window listener, which is registered once and would
   * otherwise close over the value at registration time.
   */
  const openRef = useRef(false)
  useEffect(() => {
    openRef.current = open
  }, [open])

  /**
   * A synchronously-readable mirror of `links`.
   *
   * The compose form calls `handlePush` from a closure that can predate a link
   * change made in this same menu — an unlink, or a first push whose result
   * already landed — so the render scope's `links` there is a stale snapshot.
   * Rebuilding the post-push set from it would drop a provider the action
   * genuinely has, and the republish below broadcasts that loss to every row on
   * the page. The ref is written by `mutateLinks` itself, so it is current the
   * instant a mutation is requested rather than one render later.
   */
  const linksRef = useRef<ExternalTaskLink[]>(linksProp ?? [])

  const mutateLinks = useCallback(
    (next: (prev: ExternalTaskLink[]) => ExternalTaskLink[]) => {
      linksVersion.current += 1
      const resolved = next(linksRef.current)
      linksRef.current = resolved
      setLinks(resolved)
      return resolved
    },
    [],
  )

  /**
   * Enter or leave compose mode, telling the surface either way.
   *
   * One funnel rather than bare `setComposing` calls, because every surface that
   * does something MORE than draw the form (the board card, which routes to the
   * detail panel) needs the transition and not just the value.
   *
   * A ROUTING SURFACE NEVER ENTERS THE MODE. Without `renderCompose` there is
   * nowhere for the form to go — the board card's `onComposeStart` hands the
   * pick to the detail panel and this menu is done. Holding `composing` anyway
   * would leave the card's menu permanently in a state it cannot show or leave:
   * `composing` stays set (no form, so no cancel and no create can clear it), a
   * later pick of the SAME provider is a no-op setState, and the surface never
   * hears the transition again. So the notification fires and the state does
   * not. The surfaces that DO draw the form are unaffected.
   */
  const changeCompose = useCallback(
    (destination: TaskDestination | null) => {
      if (renderCompose) setComposing(destination)
      onComposeChange?.(destination)
    },
    [onComposeChange, renderCompose],
  )

  // A controlled caller stays the source of truth.
  useEffect(() => {
    if (controlled) {
      linksRef.current = linksProp ?? []
      setLinks(linksProp ?? [])
    }
  }, [controlled, linksProp])

  const loadLinks = useCallback(async () => {
    if (controlled || !actionId) return
    if (linksLoadedFor.current === actionId) return
    linksLoadedFor.current = actionId
    const startedAt = linksVersion.current
    const results = await Promise.all(
      LINK_PROVIDERS.map(async (provider) => {
        try {
          const res = await fetch(`/api/account/actions/${actionId}/${provider}`)
          if (!res.ok) return []
          const data = (await res.json()) as { tasks?: ExternalTaskLink[] }
          return data.tasks ?? []
        } catch {
          return []
        }
      }),
    )
    if (linksVersion.current !== startedAt) return
    const loaded = results.flat()
    linksRef.current = loaded
    setLinks(loaded)
    setLinksResolvedFor(actionId)
  }, [controlled, actionId])

  // Uncontrolled links: the panel wants the "already linked" tint before anyone
  // opens the menu, so it loads on mount. Compact rows defer to first open —
  // one request per visible suggestion would be a burst for no visual gain.
  useEffect(() => {
    if (compact) {
      linksLoadedFor.current = null
      return
    }
    void loadLinks()
  }, [compact, loadLinks])

  const loadDestinations = useCallback(async () => {
    // Workspace-scoped SWR: the destination changes about once a quarter, and
    // every action row in a capture would otherwise re-ask for it. A re-open
    // refreshes in place rather than flashing back to "Loading…".
    //
    // But "about once a quarter" is a claim about the CALENDAR, not about this
    // tab: the quarterly change happens in Settings, which the user often has
    // open over the very capture this menu is on. A plain SWR read served the
    // pre-configuration answer for a whole TTL and then needed a SECOND open to
    // show the truth — the reported "it still says configure in settings".
    // `revalidate: 'always'` keeps the instant answer and repairs it behind the
    // user, so the stale window is one render rather than a minute.
    const startedAt = destinationsVersion.current
    // An answer that predates a mutation must never land on top of it — same
    // invariant as `linksVersion` above, and the reason both callbacks check.
    const apply = (data: { destinations: TaskDestination[] } | null) => {
      if (destinationsVersion.current !== startedAt) return
      setDestinations(data?.destinations ?? [])
    }
    apply(
      await cachedJson<{ destinations: TaskDestination[] }>(TASK_DESTINATIONS_URL, {
        scope: workspaceId,
        revalidate: 'always',
        onRevalidated: apply,
      }),
    )
  }, [workspaceId])

  /**
   * Settings changed what this menu is allowed to show. Drop the answer we have
   * so a closed menu re-reads on its next open, and re-read NOW if the user is
   * looking at it — the settings overlay sits above the capture, so the menu
   * underneath can be open while the destination is being configured.
   */
  useEffect(() => {
    const onChanged = () => {
      destinationsVersion.current += 1
      if (openRef.current) {
        void loadDestinations()
      } else {
        setDestinations(null)
      }
    }
    window.addEventListener(TASK_DESTINATIONS_CHANGED, onChanged)
    return () => window.removeEventListener(TASK_DESTINATIONS_CHANGED, onChanged)
  }, [loadDestinations])

  /**
   * The board card's hand-off: the detail panel opens with compose already up
   * for the provider the user picked on the card.
   *
   * Armed ONCE per provider value. `armedFor` is what stops a cancel from being
   * undone on the next render — without it, `autoComposeProvider` is still set
   * (the panel's prop has not changed) and the effect would immediately re-enter
   * the mode the user just left.
   */
  const armedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!autoComposeProvider) {
      armedFor.current = null
      return
    }
    if (armedFor.current === autoComposeProvider) return
    if (!destinations) {
      // The destination ROW is what compose needs (its display name is on the
      // Create button and in every toast), so arming waits for the list.
      // Nothing else triggers this read on a menu nobody has opened.
      void loadDestinations()
      return
    }
    const destination = destinations.find((d) => d.provider === autoComposeProvider)
    // A provider that is no longer configured must not open an un-creatable
    // form; the menu is still there to say so.
    if (!destination || !destination.configured) return
    armedFor.current = autoComposeProvider
    changeCompose(destination)
  }, [autoComposeProvider, destinations, loadDestinations, changeCompose])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Belt to the trigger's braces: the caller's row is busy, so there is
      // nothing safe to pick yet. Closing is always allowed.
      if (next && disabled) return
      setOpen(next)
      if (next) {
        void loadDestinations()
        if (compact) void loadLinks()
      }
    },
    [compact, disabled, loadDestinations, loadLinks],
  )

  const openSettings = useCallback(
    (provider?: string) => {
      const subPath = provider ? `connectors/${provider}/tasks` : 'connectors'
      if (onOpenSettings) {
        onOpenSettings(subPath)
        return
      }
      if (typeof window !== 'undefined') window.location.assign(`/account/settings/${subPath}`)
    },
    [onOpenSettings],
  )

  const linkFor = useCallback(
    (provider: string) => links.find((l) => l.provider === provider) ?? null,
    [links],
  )

  /**
   * Confirm-if-needed, then push. Returns whether the push landed, which is what
   * lets the compose panel stay open on a failure the user can fix by changing a
   * field rather than throwing their choices away.
   *
   * `overrides` is the compose panel's one-shot destination. Omitted — which is
   * what every non-compose caller does — the request carries NO BODY AT ALL and
   * the server takes the same path it took before the panel existed.
   */

  /**
   * Tell every surface showing this action which platforms it is in now.
   *
   * Emitted from HERE rather than from a per-mount callback because this is the
   * only place that holds the full post-mutation link set: the detail panel
   * never holds the link rows at all, and a callback that announced just the one
   * provider it touched would clobber the action's others. `external_links` is a
   * JOIN with no realtime channel, so without this event a push made from the
   * detail-panel toolbar or a capture proposal row leaves every list row and
   * board card drawing the Native Intelligence mark for an action that is now in Jira.
   *
   * The payload is the FULL link rows this menu holds, not a thinned
   * `{ provider }` projection. The row surfaces only ever read `.provider`, so
   * the richer rows cost them nothing — but the action DETAIL PANEL's listener
   * spreads these fields into the shared action cache, and the panel now SEEDS
   * its controlled menu from that cache on mount/swap. A provider-only stub
   * there is a row the menu takes as truth while it is missing everything a
   * link needs (`id`, `external_url`), which rendered a disabled "Open in …"
   * and aimed the Unlink DELETE at `/{provider}/undefined`. Emitting the rows
   * we already hold is also what keeps the cache FRESH across a push/unlink —
   * a revisit seeds the post-mutation truth instead of the pre-mutation rows.
   * `external_links` is not in unified-view-layout's JOINED_FK_FIELDS and is
   * not a grouping field, so the listener patches the array in place rather
   * than refetching or moving the card.
   *
   * `skipSelfMark` because no row write happened: the push inserts into
   * `action_external_task` and never touches `actions`, so no realtime echo of
   * our own is coming, and arming the 10s self-echo window would only suppress
   * OTHER users' changes to this action.
   */
  function republishLinks(id: string, next: ExternalTaskLink[]) {
    emitEntityUpdated(
      {
        entityType: 'action',
        id,
        fields: { external_links: next },
      },
      { skipSelfMark: true },
    )
  }

  async function handlePush(
    destination: TaskDestination,
    overrides?: ComposeOverrides,
  ): Promise<boolean> {
    if (pushing) return false
    setPushing(destination.provider)
    // Declared OUTSIDE the try so the catch can see it. A push that throws (a
    // dropped connection — precisely when this two-step gesture is most likely
    // to half-succeed) must still report that the action was confirmed into
    // existence; a bare "failed to push" invites the user to re-create or
    // re-dismiss a row that is now real.
    let created = false
    try {
      // Step 1 — make sure there IS an action. A suggested row confirms here.
      let id = actionId ?? null
      if (!id) {
        if (!onResolveAction) return false
        id = await onResolveAction()
        // The confirm failed and reported itself; claiming a push failure on top
        // would be a second, wrong story about the same click.
        if (!id) return false
        created = true
      }

      // Step 2 — push.
      const res = await fetch(`/api/account/actions/${id}/${destination.provider}`, {
        method: 'POST',
        // An EMPTY override object is not sent: `{ overrides: {} }` and no body
        // fold to the same server behaviour, and sending the former would make
        // every "open the panel, change nothing, Create" push structurally
        // different from the one-click push it replaced.
        ...(overrides && Object.keys(overrides).length > 0
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ overrides }),
            }
          : {}),
      })
      const data = (await res.json().catch(() => ({}))) as {
        task?: ExternalTaskLink
        error?: string
        code?: string
        /** Fields the provider refused, dropped to keep the issue (jira). */
        dropped_fields?: string[]
        /** False when an explicitly picked assignee never landed (jira). */
        assignee_set?: boolean
      }

      // 409 already_linked still carries the winning link — the action IS in the
      // tracker, which is what the user asked for, so adopt it rather than
      // reporting a failure for the state they wanted.
      const adopted = !res.ok && data.code === 'already_linked' && !!data.task

      if (res.ok || adopted) {
        const link = data.task
        if (link) {
          // Built from the CURRENT link set, not from the render scope's
          // `links`: this runs from the compose form's closure, which can
          // predate a link change made in this same menu, and rebuilding from
          // that stale snapshot would drop a provider — which `republishLinks`
          // then broadcasts to every row on the page as a real unlink.
          const next = mutateLinks((prev) => [link, ...prev.filter((l) => l.id !== link.id)])
          // We just learned this action's link state first-hand — the trigger can
          // stop hedging even if nothing ever fetched it (a suggested row that
          // confirmed into `id` mid-push never had links to read).
          setLinksResolvedFor(id)
          republishLinks(id, next)
          onPushed?.(link, { created })
        }
        const title = adopted
          ? `Already linked to ${destination.name}`
          : created
            ? `Action created and pushed to ${destination.name}`
            : `Pushed to ${destination.name}`

        // A push that quietly lost a field the user chose is still a success —
        // the issue exists — but it is not the success they asked for, so it
        // says which part did not land rather than showing a clean chip over a
        // wrong issue.
        const degraded = [
          data.dropped_fields?.length
            ? `${destination.name} refused ${data.dropped_fields.join(', ')} — created without ${data.dropped_fields.length > 1 ? 'them' : 'it'}.`
            : null,
          data.assignee_set === false ? 'The assignee could not be applied.' : null,
        ].filter(Boolean).join(' ')
        toast.success(title, {
          ...(degraded ? { description: degraded } : {}),
          ...(link?.external_url
            ? {
                action: {
                  label: created ? 'View task' : `View in ${destination.name}`,
                  onClick: () => void openExternalUrl(link.external_url!),
                },
              }
            : {}),
        })
        return true
      }

      const message = data.error || `Failed to push to ${destination.name}`
      const setupAction = SETUP_CODES.has(data.code ?? '')
        ? {
            action: {
              label: 'Open settings',
              onClick: () => openSettings(destination.provider),
            },
          }
        : {}

      if (created) {
        // Honest split outcome: the action is real, the push isn't. The row now
        // renders confirmed, so retrying the push alone is one click away.
        toast.error(`Action created, but the push to ${destination.name} failed`, {
          description: message,
          ...setupAction,
        })
      } else {
        toast.error(message, setupAction)
      }
      return false
    } catch {
      // Same split as the non-OK branch above: never tell a second, wrong story
      // about what this click did.
      toast.error(
        created
          ? `Action created, but the push to ${destination.name} failed`
          : `Failed to push to ${destination.name}`,
      )
      return false
    } finally {
      setPushing(null)
    }
  }

  async function handleUnlink(link: ExternalTaskLink, destinationName: string) {
    if (!actionId) return
    const previous = linksRef.current
    const remaining = mutateLinks((prev) => prev.filter((l) => l.id !== link.id))
    try {
      const res = await fetch(
        `/api/account/actions/${actionId}/${link.provider}/${link.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error('unlink failed')
      // The REMAINING providers, not an empty array: an action linked to Jira
      // and Asana that loses one is still in the other, and announcing []
      // would redraw every surface as NI-only.
      republishLinks(actionId, remaining)
      onUnlinked?.(link.id, { provider: link.provider })
      // The row is gone server-side; let a later open re-read the truth.
      linksLoadedFor.current = null
      toast.success(`Unlinked from ${destinationName}`, {
        description: `The ${destinationName} task was not deleted.`,
      })
    } catch {
      mutateLinks(() => previous)
      toast.error(`Failed to unlink from ${destinationName}`)
    }
  }

  /**
   * Do we know this action's link state at all? A controlled caller owns the
   * rows, and a row with no action yet has nothing to be linked TO — both are
   * knowledge. A compact row that hasn't been opened is not: it has never asked.
   *
   * A controlled caller may DISCLAIM that knowledge with `linksKnown={false}`
   * while its own read is in flight — the one case where owning the rows does not
   * mean having them yet. Absent the prop, controlled still implies known, so
   * existing callers are unaffected.
   */
  const linksKnown =
    (controlled ? linksKnownProp !== false : linksResolvedFor === actionId) || !actionId
  // Before destinations load, any link at all is enough to tint the button —
  // the tint answers "is this already somewhere else?", not "where".
  const isLinked = linksKnown && links.length > 0
  const firstLink = links[0]
  const busy = pushing !== null

  const trigger = renderTrigger ? (
    // The row surfaces draw their own far-left mark, but from the menu's state
    // rather than their own guess — `linksKnown` in particular, which no caller
    // can know without asking.
    renderTrigger({ links, linksKnown, busy, disabled })
  ) : (
    <PreferenceActionButton label="Task app options"
      variant={compact ? 'outline' : 'ghost'}
      size="sm"
      className={cn(
        'h-7 w-7 p-0',
        isLinked ? 'text-[#F06A6A] hover:text-[#F06A6A]' : 'text-muted-foreground hover:text-foreground',
      )}
      disabled={busy || disabled}
      // Unknown link state gets a neutral name: "Push to…" would promise the
      // action is unlinked, which nothing has checked yet.
      aria-label={!linksKnown ? 'Task app options' : isLinked ? 'Linked to a task app' : 'Push to…'}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : !linksKnown ? (
        // Neither the provider mark (linked) nor the upload arrow (unlinked) —
        // both are claims. Opening the menu resolves it.
        <MoreHorizontal className="h-3.5 w-3.5" />
      ) : isLinked && firstLink ? (
        <ProviderIcon provider={firstLink.provider} className="h-3.5 w-3.5" />
      ) : (
        <Upload className="h-3.5 w-3.5" />
      )}
    </PreferenceActionButton>
  )

  /**
   * The compose form, handed to the surface to place.
   *
   * Rendered only while composing, so the option loads happen on the pick that
   * asked for them and never once per mounted row. `key` is the provider: a
   * switch from Jira to Linear without an intervening cancel has to REMOUNT
   * rather than re-render, because every field's state (and the "entering
   * compose mode is mounting" contract the form is built on) is per-session.
   */
  const composeNode = composing ? (
    <PushComposePanel
      key={composing.provider}
      provider={composing.provider as ComposeProvider}
      providerName={composing.name}
      defaultTitle={actionTitle ?? ''}
      onOpenSettings={onOpenSettings}
      layout={composeLayout}
      onCancel={() => changeCompose(null)}
      onCreate={async (overrides) => {
        const ok = await handlePush(composing, overrides)
        // Compose mode ends on success only. A failed push keeps every choice
        // intact: the fixable failures (a required field, a project that
        // rejected the type) are fixed in this very strip, and tearing it down
        // would make the user rebuild the form to change one field.
        if (ok) {
          setOpen(false)
          changeCompose(null)
        }
        return ok
      }}
    />
  ) : null

  return (
    <>
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-[240px] text-xs leading-relaxed">
            {isLinked && firstLink
              ? `Linked to ${firstLink.external_title || 'a task'} — open the menu to view or unlink`
              : !linksKnown
                ? 'Task app options'
                : 'Push to…'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent align="end" className="w-64">
        {destinations === null ? (
          <DropdownMenuItem disabled>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Loading…</span>
          </DropdownMenuItem>
        ) : destinations.length === 0 ? (
          <DropdownMenuItem onSelect={() => openSettings()}>
            <Plug className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Connect a task app…</span>
          </DropdownMenuItem>
        ) : (
          destinations.map((destination, index) => {
            const link = linkFor(destination.provider)
            return (
              <DropdownMenuGroup key={destination.provider}>
                {index > 0 && <DropdownMenuSeparator />}
                {link ? (
                  <>
                    <DropdownMenuItem
                      disabled={!link.external_url}
                      onSelect={() => {
                        if (link.external_url) {
                          void openExternalUrl(link.external_url)
                        }
                      }}
                    >
                      <ProviderIcon provider={destination.provider} className="h-4 w-4" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">Open in {destination.name}</div>
                        {(link.external_title || link.completed) && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {link.completed ? 'Completed · ' : ''}
                            {link.external_title || link.external_id}
                          </div>
                        )}
                      </div>
                      {link.completed ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => void handleUnlink(link, destination.name)}
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>Unlink</span>
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem
                    disabled={!destination.configured || busy}
                    // COMPOSE, don't push. The destination row's label below is
                    // still the truth about where this will land by default —
                    // the form opens on exactly that and lets it be changed.
                    onSelect={() => changeCompose(destination)}
                  >
                    <ProviderIcon provider={destination.provider} className="h-4 w-4" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">Push to {destination.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {destination.configured
                          ? (destination.destinationLabel ?? 'Default destination')
                          : 'Pick a project in Settings'}
                      </div>
                    </div>
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            )
          })
        )}
        {/* The escape hatch. An unconfigured destination renders DISABLED with
            "Pick a project in Settings" — true, but a dead end without a way to
            get there from the menu that just said it. */}
        {destinations !== null && destinations.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openSettings()}>
              <Plug className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Task app settings…</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>

    {/* The compose form goes wherever the SURFACE puts it — its property strip,
        its sidebar. A caller with no `renderCompose` gets nothing: it has no
        property view to compose into, which is the honest outcome rather than a
        form dropped at the end of a dropdown. */}
    {composing && renderCompose?.(composeNode, {
      provider: composing.provider,
      providerName: composing.name,
    })}
    </>
  )
}
