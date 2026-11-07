'use client'

/**
 * What every environments surface says the same way (docs/plans/
 * environments.md §6): a kind's mark (a laptop for a Mac, a cloud for a cloud
 * environment), a network level's name and its one-line meaning, and a Mac
 * folder's mode, which is the grant's and only shown.
 */
import { Cloud, Globe, Laptop, Lock, Shield, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NETWORK_ACCESS, type EnvironmentKind, type FolderMode, type NetworkAccess } from '@/lib/environments/types'

export interface NetworkOption {
  label: string
  /** What it reaches, in a few words (the side card, the menus). */
  short: string
  /** One line: what a run's commands can reach. */
  helper: string
  icon: LucideIcon
  badgeClass: string
}

export const NETWORK_OPTIONS: Record<NetworkAccess, NetworkOption> = {
  trusted: {
    label: 'Trusted',
    short: 'Any host',
    helper: 'Full network access: any host.',
    icon: Globe,
    badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  restricted: {
    label: 'Restricted',
    short: 'GitHub and npm only',
    helper: 'Only GitHub and the npm registry.',
    icon: Shield,
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  isolated: {
    label: 'Isolated',
    short: 'GitHub only',
    helper: 'Only GitHub, to clone and push.',
    icon: Lock,
    badgeClass: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  },
}

/** The three levels in the order they're offered. */
export const NETWORK_LEVELS: readonly NetworkAccess[] = NETWORK_ACCESS

/** Said once under the levels. */
export const NETWORK_NOTE = 'Commands in the sandbox reach nothing else. The agent’s web search and page reading run outside it.'

/** A Mac folder's mode: the grant's ceiling, set only by the Mac's native confirm. */
export const MODE_LABEL: Record<FolderMode, string> = { read: 'Read only', edit: 'Edits on a branch' }

export function kindIcon(kind: EnvironmentKind): LucideIcon {
  return kind === 'mac' ? Laptop : Cloud
}

export function EnvironmentKindIcon({ kind, className }: { kind: EnvironmentKind; className?: string }) {
  return kind === 'mac' ? <Laptop aria-hidden className={cn('shrink-0', className)} /> : <Cloud aria-hidden className={cn('shrink-0', className)} />
}

/** A Mac's presence: a green dot online, a grey one offline. */
export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-environment-online-dot={online ? 'online' : 'offline'}
      className={cn('size-1.5 shrink-0 rounded-full', online ? 'bg-emerald-500' : 'bg-muted-foreground/40', className)}
    />
  )
}
