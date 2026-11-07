'use client'

/**
 * Editing the agent (how to reach it: the Phone and Slack tabs; who can:
 * People; its name and look: Look; agent-look-editor.tsx), opened
 * from the side panel's agent card: a click on its bot (AgentLookButton) or on
 * the settings icon at the row's far right (AgentEditButton, Liam 10-23: "a
 * gear icon or a fine-tune icon ... so that you know that's where you're
 * editing the agent's information").
 *
 * One editor for both, hosted once by the panel (AgentEditorHost) rather than
 * by the card, so a draft survives the card going away mid-edit. A small
 * module store says whether it's open and what opened it, where the focus
 * goes back when it closes. The editor's module, and the renderer with it, is
 * fetched on the first opening (or when the pointer first comes near either
 * control); each opening mounts it afresh (keyed), so a failed fetch is tried
 * again on the next.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Settings2 } from 'lucide-react'
import type { BotAvatarState } from 'bot-avatars'
import { cn } from '@/lib/utils'
import { lazyComponent } from '@/lib/lazy-component'
import { AgentBot } from './agent-bot'

const AgentLookDialog = lazyComponent(() => import('./agent-look-editor').then((m) => m.AgentLookDialog))

/** The panel's tabs (AGENT_PANEL_TABS in agent-look-editor.tsx, kept here so opening it doesn't fetch the module). */
export type AgentPanelTab = 'look' | 'phone' | 'slack' | 'people'

interface EditorState {
  open: boolean
  /** Each opening's number: the dialog is keyed by it. 0 until the first. */
  opening: number
  /** What opened it: the focus goes back there. */
  opener: HTMLElement | null
  /** The tab it opens on. */
  tab: AgentPanelTab
  /** People: the person it opens on (their page, or their request highlighted). */
  guestId?: string
  /** People: the agent link request it opens on, to review. */
  linkId?: string
}

let state: EditorState = { open: false, opening: 0, opener: null, tab: 'look' }
const listeners = new Set<() => void>()
const set = (next: EditorState) => {
  state = next
  for (const listener of [...listeners]) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const SERVER_STATE: EditorState = { open: false, opening: 0, opener: null, tab: 'look' }

export function useAgentEditor(): EditorState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE)
}

/**
 * Open the editor, on `tab` (Look by default); `opener` gets the focus back
 * when it closes. On People, `guestId` lands on that person (a chat card's
 * "Manage in People"), and `linkId` on an agent's request to review.
 */
export function openAgentEditor(opener: HTMLElement | null, tab: AgentPanelTab = 'look', opts: { guestId?: string; linkId?: string } = {}): void {
  set({ open: true, opening: state.opening + 1, opener, tab, guestId: opts.guestId, linkId: opts.linkId })
}

/** The page's `?agent-link=<id>` (a connect link just opened): the id, once, and the param comes off the address. */
export function takeAgentLinkParam(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const id = url.searchParams.get('agent-link')
  if (!id) return null
  url.searchParams.delete('agent-link')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return id
}

export function closeAgentEditor(): void {
  if (state.open) set({ ...state, open: false })
}

/** Fetch the editor ahead of a click. */
export function preloadAgentEditor(): void {
  AgentLookDialog.preload()
}

/** Tests only. */
export function __resetAgentEditorForTests(): void {
  state = { open: false, opening: 0, opener: null, tab: 'look' }
  listeners.clear()
}

/** The editor, mounted once by the side panel: nothing until it's first opened. */
export function AgentEditorHost() {
  const editor = useAgentEditor()
  // The panel going away closes it: it doesn't open again by itself when the panel comes back.
  useEffect(() => () => closeAgentEditor(), [])
  // A connect link lands here with ?agent-link=: open People on that request.
  useEffect(() => {
    const linkId = takeAgentLinkParam()
    if (linkId) openAgentEditor(null, 'people', { linkId })
  }, [])
  if (editor.opening === 0) return null
  return (
    <AgentLookDialog
      key={editor.opening}
      open={editor.open}
      initialTab={editor.tab}
      guestId={editor.guestId}
      linkId={editor.linkId}
      onOpenChange={(open) => (open ? undefined : closeAgentEditor())}
      returnFocusTo={{ current: editor.opener }}
    />
  )
}

/** The agent's bot as a button: a click opens the editor. Behind the open editor it rests (the preview is the one moving). */
export function AgentLookButton({ name, state: botState, active, size }: { name: string; state: BotAvatarState; active: boolean; size: number }) {
  const editor = useAgentEditor()
  const label = `Change how ${name} looks`
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={editor.open}
      title={label}
      data-agent-look-open=""
      onPointerEnter={preloadAgentEditor}
      onClick={(e) => openAgentEditor(e.currentTarget)}
      className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentBot state={botState} active={active && !editor.open} size={size} />
    </button>
  )
}

/** The settings icon at the agent card's far right: the same editor. */
export function AgentEditButton({ name, className }: { name: string; className?: string }) {
  const editor = useAgentEditor()
  const label = `Edit ${name}`
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={editor.open}
      title={label}
      data-agent-edit=""
      onPointerEnter={preloadAgentEditor}
      // The settings icon opens on the first tab, Phone; the bot itself opens on Look.
      onClick={(e) => openAgentEditor(e.currentTarget, 'phone')}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Settings2 aria-hidden className="size-4" />
    </button>
  )
}
