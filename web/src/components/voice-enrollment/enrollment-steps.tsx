'use client'

/**
 * The static wizard steps around the recording ones: intro, processing, done.
 * Presentation only — the flow owns the embedder, model-load gate, POST, and
 * celebrate(). Grammar follows the onboarding PrimeStep: spring-pop icon →
 * staggered headline (`text-3xl font-bold tracking-tight`) → muted subtext →
 * full-width lg CTA.
 */

import { motion } from 'framer-motion'
import { AudioWaveform, Check, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

// ─── Intro ───────────────────────────────────────────────────

export function IntroStep({
  /** True until the private worker acks 'loaded' — gates the CTA honestly. */
  modelReady,
  /** Non-null when the model failed to load — offer a retry. */
  loadError,
  onStart,
  onRetryLoad,
}: {
  modelReady: boolean
  loadError: boolean
  onStart: () => void
  onRetryLoad: () => void
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', duration: 0.6 }}
        className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted"
      >
        <AudioWaveform className="h-8 w-8 text-foreground" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-6 text-3xl font-bold tracking-tight"
        tabIndex={-1}
      >
        Teach Dial8 your voice
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-3 max-w-sm text-muted-foreground"
      >
        Read a 60-second story out loud. Dial8 learns what you sound like, so it
        always knows which voice in a meeting is yours.
      </motion.p>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="mt-4 max-w-sm text-sm text-muted-foreground/80"
      >
        Your voiceprint is private to your account — teammates can never see or
        hear it.
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.55 }}
        className="mt-8 w-full max-w-sm"
      >
        {loadError ? (
          <>
            <Button onClick={onRetryLoad} className="w-full" size="lg" variant="outline">
              <Loader2 className="mr-2 h-4 w-4" />
              Couldn’t get ready — try again
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              We couldn’t download the voice model. Check your connection and retry.
            </p>
          </>
        ) : (
          <>
            <Button
              onClick={onStart}
              disabled={!modelReady}
              className="w-full"
              size="lg"
            >
              {modelReady ? (
                <>
                  Let’s do it
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              ) : (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Getting ready…
                </>
              )}
            </Button>
            {!modelReady && (
              <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
                Warming up the voice model — this only takes a moment the first time.
              </p>
            )}
          </>
        )}
      </motion.div>
    </div>
  )
}

// ─── Processing ──────────────────────────────────────────────

/**
 * Indeterminate "learning your voice" sweep while remaining chunks embed and the
 * consistency check runs. Uses the existing `shimmer` keyframe on a gradient bar
 * (respects reduced motion via the static gradient underneath).
 */
export function ProcessingStep() {
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-muted"
      >
        <AudioWaveform className="h-6 w-6 text-foreground" />
      </motion.div>

      <h1 className="mt-6 text-2xl font-bold tracking-tight" tabIndex={-1}>
        Learning your voice
      </h1>
      <p className="mt-2 max-w-sm text-muted-foreground" aria-live="polite">
        Building your private voiceprint from what you just read. One moment…
      </p>

      {/* Shimmer sweep — the existing keyframe animates a gradient across a
          fixed-width bar. */}
      <div className="mt-8 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted">
        <div
          className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-foreground/60 to-transparent"
          style={{ animation: 'indeterminate 1.4s infinite ease-in-out' }}
        />
      </div>
    </div>
  )
}

// ─── Done ────────────────────────────────────────────────────

export function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', duration: 0.6 }}
        className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/15"
      >
        <Check className="h-8 w-8 text-green-500" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-6 text-3xl font-bold tracking-tight"
        tabIndex={-1}
      >
        Dial8 knows your voice now
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mt-3 max-w-sm text-muted-foreground"
      >
        From now on, whenever you’re in a meeting, Dial8 will know which voice is
        yours — everywhere you use Dial8.
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="mt-8 w-full max-w-sm"
      >
        <Button onClick={onFinish} className="w-full" size="lg">
          Back to Dial8
        </Button>
      </motion.div>
    </div>
  )
}
