'use client'

/**
 * The composer's environment selector (docs/plans/environments.md §6), under
 * the message box: where this chat sends its work, as the environment's kind
 * mark and its name. Its menu lists your Macs first (each with an online
 * dot), then the workspace's cloud environments you can see, then New cloud
 * environment…, which opens Edit environment and puts the chat on the new one.
 *
 * The repo's dropdown menu (Radix): a menu of radio items, so the keyboard
 * works as a menu's does (arrows, Home / End, Enter or Space to pick, Escape,
 * type to jump) and the chat's environment reads as the checked one.
 *
 * The list is read when the menu opens, never on a timer
 * (composer-state.ts useComposerEnvironment says when the selector shows at
 * all: not when you have neither a Mac nor a cloud environment). A pick is
 * PUT at once. Desktop and web alike: the web lists your Macs too; adding a
 * folder is said there to happen on that Mac.
 *
 * The menu and the dialog portal out of the composer, but their presses and
 * keys still bubble up the React tree to it (it would take the focus back to
 * the text box; `/` would open the palette): both stop them (the dialog by
 * itself).
 */
import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatEnvironment, EnvironmentItem, EnvironmentsSnapshot } from '@/lib/local-agent/environment-client'
import { EditEnvironmentDialog } from './edit-environment-dialog'
import { EnvironmentKindIcon, NETWORK_OPTIONS, OnlineDot } from './environment-meta'

export interface EnvironmentSelectorProps {
  /** Where this chat's work runs now. */
  chat: ChatEnvironment
  /** Your environments (read when the menu opens). */
  list: EnvironmentsSnapshot
  /** The menu opened: read the list. */
  onOpenMenu: () => void
  /** Send this chat's work there. */
  onPick: (environment: EnvironmentItem) => void
  /** False while the composer is hidden: the menu closes. */
  isActive?: boolean
  /** The menu or the dialog opened or closed (the composer holds itself open meanwhile). */
  onOpenChange?: (open: boolean) => void
}

const stop = (e: SyntheticEvent) => e.stopPropagation()

export function EnvironmentSelector({ chat, list, onOpenMenu, onPick, isActive = true, onOpenChange }: EnvironmentSelectorProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // New cloud environment… was chosen: the closing menu leaves the focus to the dialog.
  const creatingRef = useRef(false)
  const current = chat.environment

  useEffect(() => {
    if (!isActive) setMenuOpen(false)
  }, [isActive])
  // One hold while either is open.
  const holding = menuOpen || creating
  useEffect(() => {
    if (!holding) return
    onOpenChange?.(true)
    return () => onOpenChange?.(false)
  }, [holding, onOpenChange])

  const macs = list.environments.filter((e) => e.kind === 'mac')
  const clouds = list.environments.filter((e) => e.kind === 'cloud')
  // Before the first read lands, the chat's own environment stands for the list.
  const shownMacs = list.loaded ? macs : current?.kind === 'mac' ? [current] : []
  const shownClouds = list.loaded ? clouds : current?.kind === 'cloud' ? [current] : []
  const shown = [...shownMacs, ...shownClouds]

  const pick = (id: string) => {
    const env = shown.find((e) => e.id === id)
    if (env && env.id !== current?.id) onPick(env)
  }

  return (
    <>
      <DropdownMenu
        modal={false}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open)
          if (open) onOpenMenu()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-environment-selector={current?.kind ?? 'none'}
            aria-label={current ? `Environment: ${current.name}` : 'Choose an environment'}
            title={current ? `This chat’s work runs on ${current.name}` : 'Choose where this chat’s work runs'}
            className="flex h-7 min-w-0 max-w-[16rem] shrink items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent/40 data-[state=open]:text-foreground motion-reduce:transition-none"
          >
            {current ? (
              <EnvironmentKindIcon kind={current.kind} className="size-3.5" />
            ) : (
              <EnvironmentKindIcon kind="cloud" className="size-3.5 opacity-50" />
            )}
            <span data-environment-selector-name="" className="min-w-0 truncate">
              {current ? current.name : 'No environment'}
            </span>
            <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          data-environment-menu=""
          aria-label="Environment"
          className="w-72"
          onMouseDown={stop}
          onClick={stop}
          onKeyDown={stop}
          onCloseAutoFocus={(e) => {
            if (!creatingRef.current) return
            creatingRef.current = false
            e.preventDefault()
          }}
        >
          {shownMacs.length > 0 && (
            <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={pick} aria-label="Your Macs">
              <MenuHeading>Your Macs</MenuHeading>
              {shownMacs.map((env) => (
                <MenuRow key={env.id} env={env} selected={env.id === current?.id} />
              ))}
            </DropdownMenuRadioGroup>
          )}
          {shownMacs.length > 0 && shownClouds.length > 0 && <DropdownMenuSeparator className="mx-0 my-1" />}
          {shownClouds.length > 0 && (
            <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={pick} aria-label="Cloud">
              <MenuHeading>Cloud</MenuHeading>
              {shownClouds.map((env) => (
                <MenuRow key={env.id} env={env} selected={env.id === current?.id} />
              ))}
            </DropdownMenuRadioGroup>
          )}
          {!list.loaded && (
            <div data-environment-menu-loading="" className="flex items-center gap-2 px-2 py-2 text-[13px] text-muted-foreground">
              <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
              Loading…
            </div>
          )}
          {shown.length > 0 && <DropdownMenuSeparator className="mx-0 my-1" />}
          <DropdownMenuItem
            data-environment-new-cloud=""
            onSelect={() => {
              creatingRef.current = true
              setCreating(true)
            }}
            className="gap-2.5 py-2 text-muted-foreground focus:text-foreground"
          >
            <Plus aria-hidden className="size-4 shrink-0" />
            New cloud environment…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Portalled too; it stops its own presses short of the composer. */}
      {creating && (
        <EditEnvironmentDialog
          open
          onOpenChange={(open) => {
            if (!open) setCreating(false)
          }}
          environment={null}
          onSaved={(env) => onPick(env)}
        />
      )}
    </>
  )
}

function MenuHeading({ children }: { children: string }) {
  return <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{children}</DropdownMenuLabel>
}

function MenuRow({ env, selected }: { env: EnvironmentItem; selected: boolean }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      value={env.id}
      data-environment-option={env.id}
      className="relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
    >
      <EnvironmentKindIcon kind={env.kind} className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{env.name}</span>
      {env.kind === 'mac' ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <OnlineDot online={env.online} />
          {env.online ? 'Online' : 'Offline'}
        </span>
      ) : (
        <span className="shrink-0 text-[12px] text-muted-foreground">{NETWORK_OPTIONS[env.networkAccess].label}</span>
      )}
      <Check aria-hidden className={cn('size-3.5 shrink-0', selected ? 'text-foreground' : 'invisible')} />
    </DropdownMenuPrimitive.RadioItem>
  )
}
