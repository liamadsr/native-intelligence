'use client'

/**
 * Who does the work on a Mac (migration 658), in the composer's under-row,
 * first, before the environment chip: WHERE the work runs is the
 * environment; WHICH intelligence does it is this. The choice is the Mac's
 * (environment.worker): it applies to every chat that works on that Mac.
 *
 *   choose    the chat's Mac offers at least one coding agent: on that Mac
 *             as it says now (useThisMac), anywhere else as it last told the
 *             server (environment.offered_workers): a segmented toggle, "Native
 *             Intelligence" then each agent by its label. A saved agent the
 *             Mac no longer offers stays as a segment, selected but muted,
 *             saying where to switch it on. A pick saves as setMacWorker does
 *             (optimistic, stale reads dropped, only `worker` rolled back).
 *             A saved agent is always there with Native Intelligence, so the
 *             way back never needs the Mac's word, on every device.
 *   readonly  a page with no way to save (no picker) and a saved agent: a
 *             muted chip with its name, nothing to press.
 *   nothing   the chat's environment isn't a Mac, or there is nothing to
 *             choose or say (an empty thing renders nothing).
 *
 * The repo's ToggleGroup (Radix, type single): a group of radio items with
 * roving focus, so the arrow keys move between segments and the selected
 * one is announced. Text only. A track the environment chip's size, with a
 * raised pill for the selected segment.
 */
import type { ChatEnvironment, EnvironmentsSnapshot, MacEnvironmentItem, ThisMacSnapshot } from '@/lib/local-agent/environment-client'
import { NATIVE_WORKER_LABEL, WORKER_SWITCH_HINT, workerLabel } from '@/lib/environments/types'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

/** The segment value of Native Intelligence's own agent: never a worker id (those have no colon). */
const NATIVE = ':native'

export interface WorkerSegment {
  /** A coding agent's id, or null for Native Intelligence's own agent. */
  id: string | null
  label: string
  /** The tooltip, in plain words. */
  title: string
  /** A saved agent this Mac no longer offers: selected, muted, never picked again. */
  unavailable?: true
}

export type WorkerToggleState =
  | { kind: 'hidden' }
  | { kind: 'readonly'; label: string; title: string }
  | { kind: 'choose'; mac: MacEnvironmentItem; value: string | null; segments: WorkerSegment[] }

/**
 * What the toggle shows for the chat's environment, as a page here can show
 * it. Pure. `canPick`: the page has a way to save a pick.
 */
export function workerToggleState(
  chat: Pick<ChatEnvironment, 'environment'>,
  list: Pick<EnvironmentsSnapshot, 'environments'>,
  thisMac: ThisMacSnapshot | null | undefined,
  canPick = true,
): WorkerToggleState {
  const chatEnv = chat.environment
  if (!chatEnv || chatEnv.kind !== 'mac') return { kind: 'hidden' }
  // The list's copy is the fresher one once read (a pick lands there first).
  const listed = list.environments.find((e) => e.id === chatEnv.id)
  const mac = (listed?.kind === 'mac' ? listed : chatEnv) as MacEnvironmentItem
  const saved = mac.worker ?? null
  // On that Mac, what it offers right now; anywhere else, what it last told
  // the server (its heartbeat's mirror, migration 658). The server refuses a
  // pick that isn't in that list, so both say the same.
  const live = thisMac?.deviceId && thisMac.deviceId === mac.deviceId ? thisMac.workers : null
  if (!canPick) {
    if (!saved) return { kind: 'hidden' }
    return { kind: 'readonly', label: workerLabel(saved), title: `Change it in the Native Intelligence app on ${mac.name || 'that Mac'}.` }
  }
  // Not known (never reported, or an app that can't run coding agents): none
  // offered. Going back to Native Intelligence never needs the Mac's word,
  // so a saved choice always gets the toggle, on every device.
  const offers = live ?? mac.offeredWorkers ?? []
  const unavailable = saved && !offers.some((w) => w.id === saved) ? saved : null
  // Nothing offered and nothing saved: nothing to choose, so nothing shows.
  if (offers.length === 0 && !unavailable) return { kind: 'hidden' }
  // Off that Mac, the tooltips name it.
  const where = live ? 'this Mac' : mac.name || 'this Mac'
  const segments: WorkerSegment[] = [
    { id: null, label: NATIVE_WORKER_LABEL, title: `Work on ${where} is done by ${NATIVE_WORKER_LABEL}.` },
    ...offers.map((w) => {
      const label = w.label || workerLabel(w.id)
      return { id: w.id, label, title: `Work on ${where} is done by ${label}, on your own ${label} account.` }
    }),
  ]
  if (unavailable) {
    const label = workerLabel(unavailable)
    const whose = where === 'this Mac' ? 'This Mac' : where
    segments.push({ id: unavailable, label, title: `${whose} doesn’t offer ${label} right now. ${WORKER_SWITCH_HINT}`, unavailable: true })
  }
  return { kind: 'choose', mac, value: saved, segments }
}

