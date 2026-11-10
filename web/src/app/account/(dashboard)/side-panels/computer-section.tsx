'use client'

/**
 * The side panel's computer card (Liam, 2026-10-22: "a side panel at the top
 * of the right hand side panel ... a preview of the agent's computer ... the
 * entry point to see the agent's computer or take over";
 * docs/plans/cloud-browser.md, C3). Like the Computers list of an agent's
 * profile card: one row for the agent's own computer (its cloud browser),
 * named after the assistant, with its state and a small preview of the page
 * it is on. The row and the preview open the live view (live-view.tsx), where
 * the person can watch or take over.
 *
 * Its card and row are the panel's (side-panels.tsx PanelSection). The row
 * is the agent's own, as Dots' agent card (Liam, 2026-10-23): its bot
 * (bots/agent-bot.tsx, in agentBotState's state) and its name, with the
 * agent's status under it (agentSummary). The agent is always there, ready
 * (Liam: "the agent's status is always active ... the computer can fall
 * asleep"), so its bot never sleeps with the computer: only the computer's
 * row says Asleep. The rows below go under "Computers". No computer yet (the agent never used its
 * browser): the card still shows (Liam, 2026-10-24), its row saying so, and a
 * click on it opens the live view, which starts the browser (POST
 * /api/account/browser/live wakes it); the agent's first browsing starts it
 * too. Asleep, the preview keeps its last frame, dimmed; only a click wakes it.
 *
 * Under it, the Mac that carries the browser's traffic (C4), as in his
 * reference ("Connected"): on the desktop that drives it, this Mac's state
 * (no switch: it is always on); elsewhere, "Your Mac · Connected" while one is.
 * Nothing until there's something to say.
 */
import { memo } from 'react'
import { Laptop, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computerSummary, openLiveView, type ComputerState } from '@/lib/cloud-browser/computer-client'
import type { BotAvatarState } from 'bot-avatars'

/** The computer row's line before the agent has a cloud browser: a click starts one, where the live view is set up. */
export const NOT_SET_UP = 'Not set up — click to start'
export const NOT_SET_UP_NO_VIEW = 'Not set up yet'

const ROW = 'flex min-h-14 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'

export const ComputerSection = memo(function ComputerSection({ computer, name }: { computer: ComputerState; name: string }) {
  const summary = computerSummary(computer) ?? (computer.exists === false ? (computer.liveView ? NOT_SET_UP : NOT_SET_UP_NO_VIEW) : '')
  const awake = computer.status === 'running'
  return (
    // As the live view (isInBrowserSurface): the preview and today's sites are the person's browsing.
    <div data-computer-section="" data-ni-browser="" className="ph-no-capture px-1">
      <p className="px-2 pb-0.5 pt-1 text-xs text-muted-foreground">Computers</p>
      <button type="button" data-computer-open="" onClick={openLiveView} disabled={!computer.liveView}
        aria-label={`Open ${name}’s computer`} className={cn(ROW, !computer.liveView && 'cursor-default hover:bg-transparent')}>
        <span className="relative flex size-6 shrink-0 items-center justify-center text-muted-foreground">
          <Monitor aria-hidden className="size-4" />
          <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[var(--card-surface,theme(colors.background))]',
            awake ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">{name}’s computer</span>
          <span data-computer-state="" className="block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        {computer.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element -- an object URL of the hub's frame
          <img src={computer.thumbnail} alt="" data-computer-preview=""
            className={cn('h-10 w-16 shrink-0 rounded-md object-cover object-top ring-1 ring-border/60', !awake && 'opacity-50 grayscale')} />
        ) : (
          <span aria-hidden className="h-10 w-16 shrink-0 rounded-md bg-gradient-to-br from-slate-200 to-slate-400 ring-1 ring-border/60 dark:from-slate-700 dark:to-slate-900" />
        )}
      </button>
      <MacRow computer={computer} />
    </div>
  )
})

/** The agent is working its computer now (a task of its own running on it). */
function agentAtWork(computer: Pick<ComputerState, 'status' | 'driver' | 'busy'>): boolean {
  return computer.status === 'running' && computer.driver === 'agent' && computer.busy
}

/** The agent's bot on the card's row: at work while the agent works its computer, else awake. Never asleep: only its computer sleeps. */
export function agentBotState(computer: Pick<ComputerState, 'status' | 'driver' | 'busy'>): BotAvatarState {
  return agentAtWork(computer) ? 'working' : 'default'
}

/** The agent's status under its name (the card's summary): Working, else Active, whatever its computer is doing. */
export function agentSummary(computer: Pick<ComputerState, 'status' | 'driver' | 'busy'>): string {
  return agentAtWork(computer) ? 'Working' : 'Active'
}

/** The Mac exit's line (C4), or nothing. No switch: the agent uses the person's network whenever this Mac is online. */
export function macSummary(computer: Pick<ComputerState, 'mac' | 'macConnected' | 'status'>): { label: string; state: string } | null {
  const mac = computer.mac
  if (mac) {
    const sites = mac.sitesToday.length
    if (mac.state === 'up') return { label: 'This Mac', state: sites ? `Connected · ${sites} site${sites === 1 ? '' : 's'} today` : 'Connected' }
    if (mac.state === 'connecting' || mac.state === 'down') return { label: 'This Mac', state: 'Connecting…' }
    return null
  }
  return computer.macConnected && computer.status === 'running' ? { label: 'Your Mac', state: 'Connected' } : null
}

function MacRow({ computer }: { computer: ComputerState }) {
  const line = macSummary(computer)
  if (!line) return null
  return (
    <div data-computer-mac="" className="flex min-h-11 items-center gap-2.5 px-2 py-1">
      <span className="relative flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <Laptop aria-hidden className="size-4" />
        <span aria-hidden className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[var(--card-surface,theme(colors.background))]',
          line.state.startsWith('Connected') ? 'bg-emerald-500' : 'bg-amber-500')} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">{line.label}</span>
        <span data-computer-mac-state="" className="block truncate text-xs text-muted-foreground"
          title={computer.mac?.sitesToday.map(site => site.host).join(', ') || undefined}>{line.state}</span>
      </span>
    </div>
  )
}
