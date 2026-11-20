'use client'

/**
 * "with …" beside an action's Start (migration 658): who does this card's
 * work when it runs on the person's Mac. Shown only when the Start would run
 * there as a coding job (GET /api/account/actions/[id]/start-agent says so:
 * a repo, a developer agent, their "Run my work here"), with the same rule
 * the Start itself runs by. Native Intelligence, or one of the coding agents
 * that Mac offers (on that Mac as it says now, anywhere else as it last told
 * the server). Which Mac comes from useStartOnMac, read once by the panel
 * for this and the Start's own label. Defaults to the Mac's saved choice while the Mac offers it,
 * else Native Intelligence; a saved agent it doesn't offer (or whose offer
 * isn't known) shows, unavailable, so the way back to Native Intelligence is
 * always there. Exactly what it shows is sent with the Start (`worker`), and
 * never stored on the action: the run records it.
 *
 * Nothing to choose (not a Mac coding Start, or no saved choice and nothing
 * offered): renders nothing, and Start sends no choice, as it always did.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Check, ChevronDown } from 'lucide-react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { NATIVE_WORKER_LABEL, WORKER_SWITCH_HINT, workerLabel, type MacWorkerOffer } from '@/lib/environments/types'
import { useEnvironments, useThisMac, type MacEnvironmentItem, type ThisMacSnapshot } from '@/lib/local-agent/environment-client'

/** The segment value of Native Intelligence's own agent: never a worker id (those have no colon). */
const NATIVE = ':native'

export interface StartWorkerOptions {
  mac: MacEnvironmentItem
  /** What may be picked: Native Intelligence, then what the Mac offers. */
  options: Array<{ id: string | null; label: string }>
  /** A saved agent the Mac doesn't offer (or whose offer isn't known): shown, never picked. */
  unavailable: { id: string; label: string } | null
  /** The agent this action last ran with there while offered, else the Mac's saved choice while offered, else Native Intelligence. */
  initial: string | null
}

/**
 * What "with" offers for this Mac, or null when there is nothing to choose
 * (no saved choice and nothing offered). Pure.
 */
export function startWorkerOptions(
  mac: MacEnvironmentItem | null,
  thisMac: ThisMacSnapshot | null | undefined,
  /** The agent this action last ran with on this Mac (null: Native Intelligence); undefined: none. */
  remembered?: string | null,
): StartWorkerOptions | null {
  if (!mac) return null
  const live = thisMac?.deviceId && thisMac.deviceId === mac.deviceId ? thisMac.workers : null
  const offers: readonly MacWorkerOffer[] = live ?? mac.offeredWorkers ?? []
  const saved = mac.worker ?? null
  if (offers.length === 0 && !saved) return null
  const offered = !!saved && offers.some((w) => w.id === saved)
  // A task remembers its own agent while the Mac still offers it; else the Mac's saved choice.
  const rememberedOk = remembered === null || (!!remembered && offers.some((w) => w.id === remembered))
  return {
    mac,
    options: [{ id: null, label: NATIVE_WORKER_LABEL }, ...offers.map((w) => ({ id: w.id, label: w.label || workerLabel(w.id) }))],
    unavailable: saved && !offered ? { id: saved, label: workerLabel(saved) } : null,
    initial: rememberedOk ? (remembered ?? null) : offered ? saved : null,
  }
}

/**
 * Where this person's Start of this action runs, picked per task (the
 * owner's rule, 11-19): GET …/start-agent says whether it is a coding run,
 * their project default ("Run my work here") and where they last ran this
 * action. The pick opens on the last run's place (a task remembers its own),
 * else the project default, else the cloud; picking something else changes
 * only this task's Start (`pick`), never the project default. Read once per
 * action (again on `reload`, or when `refreshKey` changes: a new agent or
 * project).
 *
 *   coding        the project and repo when the Start is a coding run, else
 *                 null (a work run: always the cloud, nothing to pick);
 *   defaultMacId  the project default's Mac, or null (the cloud);
 *   lastWorker    the agent the last run on the picked Mac used (undefined
 *                 when it last ran elsewhere, or never): "with" opens on it;
 *   macs          the person's Macs (the places to pick, beside the cloud);
 *   macId / mac   where this Start runs now (null: the cloud), and that Mac
 *                 as the list shows it (null until the list has it);
 *   loaded        the answer has come back (a failed read offers nothing).
 */
