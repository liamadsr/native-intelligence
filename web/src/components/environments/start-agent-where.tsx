'use client'

/**
 * "in the cloud / on <your Mac>" beside an action's Start: where this
 * person's Start of a coding run goes, chosen right there. It IS the
 * project's "Run my work here on <your Mac>" (project-environment-field.tsx:
 * the same per-person project default, PUT …/environments/default), so
 * picking a Mac here turns that switch on and picking the cloud turns it off;
 * there is no second setting. Then the Start reads where it runs again
 * (useStartOnMac), and the "with" picker appears when the Mac offers agents.
 *
 * Shown only for a coding run (GET …/start-agent's `coding`: a repo, a
 * developer agent or one with no role) when the person has a Mac. A work
 * run never runs on a Mac, so nothing is offered for one. With the Mac
 * chosen and no folder on it linked to the project's repo, it says so in one
 * sentence and offers that Mac's Edit environment to link one (the Start
 * would be refused with the same reason, never moved to the cloud).
 */
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useEnvironments, type MacEnvironmentItem } from '@/lib/local-agent/environment-client'
import { setProjectMacDefault } from './api'
import { EditEnvironmentDialog } from './edit-environment-dialog'
import { EnvironmentKindIcon } from './environment-meta'
import { macLinksRepo } from './project-environment-field'
import type { StartPlace } from './start-agent-with'

/** The cloud's segment value: never an environment id (those are uuids). */
const CLOUD = ':cloud'

/** "No folder on <Mac> is linked to <repo>." when the Start would be refused for it, else null. Pure. */
export function unlinkedFolderSentence(mac: MacEnvironmentItem | null, repo: string | null | undefined): string | null {
  if (!mac || !repo || macLinksRepo(mac, repo)) return null
  return `No folder on ${mac.name || 'your Mac'} is linked to ${repo}.`
}

export interface StartAgentWhereProps {
  place: StartPlace
  /** Off: nothing shown (no agent assignee, a run already going). */
  enabled: boolean
  disabled?: boolean
}

export function StartAgentWhere({ place, enabled, disabled = false }: StartAgentWhereProps) {
  const coding = enabled && place.loaded ? place.coding : null
  const list = useEnvironments({ enabled: !!coding })
  const macs = list.environments.filter((e): e is MacEnvironmentItem => e.kind === 'mac')
  const [saving, setSaving] = useState(false)
  const [linking, setLinking] = useState<MacEnvironmentItem | null>(null)
  if (!coding || macs.length === 0) return null

  const current = place.macId ? (macs.find((m) => m.id === place.macId) ?? place.mac) : null
  const unlinked = unlinkedFolderSentence(current, coding.repo)
  const where = place.macId ? `on ${current?.name || 'your Mac'}` : 'in the cloud'

  async function choose(value: string) {
    const next = value === CLOUD ? null : value
    if (next === place.macId || !coding) return
    const mac = next ? macs.find((m) => m.id === next) ?? null : null
    setSaving(true)
    const res = await setProjectMacDefault({ projectId: coding.projectId, environmentId: next })
    setSaving(false)
    if (!res.ok) {
      toast.error(next ? `Couldn’t run your work on ${mac?.name || 'your Mac'}` : 'Couldn’t move your work to the cloud', { description: res.error })
      return
    }
    place.reload()
    const missing = unlinkedFolderSentence(mac, coding.repo)
    if (mac && missing) toast(missing, { description: 'Link one so the agent can work in it.', action: { label: 'Link a folder', onClick: () => setLinking(mac) } })
  }

  const optionRow = (value: string, label: string, kind: 'mac' | 'cloud', note?: string) => (
    <DropdownMenuPrimitive.RadioItem
      key={value}
      value={value}
      data-start-agent-where-option={value === CLOUD ? 'cloud' : value}
      className="relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground"
    >
      <EnvironmentKindIcon kind={kind} className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note && <span className="shrink-0 text-[12px] text-muted-foreground">{note}</span>}
      <Check aria-hidden className={cn('size-3.5 shrink-0', (place.macId ?? CLOUD) === value ? 'text-foreground' : 'invisible')} />
    </DropdownMenuPrimitive.RadioItem>
  )

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild disabled={disabled || saving}>
          <button
            type="button"
            data-start-agent-where={place.macId ? 'mac' : 'cloud'}
            {...(unlinked ? { 'data-start-agent-where-unlinked': '' } : {})}
            title={unlinked ?? `Your Start runs ${where}`}
            aria-label={`Runs ${where}. Change where`}
            className="inline-flex h-7 max-w-[12rem] shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-muted"
          >
            <EnvironmentKindIcon kind={place.macId ? 'mac' : 'cloud'} className="size-3.5" />
            {/* It keeps its words longer than "with" (the place is the hint that a Mac
                run exists); only in a very tight toolbar is it its icon alone. */}
            <span className="truncate @max-[30rem]/actiontoolbar:hidden">{where}</span>
            {unlinked && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
            <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70 @max-[30rem]/actiontoolbar:hidden" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" className="w-64" data-start-agent-where-menu="">
          <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
            Where your work in this project runs
            <span className="block font-normal">For actions you start. Teammates’ run in the cloud.</span>
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={place.macId ?? CLOUD} onValueChange={(v) => void choose(v)} aria-label="Where this card’s work runs">
            {optionRow(CLOUD, 'In the cloud', 'cloud')}
            {macs.map((m) => optionRow(m.id, m.name || 'Your Mac', 'mac', m.online ? undefined : 'offline'))}
          </DropdownMenuRadioGroup>
          {unlinked && current && (
            <>
              <DropdownMenuSeparator />
              <p data-start-agent-where-unlinked-note="" className="px-2 pb-1 pt-1 text-xs text-muted-foreground">
                {unlinked}
              </p>
              <DropdownMenuItem data-start-agent-where-link="" onSelect={() => setLinking(current)} className="rounded-2xl px-2 py-2 text-sm">
                Link a folder…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {linking && (
        <EditEnvironmentDialog
          open
          onOpenChange={(open) => {
            if (!open) setLinking(null)
          }}
          environment={linking}
        />
      )}
    </>
  )
}
