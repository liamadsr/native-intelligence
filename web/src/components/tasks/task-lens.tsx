'use client'

/**
 * THE PROPERTY LENS — an action's properties, seen through the provider it was
 * pushed to.
 *
 * Every action in Native Intelligence has a properties affordance (the Edit-properties pill on
 * a capture's proposal cards, the Properties sidebar in the action detail panel)
 * and until now it always showed the same thing: Native Intelligence's own fields. But an
 * action that was pushed to Jira has TWO sets of properties — Native Intelligence's, and the
 * ticket's — and they drift the moment someone edits the ticket in Jira. The
 * lens is the second set: open properties on a pushed action and you see the
 * LINKED TICKET'S live field values, with a switcher to flip between Native Intelligence and
 * each provider the action is in.
 *
 * WHY THIS IS THE SAME CONTROLS, NOT NEW ONES. `compose-fields.tsx` already
 * holds the chip vocabulary — `OptionSelect`, `DateField`, `Field`,
 * `chipTriggerClass`, the `YYYY-MM-DD` crossing — extracted from the compose
 * panel precisely so a second reader of a provider's fields could speak it
 * without forking it. A lens chip must be indistinguishable from a compose chip
 * in the same row, and the only way to guarantee that is to be the same
 * component. What the lens adds is a different REQUEST LIFECYCLE over those
 * controls, which is the whole of the interesting code below.
 *
 * THE LIFECYCLE, and how it differs from compose:
 *
 *  - COMPOSE reads option lists (what a create COULD choose), holds every
 *    answer in local state, and writes once on Create. Nothing it shows is a
 *    fact about a remote ticket, because the ticket does not exist yet.
 *  - THE LENS reads a linked ticket's ACTUAL current values on mount, and writes
 *    PER FIELD — picking an assignee in the Jira lens updates the Jira ticket
 *    immediately, exactly as a Native Intelligence chip saves immediately. There is no Save
 *    button because there is no form: these are properties, and properties in
 *    this app commit on change.
 *
 * READ-THROUGH, NO CACHE. Every value is fetched live on mount and reconciled
 * from the write's own response. That is a deliberate refusal of the one cached
 * provider read this codebase has: task-destinations' 60s SWR window shipped a
 * bug where the push menu kept saying "configure in settings" after the user had
 * configured it, and fixing it took an invalidate call plus a change event wired
 * into every write funnel. Four editable fields across three providers, plus the
 * webhook read-back and unlink, would need that wiring on every one. Reading
 * live has one moving part and cannot go stale. Switching lenses REMOUNTS, so a
 * flip away and back is a refetch.
 *
 * OPTIMISTIC, WITH ROLLBACK. A chip that waited for a provider round-trip before
 * moving would feel broken — Jira is a WAN hop away and 400ms is visible. So the
 * chip moves first, the PATCH follows, and a `{ok:false}` puts the OLD value
 * back and says why in a toast. The alternative (a spinner per chip) buys
 * honesty the user did not ask for at the cost of the immediacy that makes these
 * read as properties rather than as a form.
 *
 * WHAT IS EDITABLE, and why the rest is drawn anyway. Assignee, due date and
 * labels are editable on all three providers; priority on Jira and Linear
 * (Asana has no native priority field). Project, issue type, team, section and
 * STATUS are drawn READ-ONLY — muted, no chevron, `Change in {Provider}` on
 * hover. Drawing them matters: a lens that showed only the four writable fields
 * would answer "which Jira project is this in?" with silence, and that is the
 * first question anyone opening a lens has. Not writing them matters more:
 * status has an owner already (the Native Intelligence→provider echo, whose CAS loop-breaker a
 * second writer would race), and project/issue-type/team moves rewrite
 * identifiers and invalidate the team-scoped ids the destination config is
 * built from.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  chipTriggerClass,
  DateField,
  Field,
  OptionSelect,
  type ComposeLayout,
} from './compose-fields'
import {
  Dial8Mark,
  providerDisplayName,
  type PlatformLink,
} from './action-platform-icon'
import { AsanaIcon, JiraIcon, LinearIcon } from '@/components/brand-icons'
import {
  LENS_PROVIDERS,
  LINEAR_PRIORITY_NAMES,
  type LensDetails,
  type LensFailureCode,
  type LensFields,
  type LensProvider,
  type LensRef,
} from '@/lib/tasks/task-lens'

/**
 * Canonical provider order, the SAME ranking the icon stack sorts by.
 *
 * Duplicated as a literal rather than imported from action-platform-icon (where
 * it is module-private) because the two uses are independent: the stack orders
 * MARKS, the switcher orders TABS, and the default-lens rule below reads the
 * first element. Keeping them in step is the point — an action whose stack draws
 * Asana first must not open its lens on Jira.
 */
const PROVIDER_RANK: Record<string, number> = { asana: 0, jira: 1, linear: 2 }

/** Providers whose links the switcher can offer, ordered canonically. */
export function orderLensProviders(providers: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const provider of providers) {
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (seen.has(provider)) continue
    seen.add(provider)
    out.push(provider)
  }
  return out.sort((a, b) => (PROVIDER_RANK[a] ?? 99) - (PROVIDER_RANK[b] ?? 99))
}

/**
 * The lens the properties view opens on.
 *
 * ≥1 link → the first linked provider by rank. No links → Native Intelligence, and the
 * switcher is not drawn at all, which is what makes this feature invisible to
 * every action that was never pushed.
 */
export function defaultLens(providers: string[]): string {
  const ordered = orderLensProviders(providers)
  return ordered[0] ?? 'dial8'
}

// ---------------------------------------------------------------------------
// useActionLinkProviders
// ---------------------------------------------------------------------------

