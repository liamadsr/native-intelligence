'use client'

import { clsx } from 'clsx'
import { motion } from 'framer-motion'

export function Logo({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      <img
        src="/screenshots/icon_128x128@2x 1.png"
        alt="Dial8 logo"
        className="h-6 w-6 brightness-0 dark:invert"
      />
      <span className="text-xl font-semibold text-gray-950 dark:text-white">ial8</span>
    </div>
  )
}

/**
 * The Dial8 icon on its own — the SAME asset <Logo> uses, so every surface
 * (login, invites, trial wall, 404, marketing clusters) shows one mark. The
 * previous SVG here was a ring-of-dots glyph left over from an earlier
 * product and is gone for good; do not reintroduce a second mark.
 *
 * `brightness-0 dark:invert` renders it black on light and white on dark,
 * matching the wordmark. Callers that still pass `fill-*` classes are
 * harmless — an <img> ignores them.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <img
      src="/screenshots/icon_128x128@2x 1.png"
      alt="Dial8"
      className={clsx('w-auto brightness-0 dark:invert', className)}
    />
  )
}
