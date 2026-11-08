'use client'

import { clsx } from 'clsx'
import { motion } from 'framer-motion'

export function Logo({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <img src="/brand/ni-mark.png" alt="" aria-hidden className="h-5 w-5 brightness-0 dark:invert" />
      <span className="text-lg font-semibold tracking-tight whitespace-nowrap text-gray-950 dark:text-white">Native Intelligence</span>
    </div>
  )
}

/**
 * The Native Intelligence mark (NI) on its own — the SAME asset <Logo> uses, so every surface
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
      src="/brand/ni-mark.png"
      alt="Native Intelligence"
      className={clsx('w-auto brightness-0 dark:invert', className)}
    />
  )
}