/**
 * Which providers is this action linked to?
 *
 * Hits the SAME per-provider link route `PushToTrackerMenu.loadLinks` uses —
 * `GET /api/account/actions/{id}/{provider}` returning `{tasks: [...]}` — one
 * request per provider, deliberately the same shape rather than a new aggregate
 * endpoint. A second route answering the same question is a second thing to keep
 * true when a provider is added.
 *
 * ONCE PER MOUNT, gated by `enabled`, because both callers ask only when the
 * properties view is actually open: a capture with thirty proposal rows must not
 * fire ninety requests to decide whether to draw a switcher nobody opened. The
 * `loadedFor` ref is what makes "once" survive re-renders — a properties toggle
 * flipping open re-runs the effect, and a plain `loading` flag would let a
 * second pass through.
 *
 * A FAILED read reports NO providers rather than throwing: the honest fallback
 * for "we could not find out" is the Native Intelligence lens with no switcher, which is
 * exactly what an unpushed action shows. A banner here would be a banner on a
 * feature the user has not asked for yet.
 *
 * `links` IS THE ESCAPE HATCH, AND IT EXISTS BECAUSE OF A REAL DUPLICATE. The
 * detail panel already has a reader of these exact routes: it mounts
 * `PushToTrackerMenu`, which fetches them on mount to tint its button. A lens
 * hook that fetched anyway made every panel open ask the same question twice —
 * caught immediately by `action-detail-panel-push-menu.test.tsx`'s "fetches the
 * action's external-task links exactly once", which was written when the panel
 * had its own link effect beside the menu's and forbids precisely this shape.
 * So when `links` is passed the hook FETCHES NOTHING and derives the provider
 * list from them; the panel passes the rows it owns (it drives the menu in
 * CONTROLLED mode, so there is one fetcher and one source of truth). Only
 * surfaces with no other reader — the capture card, whose compact menu defers its
 * own fetch to first open — let this hook do the asking.
 *
 * ONCE-PER-MOUNT NEEDS AN INVALIDATION STORY, and it is `links` for BOTH callers.
 * The answer changes when the surface itself changes it — a push to Jira from the
 * row's own icon menu, with properties already open, must make a Jira tab appear.
 * Neither caller invalidates by asking again: the panel owns the rows outright and
 * edits them (`onPushed`/`onUnlinked`), and the capture card subscribes to the
 * `external_links` republish the menu ALREADY broadcasts on the entity bus and
 * feeds the result back in as `links`. Both therefore converge through supplied
 * mode, off an answer already in hand, with no second request. A `refetch()` was
 * considered and deliberately not added: it would be a third way to answer one
 * question, and neither surface has a use for it.
 */
export function useActionLinkProviders(
  actionId: string | null | undefined,
  { enabled, links }: { enabled: boolean; links?: PlatformLink[] },
): { providers: string[]; loading: boolean } {
  const [providers, setProviders] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  // Which action id we have already asked about — survives re-renders, so a
  // re-opened properties view does not re-ask.
  const loadedFor = useRef<string | null>(null)
  // Bumped on unmount and on an action change, so an in-flight answer for the
  // previous action cannot land in the new one's state.
  const generation = useRef(0)

  // The caller already knows. Derived rather than fetched, and memoized on the
  // provider STRINGS rather than the array identity — the menu rebuilds its rows
  // on every push and a fresh array each render would re-sort forever.
  const suppliedKey = links ? orderLensProviders(links.map((l) => l.provider)).join(',') : null
  const supplied = useMemo(
    () => (suppliedKey === null ? null : suppliedKey === '' ? [] : suppliedKey.split(',')),
    [suppliedKey],
  )

  useEffect(() => {
    if (supplied) return
    if (!enabled || !actionId) return
    if (loadedFor.current === actionId) return
    loadedFor.current = actionId
    const started = ++generation.current
    setLoading(true)
    void (async () => {
      const results = await Promise.all(
        LENS_PROVIDERS.map(async (provider) => {
          try {
            const res = await fetch(`/api/account/actions/${actionId}/${provider}`)
            if (!res.ok) return null
            const data = (await res.json()) as { tasks?: unknown[] }
            return Array.isArray(data.tasks) && data.tasks.length > 0 ? provider : null
          } catch {
            return null
          }
        }),
      )
      if (generation.current !== started) return
      setProviders(orderLensProviders(results.filter((p): p is LensProvider => p !== null)))
      setLoading(false)
    })()
  }, [actionId, enabled, supplied])

  // An action swap must not show the previous action's providers for a frame.
  useEffect(() => {
    if (loadedFor.current && loadedFor.current !== actionId) {
      loadedFor.current = null
      generation.current++
      setProviders([])
    }
  }, [actionId])

  useEffect(() => () => { generation.current++ }, [])

  if (supplied) return { providers: enabled ? supplied : [], loading: false }
  return { providers, loading }
}

// ---------------------------------------------------------------------------
// PropertyLensSwitcher
// ---------------------------------------------------------------------------

function LensMark({ provider, className }: { provider: string; className?: string }) {
  if (provider === 'dial8') return <Dial8Mark className={className} />
  if (provider === 'asana') return <AsanaIcon className={className} />
  if (provider === 'jira') return <JiraIcon className={className} />
  if (provider === 'linear') return <LinearIcon className={className} />
  return <span className={cn('rounded-full bg-muted-foreground/60', className)} aria-hidden="true" />
}

function lensDisplayName(provider: string): string {
  return provider === 'dial8' ? 'Native Intelligence' : providerDisplayName(provider)
}

/**
 * The lens picker — a segmented row of MARKS, not a row of words.
 *
 * Marks because the names are long ("Native Intelligence", "Asana", "Jira", "Linear" is 24
 * characters of chrome before a single property is drawn) and because the marks
 * are already this app's vocabulary for "which tracker": the same glyphs the
 * platform icon stacks on every row and board card. Someone who has seen the
 * stack on the row recognises the tabs without reading them.
 *
 * 24px hit targets — the smallest square that is still a comfortable pointer
 * target, and the same size the icon stack draws at, so the switcher does not
 * read as a bigger or louder control than the mark that led here. The active tab
 * takes `bg-secondary`, which is the same "this one is chosen" treatment the
 * properties toggle button uses one row up.
 *
 * `aria-pressed` rather than a `role="tablist"`: these buttons do not control
 * labelled tab panels with ids, they swap the content of a region the surface
 * owns, and a toggle-button group describes that honestly. The accessible name
 * is the sentence, not the glyph — "View Jira properties" — because a screen
 * reader user gets no help from a brand mark.
 */