export interface StartPlace {
  loaded: boolean
  coding: { projectId: string; repo: string } | null
  defaultMacId: string | null
  lastWorker: string | null | undefined
  macs: MacEnvironmentItem[]
  macId: string | null
  mac: MacEnvironmentItem | null
  /** Pick where THIS Start runs: a Mac environment's id, or null for the cloud. */
  pick: (environmentId: string | null) => void
  /** Read it again (after the project default changed). */
  reload: () => void
}

export interface StartPlaceAnswer {
  coding: { projectId: string; repo: string } | null
  defaultMacId: string | null
  last: { environmentId: string | null; worker: string | null } | null
}

/** GET …/start-agent's answer, or null when it isn't one. Pure. */
export function parseStartPlaceAnswer(d: unknown): StartPlaceAnswer | null {
  if (!d || typeof d !== 'object') return null
  const o = d as { onMac?: { environmentId?: unknown } | null; coding?: { projectId?: unknown; repo?: unknown } | null; last?: { environmentId?: unknown; worker?: unknown } | null }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const c = o.coding
  const coding = c && str(c.projectId) && str(c.repo) ? { projectId: c.projectId as string, repo: c.repo as string } : null
  const last = o.last && typeof o.last === 'object' ? { environmentId: str(o.last.environmentId), worker: str(o.last.worker) } : null
  return { coding, defaultMacId: str(o.onMac?.environmentId), last }
}

/**
 * Where a Start opens: the last run's place while it can still be used (the
 * cloud, or a Mac still in the list), else the project default's Mac while
 * it is in the list, else the cloud. Before the list has loaded, the ids are
 * taken as they are. Never a Mac for a work run. Pure.
 */
export function initialStartPlace(answer: StartPlaceAnswer | null, macs: readonly { id: string }[] | null): string | null {
  if (!answer?.coding) return null
  const usable = (id: string) => macs === null || macs.some((m) => m.id === id)
  const last = answer.last
  if (last && (last.environmentId === null || usable(last.environmentId))) return last.environmentId
  return answer.defaultMacId && usable(answer.defaultMacId) ? answer.defaultMacId : null
}

