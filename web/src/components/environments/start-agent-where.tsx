'use client'

/**
 * "Run on" beside an action's Start: where THIS task's Start runs, the cloud
 * or one of the person's own Macs (the owner's rule, 11-19: the place is
 * chosen per task; the project's "Run my work here" is only the default).
 * It opens where the task last ran, else on the project default, else on the
 * cloud (useStartOnMac). Picking another place changes only this task's
 * Start; "Make this the default for this project" in the same menu sets the
 * project's own "Run my work here" (PUT …/environments/default, the switch
 * the project panel shows), for the person who wants that. With a Mac picked
 * the existing "with" picker appears beside it.
 *
 * Shown only for a coding run (GET …/start-agent's `coding`: a repo, a
 * developer agent or one with no role) when the person has a Mac: a work run
 * always runs in the cloud. With a Mac picked and no folder on it linked to
 * the project's repo, it says so in one sentence and offers that Mac's git
 * folders to link one (StartFolderChoice), right here, not in Settings.
 */
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { MacEnvironmentItem } from '@/lib/local-agent/environment-client'
import { setProjectMacDefault } from './api'
import { EnvironmentKindIcon } from './environment-meta'
import { macLinksRepo } from './project-environment-field'
import { StartFolderAnchor, StartFolderChoice } from './start-folder-choice'
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
  const [saving, setSaving] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const coding = enabled && place.loaded ? place.coding : null
  const macs = place.macs
  if (!coding || macs.length === 0) return null

  const current = place.macId ? (macs.find((m) => m.id === place.macId) ?? place.mac) : null
  const unlinked = unlinkedFolderSentence(current, coding.repo)
  const where = place.macId ? `on ${current?.name || 'your Mac'}` : 'in the cloud'
  const isDefault = place.macId === place.defaultMacId

  function choose(value: string) {
    const next = value === CLOUD ? null : value
    if (next === place.macId || !coding) return
    place.pick(next)
    const mac = next ? (macs.find((m) => m.id === next) ?? null) : null
    const missing = unlinkedFolderSentence(mac, coding.repo)
    if (mac && missing) toast(missing, { description: 'Link one so the agent can work in it.', action: { label: 'Choose a folder', onClick: () => setChoosing(true) } })
  }

  async function makeDefault() {
    if (!coding) return
    const environmentId = place.macId
    setSaving(true)
    const res = await setProjectMacDefault({ projectId: coding.projectId, environmentId })
    setSaving(false)
    if (!res.ok) {
      toast.error('Couldn’t change this project’s default', { description: res.error })
      return
    }
    place.reload()
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
  const noteFor = (id: string | null, online = true) =>
    [id === place.defaultMacId ? 'project default' : null, online ? null : 'offline'].filter(Boolean).join(' · ') || undefined

  return (
    <StartFolderChoice open={choosing} onOpenChange={setChoosing} mac={current} repo={coding.repo} mode="link">
      <StartFolderAnchor asChild>
      <span className="inline-flex">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild disabled={disabled || saving}>
          <button
            type="button"
            data-start-agent-where={place.macId ? 'mac' : 'cloud'}
            {...(unlinked ? { 'data-start-agent-where-unlinked': '' } : {})}
            title={unlinked ?? `This task runs ${where}`}
            aria-label={`Runs ${where}. Change where this task runs`}
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
          <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">Run this task on</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={place.macId ?? CLOUD} onValueChange={choose} aria-label="Where this task runs">
            {optionRow(CLOUD, 'Cloud', 'cloud', noteFor(null))}
            {macs.map((m) => optionRow(m.id, m.name || 'Your Mac', 'mac', noteFor(m.id, m.online)))}
          </DropdownMenuRadioGroup>
          {unlinked && current && (
            <>
              <DropdownMenuSeparator />
              <p data-start-agent-where-unlinked-note="" className="px-2 pb-1 pt-1 text-xs text-muted-foreground">
                {unlinked}
              </p>
              <DropdownMenuItem data-start-agent-where-link="" onSelect={() => setChoosing(true)} className="rounded-2xl px-2 py-2 text-sm">
                Choose a folder…
              </DropdownMenuItem>
            </>
          )}
          {!isDefault && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-start-agent-where-make-default=""
                onSelect={() => void makeDefault()}
                className="rounded-2xl px-2 py-2 text-xs text-muted-foreground"
              >
                Make this the default for this project
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      </span>
      </StartFolderAnchor>
    </StartFolderChoice>
  )
}
