'use client'

/**
 * A row of stat tiles, as on the Site audit page (the sequences and evals
 * tiles' look): a number that is never cut off, a small label under it.
 * The grid follows the CARD's width (a container query), not the window's.
 *
 * A value that is not known yet (a run still going, nothing read) is null and
 * draws as a dash with the reason in its title: unknown is not zero.
 */
import { cn } from '@/lib/utils'

export interface StatTile {
  key: string
  label: string
  /** null: not known yet. A string is shown as given ("$3.40", "4.6"). */
  value: number | string | null
  /** Why it is not known, or what the number means. */
  title?: string
  /** A small second line under the label ("up 3 since last week"). */
  note?: string
  /** A colour for the note when it reads as better or worse. */
  noteTone?: 'up' | 'down' | 'flat'
}

const NOTE_TONE: Record<NonNullable<StatTile['noteTone']>, string> = {
  up: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-red-700 dark:text-red-400',
  flat: 'text-muted-foreground',
}

export function StatTiles({ tiles, className }: { tiles: readonly StatTile[]; className?: string }) {
  if (tiles.length === 0) return null
  return (
    <div className={cn('@container', className)}>
      <div className={cn('grid grid-cols-2 gap-3', tiles.length >= 4 ? '@md:grid-cols-4' : tiles.length === 3 ? '@md:grid-cols-3' : '')}>
        {tiles.map((tile) => (
          <div key={tile.key} data-seo-tile={tile.key} className="min-w-0 rounded-lg border px-3 py-2.5">
            <p className="text-lg font-semibold break-words tabular-nums" title={tile.title}>
              {tile.value === null ? '—' : typeof tile.value === 'number' ? tile.value.toLocaleString() : tile.value}
            </p>
            <p className="text-[11px] text-muted-foreground">{tile.label}</p>
            {tile.note && <p className={cn('mt-0.5 text-[11px] tabular-nums', NOTE_TONE[tile.noteTone ?? 'flat'])}>{tile.note}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