export function PropertyLensSwitcher({
  providers,
  active,
  onChange,
  className,
}: {
  providers: string[]
  active: string
  onChange: (provider: string) => void
  className?: string
}) {
  return (
    <div
      className={cn('flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5', className)}
      data-lens-switcher=""
    >
      {providers.map((provider) => {
        const isActive = provider === active
        return (
          <button
            key={provider}
            type="button"
            data-lens-tab={provider}
            aria-pressed={isActive}
            aria-label={`View ${lensDisplayName(provider)} properties`}
            title={`View ${lensDisplayName(provider)} properties`}
            onClick={(e) => {
              // The surfaces underneath both have a gesture on the same pixels
              // (a capture row's click, the panel's own handlers), and switching
              // a lens must not also trigger them.
              e.stopPropagation()
              onChange(provider)
            }}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
              isActive ? 'bg-secondary' : 'hover:bg-muted',
            )}
          >
            <LensMark provider={provider} className="h-3.5 w-3.5" />
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Read-only chips
// ---------------------------------------------------------------------------

/**
 * A field the lens shows but will not write.
 *
 * The SAME pill as an editable chip — `chipTriggerClass`, `h-7`, the hairline
 * border — minus the affordances that would promise an edit: no chevron, muted
 * text, `cursor-default`. It is a `<span>` rather than a disabled `<button>`
 * because a disabled button is unfocusable and unreadable to a screen reader,
 * and this content is the answer to a real question ("which project?").
 *
 * `title` carries the way out. "Change in Jira" is the honest instruction: the
 * field IS editable, just not from here, and the tooltip says where.
 */
function ReadOnlyChip({
  field,
  ariaLabel,
  value,
  providerName,
  icon,
  layout,
}: {
  field: string
  ariaLabel: string
  value: string | null
  providerName: string
  icon: React.ReactNode
  layout: ComposeLayout
}) {
  const strip = layout === 'strip'
  const title = `Change in ${providerName}`
  const body = (
    <span
      data-lens-field={field}
      data-lens-readonly=""
      aria-label={ariaLabel}
      title={title}
      className={cn(
        strip
          ? cn(chipTriggerClass, 'cursor-default text-muted-foreground hover:bg-transparent')
          : 'flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground',
      )}
    >
      {icon}
      <span className={cn('truncate', strip && 'max-w-[120px]')}>{value ?? '—'}</span>
    </span>
  )
  if (strip) return body
  return (
    <Field label={ariaLabel} layout={layout}>
      {body}
    </Field>
  )
}

// ---------------------------------------------------------------------------
// The label control
// ---------------------------------------------------------------------------

/**
 * Labels — a multi-select over the provider's own label vocabulary.
 *
 * Modeled on the compose panel's `LinearLabelsControl` (a summary chip in
 * `strip` that opens a popover of toggles, inline toggles in `stack`) but kept
 * LOCAL to the lens rather than shared, because the two differ where it counts:
 * compose accumulates a selection and sends it once, and every toggle here is a
 * WRITE. That difference lives in `onCommit` — one full-replacement array per
 * click — and folding it into the compose control would put a save path inside a
 * component whose whole contract is that it has none.
 *
 * FULL REPLACEMENT, never add/remove deltas. The wire takes `label_ids` as the
 * complete set, so a toggle sends the whole array; the provider adapters diff it
 * server-side (Asana's tag endpoints genuinely need add/remove calls, and that
 * is the collector's problem, not the chip's).
 */
function LabelsControl({
  value,
  options,
  optionsLoading,
  editable,
  layout,
  providerName,
  onCommit,
  saving,
}: {
  value: LensRef[]
  options: LensRef[]
  optionsLoading: boolean
  editable: boolean
  layout: ComposeLayout
  providerName: string
  onCommit: (ids: string[]) => void
  saving: boolean
}) {
  const [open, setOpen] = useState(false)
  const strip = layout === 'strip'
  const selectedIds = useMemo(() => new Set(value.map((l) => l.id)), [value])
  const summary =
    value.length === 0 ? 'Labels' : value.length === 1 ? value[0].name : `${value.length} labels`

  // The union of "what the ticket has" and "what the provider offers", so a
  // label already ON the ticket is still listed when the option route has not
  // answered yet or does not include it — a Jira label is a free string and there
  // is no authoritative list at all.
  //
  // ABOVE THE READ-ONLY EARLY RETURN, not beside the code that uses it: a hook
  // after a conditional return is called in a different order on the render where
  // `editable` flips, which is exactly the render this component sees (the flag
  // arrives with the details fetch, so every lens mounts read-only for one frame
  // and then becomes editable).
  const rows = useMemo(() => {
    const byId = new Map<string, LensRef>()
    for (const label of value) byId.set(label.id, label)
    for (const label of options) if (!byId.has(label.id)) byId.set(label.id, label)
    return Array.from(byId.values())
  }, [options, value])

  if (!editable) {
    return (
      <ReadOnlyChip
        field="labels"
        ariaLabel={`${providerName} labels`}
        value={value.length > 0 ? value.map((l) => l.name).join(', ') : null}
        providerName={providerName}
        icon={<Tag className="h-3 w-3 shrink-0 opacity-70" />}
        layout={layout}
      />
    )
  }

  const toggles = (
    <div className="flex flex-wrap gap-1" data-lens-labels="">
      {rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          {optionsLoading ? 'Loading labels…' : `No ${providerName} labels available`}
        </p>
      )}
      {rows.map((label) => {
        const on = selectedIds.has(label.id)
        return (
          <button
            key={label.id}
            type="button"
            aria-pressed={on}
            aria-label={label.name}
            disabled={saving}
            onClick={() => {
              const next = on
                ? value.filter((l) => l.id !== label.id).map((l) => l.id)
                : [...value.map((l) => l.id), label.id]
              onCommit(next)
            }}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors disabled:opacity-50',
              on ? 'border-primary/40 bg-primary/10' : 'border-border hover:bg-muted',
            )}
          >
            {label.name}
          </button>
        )
      })}
    </div>
  )

  if (!strip) {
    return (
      <Field label={`Labels`} layout={layout}>
        <div data-lens-field="labels">{toggles}</div>
      </Field>
    )
  }

  return (
    <div className="relative shrink-0" data-lens-field="labels">
      <button
        type="button"
        data-lens-labels-trigger=""
        aria-label={`${providerName} labels`}
        title={`${providerName} labels`}
        onClick={() => setOpen((v) => !v)}
        className={cn(chipTriggerClass, value.length === 0 && 'text-muted-foreground')}
      >
        <Tag className="h-3 w-3 shrink-0 opacity-70" />
        <span className="max-w-[120px] truncate">{summary}</span>
      </button>
      {open && (
        // Anchored, not portalled: the strip is a horizontal scroller and a
        // portalled popover would need position tracking against a container
        // that moves under it. `z-20` clears the chips; `w-56` is the compose
        // labels popover's own width.
        <div className="absolute left-0 top-8 z-20 w-56 rounded-3xl border border-border bg-popover p-2 shadow-md">
          {toggles}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Failure banners
// ---------------------------------------------------------------------------

/**
 * The lens's own banner, on the failure taxonomy the push/echo paths share.
 *
 * FOUR readings, and the differences are the whole reason this is not one
 * message:
 *  - `reconnect_required` — the stored token is dead. Nothing retryable; the way
 *    out is Settings. (Deliberately NOT `ComposeFailure` from compose-fields:
 *    its headline is hardcoded "Reconnect {X} to compose", which is the wrong
 *    sentence for a read of an existing ticket. The extraction author flagged
 *    parameterising it as the lens author's edit to make; this is that edit,
 *    made HERE rather than there, so compose's ~50 pinned tests keep asserting
 *    bytes nobody moved.)
 *  - `task_missing` — RETRYABLE, because Jira's 404 and Linear's null issue are
 *    ambiguous by platform design (deleted, or invisible to this account). The
 *    link markers refuse a terminal reading for exactly this; the lens keeps
 *    their stance and offers Retry.
 *  - `task_deleted` — TERMINAL. An Asana gid that 404s really is gone, so there
 *    is nothing to retry and no button that would help.
 *  - everything else (`provider_error`, `link_not_found`, setup codes) —
 *    retryable with the message the route gave.
 */
function LensFailureBanner({
  code,
  message,
  providerName,
  provider,
  layout,
  onRetry,
  onOpenSettings,
}: {
  code: LensFailureCode | 'unknown'
  message: string
  providerName: string
  provider: LensProvider
  layout: ComposeLayout
  onRetry: () => void
  onOpenSettings?: (subPath?: string) => void
}) {
  const strip = layout === 'strip'

  if (code === 'reconnect_required') {
    return (
      <div
        className={cn(
          strip
            ? 'flex min-w-0 items-center gap-2'
            : 'flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3',
        )}
        data-lens-failure="reconnect"
      >
        <AlertTriangle className={cn('shrink-0 text-amber-500', strip ? 'h-3.5 w-3.5' : 'mt-0.5 h-4 w-4')} />
        <div className={cn(!strip && 'flex-1')}>
          <p className={cn(strip ? 'truncate text-xs' : 'text-sm font-medium')}>
            Reconnect {providerName} to see this ticket
          </p>
          {!strip && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Native Intelligence can no longer use your stored {providerName} authorization, so it can&apos;t read
              the linked ticket.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className={cn('h-7 shrink-0 text-xs', !strip && 'mt-2.5')}
            onClick={() => onOpenSettings?.(`connectors/${provider}/tasks`)}
          >
            Open {providerName} settings
          </Button>
        </div>
      </div>
    )
  }

  if (code === 'task_deleted') {
    return (
      <div
        className={cn(
          'flex items-center gap-2',
          strip ? 'min-w-0' : 'rounded-lg border border-border px-4 py-2.5',
        )}
        data-lens-failure="deleted"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className={cn('text-xs text-muted-foreground', strip && 'truncate')}>
          This ticket was deleted in {providerName}
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3',
        strip ? 'min-w-0' : 'justify-between rounded-lg border border-border px-4 py-2.5',
      )}
      data-lens-failure={code === 'task_missing' ? 'missing' : 'error'}
    >
      <p className={cn('text-xs text-muted-foreground', strip && 'truncate')}>{message}</p>
      <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Option loading
// ---------------------------------------------------------------------------

interface LensOptions {
  assignees: LensRef[]
  priorities: LensRef[]
  labels: LensRef[]
  loading: boolean
}

const EMPTY_OPTIONS: LensOptions = {
  assignees: [],
  priorities: [],
  labels: [],
  loading: false,
}

/**
 * The pickers' option lists, from the routes that already serve compose.
 *
 * NOT `useOptionSlots`: that hook's value is its per-slot generation counters
 * and cascade invalidation, which exist because compose's fields DEPEND on each
 * other (pick a project, the issue types change, the assignable users change).
 * A lens has no cascade — `option_scope` arrives fully resolved from the server,
 * once, and every list is fetched against it in parallel and never re-scoped.
 * One effect and one generation guard is the whole requirement.
 *
 * `cachedJson` is likewise skipped: the same read-through discipline as the
 * details fetch. These lists are small and a stale assignee roster showing a
 * departed teammate as assignable is a worse failure than one extra request.
 *
 * Jira priorities come from the EXISTING compose-meta route's `allowedValues`
 * (there is no priority-list endpoint, and the per-scheme allowed set is a
 * property of the project+issue type, which is exactly what compose-meta is
 * keyed by). Linear priorities are the fixed 0-4 scale and are never fetched.
 */
function useLensOptions(
  details: LensDetails | null,
  editable: { assignee: boolean; priority: boolean; labels: boolean },
): LensOptions {
  const [options, setOptions] = useState<LensOptions>(EMPTY_OPTIONS)
  const generation = useRef(0)

  const provider = details?.provider ?? null
  const scope = details?.option_scope
  // The scope is a fresh object on every details write, so the effect is keyed
  // on its VALUES rather than its identity — a PATCH response would otherwise
  // refetch every option list for scope ids that did not change.
  const scopeKey = scope
    ? [
        scope.cloud_id,
        scope.project_id,
        scope.project_key,
        scope.issue_type_id,
        scope.team_id,
        scope.workspace_gid,
      ].join('|')
    : ''

  useEffect(() => {
    if (!provider || !scope) {
      setOptions(EMPTY_OPTIONS)
      return
    }
    const started = ++generation.current
    let cancelled = false

    const get = async <T,>(url: string, extract: (data: unknown) => T[]): Promise<T[]> => {
      try {
        const res = await fetch(url)
        if (!res.ok) return []
        return extract(await res.json())
      } catch {
        return []
      }
    }

    void (async () => {
      setOptions((prev) => ({ ...prev, loading: true }))

      let assignees: LensRef[] = []
      let priorities: LensRef[] = []
      let labels: LensRef[] = []

      if (provider === 'jira') {
        const cloudId = scope.cloud_id ?? ''
        if (editable.assignee && cloudId && scope.project_key) {
          assignees = await get(
            `/api/account/jira/assignable-users?cloudId=${encodeURIComponent(cloudId)}&projectKey=${encodeURIComponent(scope.project_key)}`,
            (d) =>
              ((d as { users?: Array<{ account_id: string; display_name: string }> }).users ?? []).map(
                (u) => ({ id: u.account_id, name: u.display_name }),
              ),
          )
        }
        if (editable.priority && cloudId && scope.project_id && scope.issue_type_id) {
          priorities = await get(
            `/api/account/jira/compose-meta?cloudId=${encodeURIComponent(cloudId)}` +
              `&projectId=${encodeURIComponent(scope.project_id)}` +
              `&issueTypeId=${encodeURIComponent(scope.issue_type_id)}`,
            (d) => (d as { meta?: { priorities?: LensRef[] } }).meta?.priorities ?? [],
          )
        }
        // Jira labels are free strings with NO listable vocabulary — the only
        // labels the chip can offer are the ones already on the ticket, which
        // LabelsControl unions in on its own.
      } else if (provider === 'asana') {
        const workspace = scope.workspace_gid ?? ''
        if (editable.assignee && workspace) {
          assignees = await get(
            `/api/account/asana/users?workspace=${encodeURIComponent(workspace)}`,
            (d) =>
              ((d as { users?: Array<{ gid: string; name: string }> }).users ?? []).map((u) => ({
                id: u.gid,
                name: u.name,
              })),
          )
        }
        if (editable.labels && workspace) {
          labels = await get(
            `/api/account/asana/tags?workspace=${encodeURIComponent(workspace)}`,
            (d) =>
              ((d as { tags?: Array<{ gid: string; name: string }> }).tags ?? []).map((t) => ({
                id: t.gid,
                name: t.name,
              })),
          )
        }
      } else if (provider === 'linear') {
        const teamId = scope.team_id ?? ''
        if (editable.assignee && teamId) {
          assignees = await get(
            `/api/account/linear/members?teamId=${encodeURIComponent(teamId)}`,
            (d) =>
              ((d as { members?: Array<{ id: string; name: string; full_name: string | null }> })
                .members ?? []).map((m) => ({ id: m.id, name: m.full_name ?? m.name })),
          )
        }
        if (editable.labels && teamId) {
          labels = await get(
            `/api/account/linear/labels?teamId=${encodeURIComponent(teamId)}`,
            (d) => ((d as { labels?: LensRef[] }).labels ?? []).map((l) => ({ id: l.id, name: l.name })),
          )
        }
        if (editable.priority) {
          priorities = Object.entries(LINEAR_PRIORITY_NAMES)
            // 0 is "No priority", which the lens spells as the chip's own
            // "No priority" none-row rather than as a pickable option.
            .filter(([id]) => Number(id) > 0)
            .map(([id, name]) => ({ id, name }))
        }
      }

      if (cancelled || generation.current !== started) return
      setOptions({ assignees, priorities, labels, loading: false })
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, scopeKey, editable.assignee, editable.priority, editable.labels])

  return options
}

// ---------------------------------------------------------------------------
// TaskLens
// ---------------------------------------------------------------------------

const PROVIDER_ICON_CLASS = 'h-3 w-3 shrink-0 opacity-70'

export interface TaskLensProps {
  actionId: string
  provider: LensProvider
  layout: ComposeLayout
  onClose?: () => void
  className?: string
  onOpenSettings?: (subPath?: string) => void
}

interface LensState {
  details: LensDetails | null
  loading: boolean
  failure: { code: LensFailureCode | 'unknown'; message: string } | null
}

/**
 * The lens itself: one provider's live properties, as chips.
 *
 * TITLE-LESS by contract. The card or the panel already renders the action's
 * title above this, and a lens that repeated the TICKET's title would put two
 * near-identical strings on top of each other and invite the question of which
 * one an edit would change (neither — title is not writable through the lens).
 *
 * FIELD ORDER follows compose's, per provider, so a user who has composed a push
 * finds the same properties in the same places when they come back to read it.
 */
export function TaskLens({
  actionId,
  provider,
  layout,
  onClose,
  className,
  onOpenSettings,
}: TaskLensProps) {
  const providerName = providerDisplayName(provider)
  const strip = layout === 'strip'
  const [state, setState] = useState<LensState>({ details: null, loading: true, failure: null })
  // Bumped by Retry. A dependency of the fetch effect, which is the single
  // funnel a retry goes through — the same shape compose's `retryKey` has.
  const [retryKey, setRetryKey] = useState(0)

  /**
   * THREE COUNTERS, BECAUSE THERE ARE THREE INDEPENDENT RACES — and one shared
   * counter loses two of them.
   *
   * The shape this replaces had a single `generation` ref bumped by the details
   * fetch AND by every save, with every response checking it. That reads as one
   * cheap guard and is actually a correctness bug: save A (assignee) bumps,
   * save B (due date) bumps again, and now A's `{ok:false}` sees a changed
   * generation and returns EARLY — skipping its own rollback and its own toast.
   * The UI keeps a value the provider refused, silently, which is the single
   * worst failure this feature can have. Worse still, a whole-details snapshot
   * rollback then re-commits it: B's snapshot was taken after A's optimistic
   * patch, so B failing restores A's refused value a second time.
   *
   *  - `readGeneration` — the READ effect's alone (mount, provider change,
   *    Retry). Nothing else bumps it, so nothing else can make a read's answer
   *    look stale.
   *  - `lensEpoch` — "is the ticket on screen still the one this write was aimed
   *    at". Bumped by every read start and by unmount. A save that lands after a
   *    lens switch, a Retry or an unmount must NOT reconcile or roll back —
   *    there is nothing of its to put back.
   *  - `saveSeq` — PER FIELD. A save is the authority on its field only while it
   *    is that field's newest write; a newer save on the SAME field supersedes it
   *    (the old response neither reconciles nor rolls back). Saves on DIFFERENT
   *    fields never interfere, which is the whole point: they are writes to
   *    disjoint properties and the provider treats them as such.
   */
  const readGeneration = useRef(0)
  const lensEpoch = useRef(0)
  const saveSeq = useRef(new Map<string, number>())

  /**
   * Which fields have a write in flight — a SET, not one field.
   *
   * The single-field version was also a bug of its own: `setSavingField('due_date')`
   * overwrote a pending 'assignee', so the assignee chip re-enabled mid-flight and
   * the disabled guard it was supposed to provide evaporated. Per-field tracking
   * means each chip disables itself and only itself.
   *
   * MIRRORED IN A REF because a landing response has to ask "is anything ELSE
   * still in flight?" and it cannot ask the render's closure — that value is as
   * old as the render that created the callback, which for a concurrent save is
   * exactly the render before the other save started.
   */
  const [savingFields, setSavingFields] = useState<ReadonlySet<string>>(() => new Set())
  const pendingFields = useRef(new Set<string>())

  useEffect(() => {
    const started = ++readGeneration.current
    // A fresh read invalidates every write aimed at the PREVIOUS ticket.
    lensEpoch.current++
    saveSeq.current = new Map()
    pendingFields.current = new Set()
    setSavingFields(new Set())
    setState({ details: null, loading: true, failure: null })
    void (async () => {
      try {
        const res = await fetch(
          `/api/account/actions/${actionId}/task-details?provider=${encodeURIComponent(provider)}`,
        )
        const body = (await res.json().catch(() => null)) as
          | (LensDetails & { code?: never })
          | { ok?: false; code?: LensFailureCode; error?: string }
          | null
        if (readGeneration.current !== started) return
        if (res.ok && body && (body as LensDetails).ok) {
          setState({ details: body as LensDetails, loading: false, failure: null })
          return
        }
        const failure = body as { code?: LensFailureCode; error?: string } | null
        setState({
          details: null,
          loading: false,
          failure: {
            code: failure?.code ?? 'unknown',
            message: failure?.error ?? `Couldn't read this ${providerName} ticket.`,
          },
        })
      } catch {
        if (readGeneration.current !== started) return
        setState({
          details: null,
          loading: false,
          failure: { code: 'unknown', message: `Couldn't reach ${providerName}.` },
        })
      }
    })()
  }, [actionId, provider, retryKey, providerName])

  useEffect(
    () => () => {
      readGeneration.current++
      // Unmount invalidates in-flight writes as thoroughly as a lens switch: a
      // rollback into an unmounted tree is a React warning at best and a toast
      // for a surface nobody is looking at at worst.
      lensEpoch.current++
    },
    [],
  )

  const details = state.details
  const editable = details?.editable ?? {
    assignee: false,
    priority: false,
    due_date: false,
    labels: false,
  }
  // A stable identity for useLensOptions' dependency list — `editable` is a
  // fresh object on every details write.
  const optionGates = useMemo(
    () => ({ assignee: editable.assignee, priority: editable.priority, labels: editable.labels }),
    [editable.assignee, editable.priority, editable.labels],
  )
  const options = useLensOptions(details, optionGates)

  /**
   * Write one field.
   *
   * OPTIMISTIC, then reconciled from the response — never from the optimistic
   * value. The provider is the authority on what it stored: Jira may normalise a
   * label's case, Linear returns the assignee's display name for an id we sent,
   * and a lens that kept its own guess would show a value the ticket does not
   * have. So the PATCH response body (the same normalized shape as the GET) is
   * what lands in state.
   *
   * ROLLBACK ON `{ok:false}`, AND IT IS FIELD-SURGICAL. The obvious rollback —
   * restore the whole `details` object captured before the write — is wrong the
   * moment two fields are in flight, and two fields in flight is the normal case
   * now that different fields no longer block each other. Save B's snapshot
   * contains save A's OPTIMISTIC value, so restoring it re-commits a value A may
   * already have had refused. The rollback therefore reverts EXACTLY ONE FIELD,
   * to the value that field held before this write, applied against whatever
   * state exists when the failure lands — so a concurrent save's reconciled
   * value survives untouched.
   *
   * A TOAST, not a banner: the other fields are still fine and still editable, so
   * replacing the whole lens with an error would throw away working UI over one
   * rejected chip. A dead token is the exception the taxonomy already covers — it
   * surfaces as the banner on the next mount, and as a toast that names
   * reconnecting now.
   *
   * SUPERSEDING, per field. Re-picking the same chip while its first write is in
   * flight makes the first write a non-event: it neither reconciles (its answer
   * describes a state the user has already moved past) nor rolls back (rolling
   * back to a value two edits old would fight the user). Only the field's newest
   * write may touch the field.
   */
  const saveField = useCallback(
    async (
      field: keyof LensFields | 'labels',
      body: Record<string, unknown>,
      optimistic: (fields: LensFields) => LensFields,
      /**
       * Put this field back the way it was, against the CURRENT fields.
       *
       * Passed by the caller rather than derived from a snapshot because only the
       * caller knows which key of `LensFields` this write owns — and a revert that
       * touched any other key is the re-commit bug above.
       */
      revert: (fields: LensFields) => LensFields,
    ) => {
      if (!details) return
      const linkId = details.link_id
      const epoch = lensEpoch.current
      const seq = (saveSeq.current.get(field) ?? 0) + 1
      saveSeq.current.set(field, seq)
      /** Still the newest write for this field, on the ticket still on screen? */
      const current = () => lensEpoch.current === epoch && saveSeq.current.get(field) === seq

      pendingFields.current.add(field)
      setSavingFields(new Set(pendingFields.current))
      setState((prev) =>
        prev.details
          ? { ...prev, details: { ...prev.details, fields: optimistic(prev.details.fields) } }
          : prev,
      )

      /** Merge one field's worth of change into the latest state, never a snapshot. */
      const applyFields = (map: (fields: LensFields) => LensFields) =>
        setState((prev) =>
          prev.details
            ? { ...prev, details: { ...prev.details, fields: map(prev.details.fields) } }
            : prev,
        )

      try {
        const res = await fetch(
          `/api/account/actions/${actionId}/${provider}/${encodeURIComponent(linkId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: body }),
          },
        )
        const payload = (await res.json().catch(() => null)) as
          | (LensDetails & { code?: never })
          | { ok?: false; code?: LensFailureCode; error?: string }
          | null
        if (!current()) return
        if (res.ok && payload && (payload as LensDetails).ok) {
          const next = payload as LensDetails
          // RECONCILE THIS FIELD ONLY while another write is still in flight.
          // The response is a full ticket read, and it was taken BEFORE the
          // concurrent write landed on the provider — adopting it wholesale
          // would undo the other chip in front of the user's eyes. With nothing
          // else pending it is the freshest truth available, so it is adopted
          // whole (that is what keeps `link_id`, `status_name`, `editable` and
          // `option_scope` current).
          const othersPending = Array.from(pendingFields.current).some((f) => f !== field)
          if (othersPending) {
            applyFields((f) => ({ ...f, [field]: next.fields[field] }))
          } else {
            setState({ details: next, loading: false, failure: null })
          }
          return
        }
        // ROLLBACK — this field, nothing else.
        applyFields(revert)
        const failure = payload as { code?: LensFailureCode; error?: string } | null
        toast.error(
          failure?.error ??
            (failure?.code === 'field_not_editable'
              ? `That field isn't editable on this ${providerName} ticket.`
              : `Couldn't update ${providerName}.`),
        )
      } catch {
        if (!current()) return
        applyFields(revert)
        toast.error(`Couldn't reach ${providerName}.`)
      } finally {
        // Only the field's NEWEST write may clear the field's saving flag. A
        // superseded write finishing must leave the chip disabled, because the
        // write that superseded it is still out there.
        if (lensEpoch.current === epoch && saveSeq.current.get(field) === seq) {
          pendingFields.current.delete(field)
          setSavingFields(new Set(pendingFields.current))
        }
      }
    },
    [actionId, details, provider, providerName],
  )

  const wrapper = (children: React.ReactNode) => (
    <div
      className={cn(
        strip ? 'flex min-w-0 flex-1 items-center gap-2' : 'space-y-3',
        className,
      )}
      data-lens-surface={layout}
      data-lens-provider={provider}
      // The surfaces underneath both act on clicks in this region (the capture
      // row, the panel's own handlers). Same belt-and-braces the compose strip
      // uses, for the same two reasons.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )

  if (state.loading) {
    return wrapper(
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-lens-loading="">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span className="truncate">Reading {providerName}…</span>
      </div>,
    )
  }

  if (state.failure || !details) {
    return wrapper(
      <LensFailureBanner
        code={state.failure?.code ?? 'unknown'}
        message={state.failure?.message ?? `Couldn't read this ${providerName} ticket.`}
        providerName={providerName}
        provider={provider}
        layout={layout}
        onRetry={() => setRetryKey((k) => k + 1)}
        onOpenSettings={onOpenSettings}
      />,
    )
  }

  const { fields } = details

  const readOnly = (
    field: string,
    ariaLabel: string,
    value: string | null,
    icon: React.ReactNode,
  ) => (
    <ReadOnlyChip
      key={field}
      field={field}
      ariaLabel={ariaLabel}
      value={value}
      providerName={providerName}
      icon={icon}
      layout={layout}
    />
  )

  const assigneeChip = editable.assignee ? (
    <Field key="assignee" label="Assignee" layout={layout}>
      <div data-lens-field="assignee">
        <OptionSelect
          layout={layout}
          icon={<User className="h-3 w-3 shrink-0 opacity-70" />}
          ariaLabel={`${providerName} assignee`}
          value={fields.assignee?.id ?? null}
          onChange={(next) => {
            // Captured HERE, at the gesture, so the revert restores the value the
            // chip actually showed the user — not whatever a snapshot of the whole
            // ticket happened to hold when a different field's save started.
            const before = fields.assignee
            void saveField(
              'assignee',
              { assignee_id: next },
              (f) => ({
                ...f,
                assignee: next
                  ? options.assignees.find((o) => o.id === next) ?? { id: next, name: next }
                  : null,
              }),
              (f) => ({ ...f, assignee: before }),
            )
          }}
          // The ticket's CURRENT assignee, unioned in: the roster route is
          // project- or team-scoped and can legitimately omit someone who is
          // already assigned (a departed teammate, a cross-team assignment), and
          // a Select whose value is not among its options renders empty.
          options={
            fields.assignee && !options.assignees.some((o) => o.id === fields.assignee!.id)
              ? [fields.assignee, ...options.assignees]
              : options.assignees
          }
          placeholder="Assignee"
          noneLabel="Unassigned"
          loading={options.loading}
          disabled={savingFields.has('assignee')}
        />
      </div>
    </Field>
  ) : (
    readOnly(
      'assignee',
      `${providerName} assignee`,
      fields.assignee?.name ?? null,
      <User className={PROVIDER_ICON_CLASS} />,
    )
  )

  const priorityChip =
    // Asana has no priority field at all, so there is nothing to draw — not even
    // a read-only chip, which would assert a property the provider lacks.
    provider === 'asana' ? null : editable.priority ? (
      <Field key="priority" label="Priority" layout={layout}>
        <div data-lens-field="priority">
          <OptionSelect
            layout={layout}
            icon={<Flag className="h-3 w-3 shrink-0 opacity-70" />}
            ariaLabel={`${providerName} priority`}
            value={fields.priority?.id ?? null}
            onChange={(next) => {
              const before = fields.priority
              void saveField(
                'priority',
                { priority_id: next },
                (f) => ({
                  ...f,
                  priority: next
                    ? options.priorities.find((o) => o.id === next) ?? { id: next, name: next }
                    : null,
                }),
                (f) => ({ ...f, priority: before }),
              )
            }}
            options={
              fields.priority && !options.priorities.some((o) => o.id === fields.priority!.id)
                ? [fields.priority, ...options.priorities]
                : options.priorities
            }
            placeholder="Priority"
            noneLabel="No priority"
            loading={options.loading}
            disabled={savingFields.has('priority')}
          />
        </div>
      </Field>
    ) : (
      readOnly(
        'priority',
        `${providerName} priority`,
        fields.priority?.name ?? null,
        <Flag className={PROVIDER_ICON_CLASS} />,
      )
    )

  const dueChip = editable.due_date ? (
    <Field key="due_date" label="Due date" layout={layout}>
      {/*
        THE SAME IN-FLIGHT DISCIPLINE AS THE OTHER CHIPS, applied from outside.
        `DateField` is compose's shared primitive and takes no `disabled` — it was
        extracted for a form where nothing is in flight until Create. Rather than
        add a prop to a component ~50 pinned compose tests assert the bytes of,
        the guard lives here in the two places that matter: the wrapper stops the
        gesture reaching the picker, and `onChange` refuses a second write to the
        same field even if a gesture slips through (a keyboard commit, a queued
        event). Per-field tracking means this blocks ONLY due_date — an assignee
        save in flight leaves this chip live, which is the point.
      */}
      <div
        data-lens-field="due_date"
        data-lens-saving={savingFields.has('due_date') ? '' : undefined}
        className={cn(savingFields.has('due_date') && 'pointer-events-none opacity-50')}
      >
        <DateField
          layout={layout}
          ariaLabel={`${providerName} due date`}
          value={fields.due_date ?? ''}
          onChange={(next) => {
            if (savingFields.has('due_date')) return
            const before = fields.due_date
            void saveField(
              'due_date',
              { due_date: next === '' ? null : next },
              (f) => ({ ...f, due_date: next === '' ? null : next }),
              (f) => ({ ...f, due_date: before }),
            )
          }}
        />
      </div>
    </Field>
  ) : (
    readOnly(
      'due_date',
      `${providerName} due date`,
      fields.due_date,
      <CircleDot className={PROVIDER_ICON_CLASS} />,
    )
  )

  const labelsChip = (
    <LabelsControl
      key="labels"
      value={fields.labels}
      options={options.labels}
      optionsLoading={options.loading}
      editable={editable.labels}
      layout={layout}
      providerName={providerName}
      saving={savingFields.has('labels')}
      onCommit={(ids) => {
        const before = fields.labels
        void saveField(
          'labels',
          { label_ids: ids },
          (f) => ({
            ...f,
            labels: ids.map(
              (id) =>
                f.labels.find((l) => l.id === id) ??
                options.labels.find((l) => l.id === id) ?? { id, name: id },
            ),
          }),
          (f) => ({ ...f, labels: before }),
        )
      }}
    />
  )

  const statusChip = readOnly(
    'status',
    `${providerName} status`,
    details.status_name,
    <CircleDot className={PROVIDER_ICON_CLASS} />,
  )

  // FIELD ORDER, per provider, matching the compose strip's.
  const chips: React.ReactNode[] = []
  if (provider === 'jira') {
    chips.push(
      readOnly('project', `${providerName} project`, fields.project?.name ?? null, <Folder className={PROVIDER_ICON_CLASS} />),
      readOnly('issue_type', `${providerName} issue type`, fields.issue_type?.name ?? null, <CircleDot className={PROVIDER_ICON_CLASS} />),
      statusChip,
      assigneeChip,
      priorityChip,
      dueChip,
      labelsChip,
    )
  } else if (provider === 'asana') {
    chips.push(
      readOnly('project', `${providerName} project`, fields.project?.name ?? null, <Folder className={PROVIDER_ICON_CLASS} />),
      readOnly('section', `${providerName} section`, fields.section?.name ?? null, <Rows3 className={PROVIDER_ICON_CLASS} />),
      statusChip,
      assigneeChip,
      dueChip,
      labelsChip,
    )
  } else {
    chips.push(
      readOnly('team', `${providerName} team`, fields.team?.name ?? null, <Users className={PROVIDER_ICON_CLASS} />),
      readOnly('project', `${providerName} project`, fields.project?.name ?? null, <Folder className={PROVIDER_ICON_CLASS} />),
      statusChip,
      assigneeChip,
      priorityChip,
      labelsChip,
      dueChip,
    )
  }

  /**
   * "Open in {Provider}" — the lens's terminal action, at the row's end.
   *
   * PINNED OUTSIDE THE SCROLLER in `strip`, the same way compose pins Create: a
   * link-out that scrolled away with the fields is a control the user has to go
   * looking for. It is an `<a>` rather than a button because it IS a navigation
   * and middle-click/copy-link must work.
   */
  const openLink = details.url ? (
    <a
      href={details.url}
      target="_blank"
      rel="noreferrer"
      data-lens-open=""
      aria-label={`Open in ${providerName}`}
      title={`Open in ${providerName}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground',
        strip ? 'h-7 px-1' : 'h-7 px-2 text-xs',
      )}
    >
      <ExternalLink className="h-3 w-3 shrink-0" />
      {!strip && <span>Open in {providerName}</span>}
    </a>
  ) : null

  if (strip) {
    return wrapper(
      <>
        <div
          // THE SCROLLER, on the compose strip's own classes. `overflow-y-hidden`
          // is not decoration: a lone `overflow-x-auto` computes
          // `overflow-y: auto`, which would make this a vertical scroll
          // container too and let a trackpad flick inside it swallow the
          // capture panel's own scroll. `px-0.5 py-1` is room for the focus ring
          // a scroll container otherwise clips.
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-hide px-0.5 py-1"
          data-lens-scroller=""
        >
          {chips}
        </div>
        {openLink}
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={onClose}
            aria-label="Close lens"
          >
            Close
          </Button>
        )}
      </>,
    )
  }

  return wrapper(
    <>
      {chips}
      {openLink}
    </>,
  )
}

export type { PlatformLink }
