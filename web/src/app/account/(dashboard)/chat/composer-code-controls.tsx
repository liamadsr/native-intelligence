'use client'

/**
 * The main composer's Chat / Code controls (composer-code.tsx is their hook):
 *
 *   ComposerTabs      under the box, first: the agent's name (the chat) and Code. The repo's
 *                     ToggleGroup (Radix, type single): one radio group with
 *                     roving focus, so the arrow keys move between the two and
 *                     the one in front is announced as checked. Code wears an
 *                     orange dot while a coding agent's work waits on your
 *                     review (Liam, 11-20), the Code view's own For you.
 *   CodeAgentPicker   in the box's controls row, before the mic (Code only):
 *                     who you work with. Native Intelligence, then "Your
 *                     agents" (what the chat's Mac offers), then "Needs
 *                     connection" (what the registry knows and the Mac
 *                     doesn't, with one line saying how to connect one).
 *   CodeFolderPicker  under the box, after the environment (Code only): the
 *                     folder on that Mac a new job works in, and Select
 *                     folder… in the desktop app.
 *   CodeNoticeLine    under the box: why it doesn't send (a cloud
 *                     environment, no folder), what the last send came back
 *                     with (a second send to an open job: Open it), or that what is staged for Chat (files, mentions,
 *                     a skill) isn't sent. Nothing when there is nothing to say.
 *
 * The menus are the repo's dropdown menu (Radix): radio items, so the
 * keyboard works as a menu's does. They portal out of the composer, and stop
 * their presses and keys short of it, as the environment selector's does.
 */
import type { SyntheticEvent } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, FolderGit2, FolderOpen, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/agents/agent-icon'
import { codingAgentConnectHint } from '@/lib/environments/types'
import type { ComposerTab } from '@/lib/local-agent/code-tab'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import type { ComposerCode } from './composer-code'
import { useCodeForYouEntries } from './for-you-column'

const stop = (e: SyntheticEvent) => e.stopPropagation()

/** The picker's value for Native Intelligence's own agent: never a worker id (those have no colon). */
const NATIVE = ':native'

/** The track, the environment chip's height, a pill as the composer above it is (Liam, 11-16), in the composer's greys. */
const TRACK = 'h-7 shrink-0 flex-nowrap justify-start gap-0.5 rounded-full border border-border/70 bg-muted/70 p-0.5 dark:bg-background'

/** A tab: plain text; in front, a raised pill clearly apart from the track in both themes. */
const TAB =
  'h-[22px] rounded-full px-3 text-[13px] font-normal text-muted-foreground hover:bg-background/70 hover:text-foreground dark:hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm data-[state=on]:ring-1 data-[state=on]:ring-border dark:data-[state=on]:bg-accent motion-reduce:transition-none'

/** A quiet text button under the box, as the environment selector is. */
const CHIP =
  'flex h-7 min-w-0 max-w-[14rem] shrink items-center gap-1.5 overflow-hidden rounded-full px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent/40 data-[state=open]:text-foreground motion-reduce:transition-none'

const ROW =
  'relative flex cursor-default select-none items-center gap-2.5 rounded-2xl px-2 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none'

