'use client'

import { Mic, MicOff } from 'lucide-react'
import type { WebAudioCaptureErrorKind } from '@/lib/web-audio-capture'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Explains why a browser capture couldn't access the microphone, in place of a
 * raw red error string. The dominant case is `permission-denied` (the user
 * dismissed or has blocked the mic prompt); the copy walks them through
 * re-enabling it via the address-bar site controls, then offers "Try again".
 *
 * Driven by RecordingProvider: pass the WebAudioCaptureError `kind` (null hides
 * the dialog). `onRetry` re-runs the capture start; `onClose` just dismisses.
 */
export function MicPermissionDialog({
  kind,
  onClose,
  onRetry,
}: {
  kind: WebAudioCaptureErrorKind | null
  onClose: () => void
  onRetry: () => void
}) {
  const copy = kind ? COPY[kind] : null

  return (
    <AlertDialog open={kind != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
              {kind === 'permission-denied' ? (
                <MicOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Mic className="h-4 w-4 text-muted-foreground" />
              )}
            </span>
            {copy?.title}
          </AlertDialogTitle>
          <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
        </AlertDialogHeader>

        {copy?.steps && (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {copy.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Not now</AlertDialogCancel>
          {/* Retry only makes sense when the user can fix it in-place (grant
              permission, reconnect a mic, free it from another app). For an
              insecure context / unsupported browser there's nothing to retry. */}
          {copy?.canRetry && (
            <AlertDialogAction onClick={onRetry}>Try again</AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface DialogCopy {
  title: string
  body: string
  steps?: string[]
  canRetry: boolean
}

const COPY: Record<WebAudioCaptureErrorKind, DialogCopy> = {
  'permission-denied': {
    title: 'Microphone access needed',
    body: 'Dial8 needs permission to use your microphone to capture this meeting. Your browser has blocked it.',
    steps: [
      'Click the camera/lock icon in your browser’s address bar.',
      'Set Microphone to “Allow” for this site.',
      'Come back here and try again.',
    ],
    canRetry: true,
  },
  'no-device': {
    title: 'No microphone found',
    body: 'We couldn’t find a microphone to record from. Connect or enable a microphone, then try again.',
    canRetry: true,
  },
  'in-use': {
    title: 'Microphone is in use',
    body: 'Your microphone is being used by another app (for example a meeting client). Close it or release the mic, then try again.',
    canRetry: true,
  },
  'insecure-context': {
    title: 'Secure connection required',
    body: 'Microphone capture only works over a secure (HTTPS) connection. Open Dial8 over HTTPS to record.',
    canRetry: false,
  },
  unsupported: {
    title: 'Capture not supported here',
    body: 'This browser doesn’t support in-browser microphone capture. Try a recent version of Chrome or Edge — or download the desktop app for full meeting capture.',
    canRetry: false,
  },
  unknown: {
    title: 'Couldn’t start recording',
    body: 'Something went wrong starting the microphone. Please try again.',
    canRetry: true,
  },
}
