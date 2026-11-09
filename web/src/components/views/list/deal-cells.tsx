'use client'

/**
 * A deal row's own cells (roadmap #8): the stage chip (green when won, muted
 * red when lost), the money, the owner's avatar and the expected close date,
 * flagged once it has passed on a deal still open. Everything else falls
 * through to entity-row's shared cells (company, created_at …).
 */
import { parseISO, startOfDay, format } from 'date-fns'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { formatDealValue } from '@/lib/crm/deal-format'

const chipClass = 'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap'

type Stage = { name?: string; kind?: 'open' | 'won' | 'lost'; color?: string | null } | null | undefined

export function dealStageKind(item: Record<string, unknown>): 'open' | 'won' | 'lost' {
  return ((item.stage as Stage)?.kind ?? 'open') as 'open' | 'won' | 'lost'
}

const initials = (name: string) => name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)

/** The cell for a deal property, or `undefined` to let the shared cells draw it. */
export function DealCell({ item, property }: { item: Record<string, unknown>; property: string }) {
  switch (property) {
    case 'stage': {
      const stage = item.stage as Stage
      if (!stage?.name) return null
      return (
        <span
          data-deal-stage={stage.kind ?? 'open'}
          className={cn(
            chipClass,
            stage.kind === 'won' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
            stage.kind === 'lost' && 'border-red-500/30 bg-red-500/5 text-red-700/80 dark:text-red-300/80',
          )}
        >
          {stage.name}
        </span>
      )
    }
    case 'value': {
      const label = formatDealValue(item.value as number | null, item.currency as string | null)
      return label ? <span className="text-[12px] font-medium tabular-nums text-foreground/90 whitespace-nowrap">{label}</span> : null
    }
    case 'owner': {
      const owner = item.owner as { display_name?: string; avatar_url?: string } | null
      if (!owner?.display_name) return null
      return (
        <Avatar className="h-5 w-5 border border-border/60" title={owner.display_name}>
          {owner.avatar_url && <AvatarImage src={owner.avatar_url} />}
          <AvatarFallback className="text-[9px] bg-muted/40">{initials(owner.display_name)}</AvatarFallback>
        </Avatar>
      )
    }
    case 'expected_close_date': {
      const val = item.expected_close_date as string | null
      if (!val) return null
      const d = parseISO(val)
      const overdue = dealStageKind(item) === 'open' && d < startOfDay(new Date())
      return (
        <span className={chipClass} title={overdue ? 'Past its expected close date' : 'Expected close'}>
          {overdue && <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-destructive" />}
          {format(d, 'MMM d')}
        </span>
      )
    }
    case 'closed_at': {
      const val = item.closed_at as string | null
      return val ? <span className={chipClass}>{format(new Date(val), 'MMM d')}</span> : null
    }
    default:
      return undefined
  }
}