export function ComposerTabs({ tab, onTab }: { tab: ComposerTab; onTab: (tab: ComposerTab) => void }) {
  const { name: agentName } = useAssistantName()
  // A coding agent's work waiting on your review: the Code tab's orange dot (Liam, 11-20), listed in the Code view's own For you.
  const waiting = useCodeForYouEntries().length
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={tab}
      // Radix answers '' when the tab in front is pressed again: nothing changes.
      onValueChange={(v) => {
        if (v === 'chat' || v === 'code') onTab(v)
      }}
      role="radiogroup"
      aria-label="Chat or code"
      data-composer-tabs=""
      className={TRACK}
    >
      {/* The chat tab carries the agent's own name (Liam, 11-16), the default until the person names it. */}
      <ToggleGroupItem value="chat" data-composer-tab="chat" className={TAB} title={`Chat with ${agentName}`} aria-label={`Chat with ${agentName}`}>
        <span className="max-w-[9rem] truncate">{agentName}</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        value="code"
        data-composer-tab="code"
        className={cn(TAB, waiting > 0 && 'gap-1.5')}
        title={waiting > 0 ? `Code: ${waiting} waiting on your review` : 'Work with a coding agent directly, in a folder on your Mac'}
      >
        Code
        {waiting > 0 && (
          <span data-composer-tab-attention="" className="size-1.5 shrink-0 rounded-full bg-orange-500">
            <span className="sr-only">, {waiting} waiting on your review</span>
          </span>
        )}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

/**
 * How a message to the open coding chat lands while its agent works (the
 * conversation's own choice, local-agent-composer.tsx): Steer, now, or Queue,
 * when this turn ends. Under the box, in the tabs' look. Only while it works:
 * idle, either starts its next turn.
 */
export function CodePolicyToggle({ messaging }: { messaging: NonNullable<ComposerCode['messaging']> }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={messaging.policy}
      onValueChange={(v) => {
        if (v === 'steer' || v === 'queue') messaging.setPolicy(v)
      }}
      role="radiogroup"
      aria-label="How your message lands"
      data-code-policy=""
      className={TRACK}
    >
      <ToggleGroupItem value="steer" data-code-policy-option="steer" className={TAB} title="Lands while it works">
        Steer
      </ToggleGroupItem>
      <ToggleGroupItem value="queue" data-code-policy-option="queue" className={TAB} title="Waits for this turn to end">
        Queue
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function MenuHeading({ children }: { children: string }) {
  return <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{children}</DropdownMenuLabel>
}

export function CodeAgentPicker({ code, onOpenChange }: { code: ComposerCode; onOpenChange?: (open: boolean) => void }) {
  const { agents } = code
  const value = code.agent ?? NATIVE
  const option = (o: { id: string | null; label: string }) => (
    <DropdownMenuPrimitive.RadioItem key={o.id ?? NATIVE} value={o.id ?? NATIVE} data-code-agent-option={o.id ?? 'native'} className={ROW}>
      <span className="min-w-0 flex-1 truncate">{o.label}</span>
      <Check aria-hidden className={cn('size-3.5 shrink-0', value === (o.id ?? NATIVE) ? 'text-foreground' : 'invisible')} />
    </DropdownMenuPrimitive.RadioItem>
  )
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-code-agent-picker={code.agent ?? 'native'}
          // The box around it (PromptInput) focuses the field on any click that
          // reaches it, and focus leaving the menu closes it: a plain click on
          // this trigger opened the menu and shut it at once. The click stops
          // here, as the box's other controls' do.
          onClick={stop}
          aria-label={`Agent: ${code.agentLabel}`}
          title={code.agent ? `${code.agentLabel} does the work, on your own ${code.agentLabel} account` : `${code.agentLabel} does the work, on your Mac`}
          className="flex h-8 min-w-0 max-w-[12rem] shrink items-center gap-1 rounded-full px-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground @max-[22rem]/chatinput:px-1.5"
        >
          <AgentIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate @max-[22rem]/chatinput:hidden">{code.agentLabel}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64" data-code-agent-menu="" aria-label="Agent" onMouseDown={stop} onClick={stop} onKeyDown={stop}>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => code.pickAgent(v === NATIVE ? null : v)} aria-label="Agent">
          {option(agents.native)}
          {agents.yours.length > 0 && (
            <>
              <DropdownMenuSeparator className="mx-0 my-1" />
              <MenuHeading>Your agents</MenuHeading>
              {agents.yours.map(option)}
            </>
          )}
        </DropdownMenuRadioGroup>
        {agents.needsConnection.length > 0 && (
          <>
            <DropdownMenuSeparator className="mx-0 my-1" />
            <MenuHeading>Needs connection</MenuHeading>
            {agents.needsConnection.map((o) => (
              <DropdownMenuItem key={o.id} disabled data-code-agent-needs-connection={o.id ?? ''} className="gap-2.5 py-2 text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </DropdownMenuItem>
            ))}
            <p data-code-agent-connect-hint="" className="px-2 pb-1.5 pt-0.5 text-[12px] leading-snug text-muted-foreground">
              {codingAgentConnectHint(code.macName)}
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function CodeFolderPicker({ code, onOpenChange }: { code: ComposerCode; onOpenChange?: (open: boolean) => void }) {
  const current = code.folders.find((f) => f.id === code.folderId) ?? null
  // Nothing to pick and nothing to add: the notice line says what to do.
  if (code.folders.length === 0 && !code.canAddFolder) return null
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-code-folder-picker={current?.id ?? 'none'}
          aria-label={current ? `Folder: ${current.label}` : 'Choose a folder'}
          title={current ? `New jobs work in ${current.label}, on their own branch` : 'Choose the folder to code in'}
          className={CHIP}
        >
          <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{current ? current.label : 'Choose a folder'}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72" data-code-folder-menu="" aria-label="Folder" onMouseDown={stop} onClick={stop} onKeyDown={stop}>
        {code.folders.length > 0 && (
          <DropdownMenuRadioGroup value={code.folderId ?? ''} onValueChange={code.pickFolder} aria-label="Folder">
            <MenuHeading>{code.macName ? `Folders on ${code.macName}` : 'Folders'}</MenuHeading>
            {code.folders.map((f) => (
              <DropdownMenuPrimitive.RadioItem key={f.id} value={f.id} disabled={!f.usable} data-code-folder-option={f.id} className={ROW}>
                <FolderGit2 aria-hidden className={cn('size-4 shrink-0 text-muted-foreground', !f.usable && 'opacity-50')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate', !f.usable && 'text-muted-foreground')}>{f.label}</span>
                  {f.note && <span className="block truncate text-[12px] text-muted-foreground">{f.note}</span>}
                </span>
                <Check aria-hidden className={cn('size-3.5 shrink-0', code.folderId === f.id ? 'text-foreground' : 'invisible')} />
              </DropdownMenuPrimitive.RadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        {code.canAddFolder && (
          <>
            {code.folders.length > 0 && <DropdownMenuSeparator className="mx-0 my-1" />}
            <DropdownMenuItem data-code-folder-add="" onSelect={code.addFolder} className="gap-2.5 py-2 text-muted-foreground focus:text-foreground">
              {code.folders.length > 0 ? <Plus aria-hidden className="size-4 shrink-0" /> : <FolderOpen aria-hidden className="size-4 shrink-0" />}
              Select folder…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What the Code tab says when something is staged that only the Chat tab sends. */
export const CODE_WORDS_ONLY_LINE = 'The coding agent gets your words only. What’s attached above stays for Chat.'

/**
 * The line under the box: why it doesn't send, what the last send came back
 * with, or (`staged`) that what is staged above isn't sent to the coding agent.
 */
export function CodeNoticeLine({ code, staged = false }: { code: ComposerCode; staged?: boolean }) {
  const line = code.notice ?? code.blocker ?? (staged ? CODE_WORDS_ONLY_LINE : null)
  if (!line) return null
  const actions = code.notice ? code.noticeActions : []
  return (
    <p data-code-notice={code.notice ? 'send' : code.blocker ? 'blocker' : 'staged'} role="status" className="basis-full px-1.5 pt-0.5 text-[12px] leading-snug text-muted-foreground">
      {line}
      {actions.map((action, i) => (
        <span key={action.id}>
          {i === 0 ? ' ' : <span aria-hidden> · </span>}
          <button
            type="button"
            data-code-notice-action={action.id}
            disabled={code.sending}
            onClick={action.run}
            className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {action.label}
          </button>
        </span>
      ))}
    </p>
  )
}