export function useStartOnMac(actionId: string | null, enabled: boolean, refreshKey = ''): StartPlace {
  const [answer, setAnswer] = useState<StartPlaceAnswer | null>(null)
  const [picked, setPicked] = useState<{ key: string; environmentId: string | null } | null>(null)
  const [round, setRound] = useState(0)
  const key = `${actionId ?? ''}|${refreshKey}`
  useEffect(() => {
    setAnswer(null)
    if (!enabled || !actionId) return
    let cancelled = false
    fetch(`/api/account/actions/${encodeURIComponent(actionId)}/start-agent`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (!cancelled) setAnswer(parseStartPlaceAnswer(d))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [actionId, enabled, refreshKey, round])
  const coding = answer?.coding ?? null
  const list = useEnvironments({ enabled: enabled && !!coding })
  const macs = useMemo(() => list.environments.filter((e): e is MacEnvironmentItem => e.kind === 'mac'), [list.environments])
  // A pick belongs to this action: another action (or agent, or project) opens fresh.
  const pickedHere = picked && picked.key === key ? picked.environmentId : undefined
  const macId = !coding ? null : pickedHere !== undefined ? pickedHere : initialStartPlace(answer, list.loaded ? macs : null)
  const mac = macId ? (macs.find((m) => m.id === macId) ?? null) : null
  const last = answer?.last ?? null
  const lastWorker = last && last.environmentId !== null && last.environmentId === macId ? last.worker : undefined
  const pick = useCallback((environmentId: string | null) => setPicked({ key, environmentId }), [key])
  const reload = useCallback(() => setRound((n) => n + 1), [])
  return { loaded: !!answer, coding, defaultMacId: answer?.defaultMacId ?? null, lastWorker, macs, macId, mac, pick, reload }
}

/**
 * The Start's name, as its button, tooltip and property row say it: on the
 * Mac it runs on ("Run on Studio Mac", "… with Claude Code" when one of the
 * person's own agents is picked), else "Run agent in cloud". Pure.
 */
export function startPlaceLabel(place: Pick<StartPlace, 'macId' | 'mac'>, worker: string | null | undefined): string {
  if (!place.macId) return 'Run agent in cloud'
  const where = place.mac?.name || 'your Mac'
  return worker ? `Run on ${where} with ${workerLabel(worker, place.mac?.offeredWorkers)}` : `Run on ${where}`
}

export interface StartAgentWithProps {
  /** The Mac this Start runs on as a coding job (useStartOnMac's `mac`), or null: nothing to choose. */
  mac: MacEnvironmentItem | null
  /** Off: nothing shown (no agent assignee, a run already going). */
  enabled: boolean
  /** The agent this action last ran with on this Mac (StartPlace.lastWorker): what "with" opens on. */
  remembered?: string | null
  /** The chosen agent (undefined until the choice is known: the Start then sends none). */
  value: string | null | undefined
  onChange: (worker: string | null | undefined) => void
  disabled?: boolean
}

export function StartAgentWith({ mac, enabled, remembered, value, onChange, disabled = false }: StartAgentWithProps) {
  const thisMac = useThisMac({ enabled: enabled && !!mac })
  const choice = enabled ? startWorkerOptions(mac, thisMac, remembered) : null
  const initial = choice?.initial
  const known = !!choice
  // Every id that may be sent right now: what the label shows is what Start sends.
  const pickable = choice ? choice.options.map((o) => o.id ?? NATIVE).join(' ') : ''
  // The default (the Mac's saved choice) is the choice until the person picks;
  // a pick the Mac no longer offers goes back to it; nothing to choose: none.
  useEffect(() => {
    if (!known) {
      if (value !== undefined) onChange(undefined)
      return
    }
    if (value === undefined || !pickable.split(' ').includes(value ?? NATIVE)) onChange(initial ?? null)
  }, [known, initial, value, onChange, pickable])
  if (!choice) return null
  const current = value === undefined || !choice.options.some((o) => o.id === value) ? choice.initial : value
  const label = choice.options.find((o) => o.id === current)?.label ?? NATIVE_WORKER_LABEL
  const optionRow = (o: { id: string | null; label: string }) => (
    <DropdownMenuPrimitive.RadioItem
      key={o.id ?? NATIVE}
      value={o.id ?? NATIVE}
      data-start-agent-with-option={o.id ?? 'native'}
      className="relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground"
    >
      <span className="min-w-0 flex-1 truncate">{o.label}</span>
      <Check aria-hidden className={cn('size-3.5 shrink-0', current === o.id ? 'text-foreground' : 'invisible')} />
    </DropdownMenuPrimitive.RadioItem>
  )
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-start-agent-with={current ?? 'native'}
          title={`With ${label}: who does this card’s work on ${choice.mac.name || 'your Mac'}`}
          aria-label={`Start with ${label}`}
          className="inline-flex h-7 max-w-[11rem] shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-muted"
        >
          {/* In a tight toolbar (the action panel's container) it collapses to an
              icon first, the name in its tooltip and menu, so no tab label is cut. */}
          <Bot aria-hidden data-start-agent-with-icon="" className="hidden size-3.5 shrink-0 @max-[44rem]/actiontoolbar:block" />
          <span className="truncate @max-[44rem]/actiontoolbar:hidden">with {label}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70 @max-[44rem]/actiontoolbar:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-60" data-start-agent-with-menu="">
        <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
          Work on {choice.mac.name || 'your Mac'} is done by
          {/* One caption for the whole menu, so each name shows in full. */}
          <span data-start-agent-with-caption="" className="block font-normal">
            Your own agents run on your own accounts.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current ?? NATIVE} onValueChange={(v) => onChange(v === NATIVE ? null : v)} aria-label="Who does this card’s work">
          {choice.options.slice(0, 1).map(optionRow)}
          {/* The saved choice the Mac doesn't report: right under Native Intelligence, above what may be picked. */}
          {choice.unavailable && (
            <DropdownMenuPrimitive.RadioItem
              value={choice.unavailable.id}
              disabled
              data-start-agent-with-option={choice.unavailable.id}
              data-start-agent-with-unavailable=""
              title={`${choice.mac.name || 'This Mac'} doesn’t offer ${choice.unavailable.label} right now. ${WORKER_SWITCH_HINT}`}
              className="relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm text-muted-foreground outline-hidden"
            >
              <span className="min-w-0 flex-1 truncate">{choice.unavailable.label}</span>
              <span className="shrink-0 text-[12px]">unavailable</span>
            </DropdownMenuPrimitive.RadioItem>
          )}
          {choice.options.slice(1).map(optionRow)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
