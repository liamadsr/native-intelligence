'use client'

/**
 * Who did a piece of work, as a small mark: an agent's mark (AgentIcon, the
 * one mark every agent wears) or, for work no teammate owns, its lane's own
 * mark (never "You"). Shared by an agent's page (work-rows.tsx) and the
 * entity tab.
 *
 * Marks are decorative: each stands beside its teammate's or lane's name,
 * which is what assistive tech reads.
 */
import {
  CloudDownload,
  Code2,
  FlaskConical,
  Inbox,
  Search,
  Send,
  Sparkles,
  Telescope,
  Wand2,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { AGENT_ICON, AgentIcon } from '@/components/agents/agent-icon'
import { cn } from '@/lib/utils'
import type { WorkOwner } from '@/lib/work/agent-work-lanes'

/** Each lane's mark: the work named for itself, never "You". */
const LANE_ICONS: Record<string, LucideIcon> = {
  prospecting: Telescope,
  eval: FlaskConical,
  onboarding_research: Search,
  sequence_enrolment: Send,
  crm_enrichment: Sparkles,
  crm_import: CloudDownload,
  email_import: Inbox,
  skill_run: Wand2,
  coding_run: Code2,
  work_run: AGENT_ICON,
}

/** The marks' two sizes: a row's (`sm`, 20 px) and a roster figure's (`lg`, 40 px). */
const MARK_SIZES = {
  sm: { box: 'h-5 w-5', icon: 'h-3 w-3', corner: 'rounded-md' },
  lg: { box: 'h-10 w-10', icon: 'h-5 w-5', corner: 'rounded-xl' },
} as const

/**
 * A teammate's mark: the agent mark on a muted chip, whoever it is. `size` is
 * a row's mark (`sm`, the default) or a roster figure's (`lg`).
 */
export function TeammateMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { box, icon, corner } = MARK_SIZES[size]
  return (
    <span data-teammate-mark="" className={cn('flex shrink-0 items-center justify-center bg-muted', corner, box)} aria-hidden>
      <AgentIcon className={icon} />
    </span>
  )
}

/** A lane's own mark (Prospecting's telescope, Evals' flask, ...). */
export function LaneMark({ kind }: { kind: string }) {
  const Icon = LANE_ICONS[kind] ?? Zap
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground" aria-hidden>
      <Icon className="h-3 w-3" />
    </span>
  )
}

/** The mark for a work item's owner (agent-work-lanes.ts ownerOf). */
export function OwnerMark({ owner }: { owner: WorkOwner }) {
  return owner.type === 'lane' ? <LaneMark kind={owner.kind} /> : <TeammateMark />
}
