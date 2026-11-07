'use client'

/**
 * Granola-style icon for library items: a bold "/" on a pastel rounded-square
 * background. Used everywhere library items (skills, agents, meeting types) or
 * slash commands are displayed: marketplace cards, slash-command picker,
 * library item detail dialogs, the header button, etc.
 */

/** Pastel background colors for library item icons. */
const LIBRARY_ITEM_COLORS = [
  '#a3d977', // green
  '#f5c563', // amber
  '#a8b4fc', // periwinkle
  '#7dd3c0', // teal
  '#f9a8d4', // pink
  '#fca5a5', // red
  '#93c5fd', // blue
  '#c4b5fd', // violet
  '#fdba74', // orange
  '#86efac', // mint
]

/** Pick a stable color for a library item based on its id or name. */
function pickLibraryItemColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  return LIBRARY_ITEM_COLORS[Math.abs(hash) % LIBRARY_ITEM_COLORS.length]
}

interface LibraryItemIconProps {
  /** Optional explicit color — overrides the seeded color */
  color?: string | null
  /** Seed used to pick a stable color when `color` is not provided */
  seed?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

export function LibraryItemIcon({ color, seed, size = 'md', className = '' }: LibraryItemIconProps) {
  const bg = color || (seed ? pickLibraryItemColor(seed) : LIBRARY_ITEM_COLORS[0])
  const dim =
    size === 'xs' ? 'h-6 w-6 text-xs' :
    size === 'sm' ? 'h-7 w-7 text-sm' :
    size === 'lg' ? 'h-10 w-10 text-lg' :
    'h-9 w-9 text-base'
  return (
    <div
      className={`${dim} flex shrink-0 items-center justify-center rounded-lg font-bold text-foreground ${className}`}
      style={{ backgroundColor: bg + '30' }}
    >
      /
    </div>
  )
}
