'use client'

/**
 * The 20 conditional-formatting icon kinds the engine can return, drawn as
 * small inline glyphs: lucide icons where one fits, a rotated triangle or a
 * CSS rhombus where it does not. Our own drawings, not Macro's assets.
 */
import {
  ArrowDown,
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  Circle,
  Flag,
  Heart,
  Minus,
  Star,
  ThumbsDown,
  ThumbsUp,
  Triangle,
  X,
  type LucideIcon,
} from 'lucide-react'

/** Which lucide icon stands for each kind, and how it is turned or filled. */
const MAP: Record<string, { icon: LucideIcon; rotate?: number; fill?: boolean }> = {
  ArrowUp: { icon: ArrowUp },
  ArrowRight: { icon: ArrowRight },
  ArrowDown: { icon: ArrowDown },
  ArrowAngleUp: { icon: ArrowUpRight },
  ArrowAngleDown: { icon: ArrowDownRight },
  Circle: { icon: Circle, fill: true },
  TriangleUp: { icon: Triangle },
  TriangleDown: { icon: Triangle, rotate: 180 },
  TriangleUpFilled: { icon: Triangle, fill: true },
  TriangleDownFilled: { icon: Triangle, rotate: 180, fill: true },
  FlatRectangle: { icon: Minus },
  Flag: { icon: Flag, fill: true },
  Check: { icon: Check },
  Cross: { icon: X },
  Star: { icon: Star, fill: true },
  Heart: { icon: Heart, fill: true },
  ThumbsUp: { icon: ThumbsUp },
  ThumbsDown: { icon: ThumbsDown },
}

export function CfGlyph({ kind, color, size = 12 }: { kind: string; color: string; size?: number }) {
  // A rhombus has no lucide match; draw it as a rotated square.
  if (kind === 'Rhombus' || kind === 'Exclamation') {
    if (kind === 'Exclamation') {
      return (
        <span aria-hidden style={{ color, fontWeight: 700, fontSize: size, lineHeight: 1 }}>
          !
        </span>
      )
    }
    return <span aria-hidden style={{ width: size * 0.72, height: size * 0.72, backgroundColor: color, transform: 'rotate(45deg)', borderRadius: 1, display: 'inline-block' }} />
  }
  const entry = MAP[kind] ?? { icon: Circle, fill: true }
  const Icon = entry.icon
  return (
    <Icon
      aria-hidden
      width={size}
      height={size}
      style={{ color, transform: entry.rotate ? `rotate(${entry.rotate}deg)` : undefined }}
      fill={entry.fill ? color : 'none'}
    />
  )
}
