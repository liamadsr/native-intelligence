'use client'

/**
 * "with …" beside an action's Start (migration 658): who does this card's
 * work when it runs on the person's Mac. Shown only when the Start would run
 * there as a coding job (GET /api/account/actions/[id]/start-agent says so:
 * a repo, a developer agent, their "Run my work here"), with the same rule
 * the Start itself runs by. Native Intelligence, or one of the coding agents
 * that Mac offers (on that Mac as it says now, anywhere else as it last told
 * the server). Defaults to the Mac's saved choice while the Mac offers it,
 * else Native Intelligence; a saved agent it doesn't offer (or whose offer
 * isn't known) shows, unavailable, so the way back to Native Intelligence is
 * always there. Exactly what it shows is sent with the Start (`worker`), and
 * never stored on the action: the run records it.
 *
 * Nothing to choose (not a Mac coding Start, or no saved choice and nothing
 * offered): renders nothing, and Start sends no choice, as it always did.
 */
import { useEffect, useMemo, useState } from 'react'
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
  /** The Mac's saved choice while it offers it, else Native Intelligence. */
  initial: string | null
}

/**
 * What "with" offers for this Mac, or null when there is nothing to choose
 * (no saved choice and nothing offered). Pure.
 */
export function startWorkerOptions(mac: MacEnvironmentItem | null, thisMac: ThisMacSnapshot | null | undefined): StartWorkerOptions | null {
  if (!mac) return null
  const live = thisMac?.deviceId && thisMac.deviceId === mac.deviceId ? thisMac.workers : null
  const offers: readonly MacWorkerOffer[] = live ?? mac.offeredWorkers ?? []
  const saved = mac.worker ?? null
  if (offers.length === 0 && !saved) return null
  const offered = !!saved && offers.some((w) => w.id === saved)
  return {
    mac,
    options: [{ id: null, label: NATIVE_WORKER_LABEL }, ...offers.map((w) => ({ id: w.id, label: w.label || workerLabel(w.id) }))],
    unavailable: saved && !offered ? { id: saved, label: workerLabel(saved) } : null,
    initial: offered ? saved : null,
  }
}

/**
 * The Mac this person's Start of this action runs on as a coding job (GET
 * …/start-agent: the route's own rule), as the environments list shows it,
 * or null (it doesn't run on their Mac: the Start sends no choice).
 */
export function useStartOnMac(actionId: string | null, enabled: boolean): MacEnvironmentItem | null {
  const [macId, setMacId] = useState<string | null>(null)
  useEffect(() => {
    setMacId(null)
    if (!enabled || !actionId) return
    let cancelled = false
    fetch(`/api/account/actions/${encodeURIComponent(actionId)}/start-agent`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { onMac?: { environmentId?: unknown } | null } | null) => {
        const id = d?.onMac?.environmentId
        if (!cancelled) setMacId(typeof id === 'string' && id ? id : null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [actionId, enabled])
  const list = useEnvironments({ enabled: enabled && !!macId })
  return useMemo(() => {
    if (!macId) return null
    const env = list.environments.find((e) => e.id === macId)
    return env?.kind === 'mac' ? (env as MacEnvironmentItem) : null
  }, [list.environments, macId])
}

export interface StartAgentWithProps {
  /** The action whose Start this is. */
  actionId: string | null
  /** Off: nothing read, nothing shown (no agent assignee, a run already going). */
  enabled: boolean
  /** The chosen agent (undefined until the choice is known: the Start then sends none). */
  value: string | null | undefined
  onChange: (worker: string | null | undefined) => void
  disabled?: boolean
}

export function StartAgentWith({ actionId, enabled, value, onChange, disabled = false }: StartAgentWithProps) {
  const mac = useStartOnMac(actionId, enabled)
  const thisMac = useThisMac({ enabled: enabled && !!mac })
  const choice = enabled ? startWorkerOptions(mac, thisMac) : null
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
