'use client'

/**
 * The storybook passage card — the heart of the enrollment "moment".
 *
 * The story text renders large and readable in Noto Serif (`font-heading`), a
 * deliberate departure from the app's Inter UI so reading the passage feels like
 * reading a book, not filling a form. While recording, a rotating `.glow-border`
 * (the same conic-gradient layer the landing chat uses) traces the card, and an
 * elapsed-dots row shows progress toward the ~15s / PASSAGE_MIN_CHUNKS gate.
 *
 * Presentation only: the wizard owns the recorder, timing, and gating; this card
 * renders passage text + recording chrome + the always-present Continue button
 * (progressive enhancement — auto-advance is layered on top, never the only way
 * forward, so there are no audio-driven dead ends). The story text is real,
 * screen-reader-readable text — never an image.
 */

import { motion } from 'framer-motion'
import { Mic, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AudioLevelMeter } from '@/components/desktop/audio-level-meter'
import type { EnrollmentPassage } from '@/lib/voice-profile/enrollment-story'

/** Human phrase for the level meter's visually-hidden equivalent. */
function levelWord(level: number): string {
  if (level >= 0.08) return 'good'
  if (level >= 0.03) return 'fair'
  if (level > 0) return 'quiet'
  return 'silent'
}

export function PassageCard({
  passage,
  index,
  total,
  recording,
  level,
  elapsedSeconds,
  targetSeconds,
  canContinue,
  advancing = false,
  retryReason,
  onContinue,
}: {
  passage: EnrollmentPassage
  /** 0-based passage index. */
  index: number
  total: number
  recording: boolean
  level: number
  /** Voiced seconds captured so far this passage. */
  elapsedSeconds: number
  /** Seconds of voiced audio the passage needs to auto-advance. */
  targetSeconds: number
  /** True once thresholds are met — enables the Continue button. */
  canContinue: boolean
  /** True while Continue is finalizing the tail (chunk+embed the small remaining
   *  region). Disables Continue and shows a brief spinner — the bulk of the audio
   *  was already embedded incrementally, so this normally flashes for well under
   *  a second. */
  advancing?: boolean
  /** A "one more time?" reason after a failed take, or null. */
  retryReason: string | null
  onContinue: () => void
}) {
  // Elapsed dots: one per second up to target, filled as voiced audio accrues.
  const dotCount = Math.max(1, Math.round(targetSeconds))
  const filled = Math.min(dotCount, Math.round(elapsedSeconds))
  const progressPct = Math.min(100, Math.round((elapsedSeconds / targetSeconds) * 100))

  return (
    <div className="flex flex-col items-center text-center">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {passage.title} · {index + 1} of {total}
      </p>

      {/* Passage card — glow-border traces it while recording. The glow layer
          sits behind the card via -inset and a rounded radius var. */}
      <div
        className="relative mt-5 w-full"
        style={{ '--glow-radius': '1.25rem' } as React.CSSProperties}
      >
        {recording && (
          <div
            aria-hidden
            className="glow-border pointer-events-none absolute -inset-[2px] rounded-[calc(var(--glow-radius)+2px)]"
          />
        )}
        <div className="relative rounded-[var(--glow-radius)] border border-border/60 bg-card px-6 py-7 sm:px-8 sm:py-9">
          <p className="font-heading text-xl leading-relaxed text-foreground sm:text-2xl">
            {passage.text}
          </p>
        </div>
      </div>

      {/* Recording chrome: mic pill + level meter + elapsed dots. */}
      <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <motion.span
            animate={recording ? { scale: [1, 1.25, 1] } : { scale: 1 }}
            transition={recording ? { duration: 1.4, repeat: Infinity } : { duration: 0.2 }}
            className={`inline-flex h-2.5 w-2.5 rounded-full ${
              recording ? 'bg-red-500' : 'bg-muted-foreground/40'
            }`}
          />
          <span>{recording ? 'Listening — read it out loud' : 'Getting the mic ready…'}</span>
        </div>

        <div className="flex w-full items-center gap-3">
          <Mic className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <AudioLevelMeter level={level} label="Mic" className="flex-1" />
        </div>
        {/* Visually-hidden text equivalent of the level meter. */}
        <span className="sr-only" aria-live="polite">
          Microphone level: {levelWord(level)}
        </span>

        {/* Elapsed dots. */}
        <div className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: dotCount }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i < filled ? 'bg-foreground' : 'bg-muted-foreground/25'
              }`}
            />
          ))}
        </div>
        <span className="sr-only">
          {progressPct}% of the way through passage {index + 1}
        </span>
      </div>

      {retryReason && (
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 max-w-sm text-sm text-amber-600 dark:text-amber-400"
          aria-live="polite"
        >
          {retryReason}
        </motion.p>
      )}

      {/* Always-present Continue — enabled once thresholds are met. Auto-advance
          is layered on top; this button means there's never an audio-only dead
          end (keyboard/screen-reader users always have an explicit path). While
          finalizing the tail it disables and shows a brief spinner. */}
      <div className="mt-7 w-full max-w-sm">
        <Button
          onClick={onContinue}
          disabled={!canContinue || advancing}
          className="w-full"
          size="lg"
        >
          {advancing ? (
            <span className="inline-flex items-center gap-2" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Locking that in…
            </span>
          ) : canContinue ? (
            'Continue'
          ) : (
            `Keep reading… (${Math.min(elapsedSeconds, targetSeconds).toFixed(0)}s / ${Math.round(targetSeconds)}s)`
          )}
        </Button>
      </div>
    </div>
  )
}
