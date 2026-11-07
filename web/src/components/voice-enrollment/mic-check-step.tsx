'use client'

/**
 * Mic-check step — open the mic, sample the ambient noise floor, and confirm the
 * user's voice comes through before the passages start.
 *
 * On failure it branches on the full 6-way `WebAudioCaptureErrorKind` taxonomy
 * with specific copy + recovery per kind (permission-denied → how to re-allow;
 * no-device; in-use; insecure-context; unsupported; unknown → retry). A raw
 * DOMException string is never shown.
 *
 * Presentation + local gesture only: the wizard owns the recorder instance and
 * decides when to advance (speech detected). This step renders the live meter,
 * the "say hi" prompt, and the error surfaces.
 */

import { motion } from 'framer-motion'
import { Mic, MicOff, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AudioLevelMeter } from '@/components/desktop/audio-level-meter'
import type { WebAudioCaptureErrorKind } from '@/lib/web-audio-capture'

interface ErrorCopy {
  title: string
  body: string
  /** Whether a "Try again" retry button makes sense for this kind. */
  retry: boolean
}

/** Copy + recovery per classified mic failure. */
export function micErrorCopy(kind: WebAudioCaptureErrorKind): ErrorCopy {
  switch (kind) {
    case 'permission-denied':
      return {
        title: 'Microphone access is blocked',
        body:
          'You blocked mic access, so Dial8 can’t hear you. Click the camera/mic icon in your browser’s address bar and set the microphone to “Allow”, then try again.',
        retry: true,
      }
    case 'no-device':
      return {
        title: 'No microphone found',
        body:
          'We couldn’t find a microphone. Plug one in (or check it’s connected and enabled in your system settings), then try again.',
        retry: true,
      }
    case 'in-use':
      return {
        title: 'Your microphone is busy',
        body:
          'Another app is using your microphone. Close other calls or recording apps (Zoom, Meet, Voice Memos…) and try again.',
        retry: true,
      }
    case 'insecure-context':
      return {
        title: 'A secure connection is needed',
        body:
          'Microphone access needs a secure (HTTPS) connection. Open Dial8 at https://dial8.ai and try again.',
        retry: false,
      }
    case 'unsupported':
      return {
        title: 'This browser can’t record',
        body:
          'This browser doesn’t support microphone capture. Try a recent version of Chrome, Edge, or Safari.',
        retry: false,
      }
    case 'unknown':
    default:
      return {
        title: 'Something went wrong',
        body: 'We couldn’t start the microphone. Give it another try.',
        retry: true,
      }
  }
}

export function MicCheckStep({
  level,
  recording,
  speechDetected,
  error,
  onRetry,
}: {
  level: number
  recording: boolean
  speechDetected: boolean
  error: WebAudioCaptureErrorKind | null
  /** Re-open the mic (after an error or a manual retry). */
  onRetry: () => void
}) {
  if (error) {
    const copy = micErrorCopy(error)
    return (
      <div className="flex flex-col items-center text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', duration: 0.5 }}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10"
        >
          {error === 'permission-denied' || error === 'no-device' ? (
            <MicOff className="h-6 w-6 text-destructive" />
          ) : (
            <AlertTriangle className="h-6 w-6 text-destructive" />
          )}
        </motion.div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight" tabIndex={-1}>
          {copy.title}
        </h1>
        <p className="mt-2 max-w-sm text-muted-foreground" role="alert">
          {copy.body}
        </p>
        {copy.retry && (
          <Button onClick={onRetry} size="lg" className="mt-7">
            <RefreshCw className="mr-2 h-4 w-4" />
            Try again
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', duration: 0.5 }}
        className={`flex h-14 w-14 items-center justify-center rounded-full ${
          speechDetected ? 'bg-green-500/15' : 'bg-muted'
        }`}
      >
        <Mic
          className={`h-6 w-6 ${speechDetected ? 'text-green-500' : 'text-foreground'}`}
        />
      </motion.div>

      <h1 className="mt-6 text-2xl font-bold tracking-tight" tabIndex={-1}>
        Say hi to check your mic
      </h1>
      <p className="mt-2 max-w-sm text-muted-foreground">
        {recording
          ? 'Speak a few words — we just need to hear you clearly before we start.'
          : 'Getting your microphone ready…'}
      </p>

      <div className="mt-8 flex w-full max-w-sm items-center gap-3">
        <Mic className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <AudioLevelMeter level={level} label="Mic" className="flex-1" />
      </div>

      <div className="mt-4 h-6" aria-live="polite">
        {speechDetected && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-sm font-medium text-green-600 dark:text-green-400"
          >
            Got it — your mic sounds great.
          </motion.p>
        )}
      </div>
    </div>
  )
}