export interface WorkerToggleProps {
  chat: ChatEnvironment
  list: EnvironmentsSnapshot
  thisMac?: ThisMacSnapshot
  /** Save who does the Mac's work (composer-state's pickWorker). Absent: read-only. */
  onPickWorker?: (environment: MacEnvironmentItem, worker: string | null) => void
}

/**
 * The track: one rounded box the environment chip's height (28px) and radius,
 * a subtle fill and a hairline border in the composer's greys. 8px before the
 * chip (the row's 4px gap plus mr-1). It never scrolls: the composer's
 * under-row wraps the chip to a second line instead.
 */
const TRACK =
  'mr-1 h-7 min-w-0 max-w-full shrink flex-nowrap justify-start gap-0.5 rounded-md border border-border/70 bg-muted/70 p-0.5 dark:bg-background'

/**
 * A segment: plain text that fills on hover; selected, a raised pill clearly
 * apart from the track in both themes (white with a hairline and a soft
 * shadow on the light-grey track; the lighter accent on the dark track).
 * Full labels: on a narrow under-row (the composer's `underrow` container,
 * under 20rem) the padding tightens first; only if it still can't fit does
 * the LONGEST label give way with an ellipsis (the others never shrink).
 */
const SEGMENT =
  'h-[22px] rounded-[5px] px-2 @max-[20rem]/underrow:px-1 text-[13px] font-normal text-muted-foreground hover:bg-background/70 hover:text-foreground dark:hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm data-[state=on]:ring-1 data-[state=on]:ring-border dark:data-[state=on]:bg-accent motion-reduce:transition-none'

/** A saved agent the Mac no longer offers: a dashed outline, readable text, no extra fading. */
const UNAVAILABLE =
  'border border-dashed border-muted-foreground/50 data-[state=on]:shadow-none data-[state=on]:ring-0 data-[state=on]:text-muted-foreground'

export function WorkerToggle({ chat, list, thisMac, onPickWorker }: WorkerToggleProps) {
  const state = workerToggleState(chat, list, thisMac, !!onPickWorker)
  if (state.kind === 'hidden') return null
  if (state.kind === 'readonly') {
    return (
      <span
        data-worker-readonly=""
        title={state.title}
        aria-label={`Work on this Mac is done by ${state.label}`}
        className="mr-1 flex h-7 min-w-0 max-w-full shrink items-center rounded-md px-1.5 text-[13px] text-muted-foreground/70"
      >
        <span className="truncate">{state.label}</span>
      </span>
    )
  }
  const pick = (value: string) => {
    // Radix answers '' when the selected segment is pressed again: nothing changes.
    if (!value || !onPickWorker) return
    const worker = value === NATIVE ? null : value
    // Only what this Mac offers now (an unavailable one stays shown, never picked again).
    if (worker !== null && !state.segments.some((s) => s.id === worker && !s.unavailable)) return
    if (worker !== (state.mac.worker ?? null)) onPickWorker(state.mac, worker)
  }
  // The one segment that may give way last of all: the longest label (the first of equals).
  const longest = state.segments.reduce((best, s, i, all) => (s.label.length > all[best].label.length ? i : best), 0)
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={state.value ?? NATIVE}
      onValueChange={pick}
      // A radio group (Radix makes the segments radios): the selected one is announced as checked.
      role="radiogroup"
      aria-label="Who does the work on this Mac"
      data-worker-toggle=""
      className={TRACK}
    >
      {state.segments.map((s, i) => (
        <ToggleGroupItem
          key={s.id ?? NATIVE}
          value={s.id ?? NATIVE}
          title={s.title}
          data-worker-segment={s.id ?? 'native'}
          {...(s.unavailable ? { 'data-worker-unavailable': '' } : {})}
          className={cn(SEGMENT, i === longest ? 'min-w-0 shrink' : 'shrink-0', s.unavailable && UNAVAILABLE)}
        >
          <span className="truncate">{s.label}</span>
          {/* As the "with" control and the tooltip say it: an agent of theirs runs on their own account. */}
          {s.id && <span className="sr-only">{s.unavailable ? ' (your own account, unavailable)' : ' (your own account)'}</span>}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
