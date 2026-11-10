'use client'

import { useState } from 'react'
import { MicOff } from 'lucide-react'
import type { SystemAudioStatus } from '@/lib/tauri-bridge'
import { requestSystemAudioWithFallback } from '@/hooks/use-audio-permissions'
import { trackRecordingEvent } from '@/lib/recording-telemetry'
import { hasDownload } from '@/lib/app-download'
import { cn } from '@/lib/utils'
import { useDesktopOS } from '@/components/desktop-titlebar'
import { APP_IN_SYSTEM_SETTINGS } from '@/lib/desktop-app-name'

/** What the last grant click came back with. `legacy` = the answer came from
 *  the old tap probe (a desktop build without request_system_audio_permission),
 *  which can't observe a denial there — so its "granted" is never echoed back
 *  as a grant. */
type GrantOutcome = { result: string; legacy: boolean }

/** The follow-up line after a grant click. macOS applies a new grant only to
 *  NEW capture sessions, so every path ends in "stop and restart" — the live
 *  stream can't be switched on mid-recording. */
function grantMessage({ result, legacy }: GrantOutcome): string {
  if (result === 'denied') {
    return 'Permission was denied. Turn it on under System Settings → Privacy & Security → Screen & System Audio Recording, then stop and restart the capture.'
  }
  if (!legacy && result === 'granted') {
    return 'Permission granted. Stop and restart the capture to include system audio.'
  }
  if (result === 'opened-settings') {
    return `System Settings opened — turn on ${APP_IN_SYSTEM_SETTINGS} under Screen & System Audio Recording, then stop and restart the capture.`
  }
  if (!legacy && result === 'unsupported') {
    return 'System audio capture needs macOS 14.4 or later.'
  }
  // The legacy probe's answers (and anything unrecognised): the old,
  // non-committal copy — true whatever the permission really is.
  return 'Permission requested. Stop and restart the capture to include system audio.'
}

/**
 * Whether the desktop system-audio stream has gone wrong in a way the user must
 * hear about — the amber warning below, as opposed to a healthy stream or one
 * switched off on purpose. (Web is mic-only by design; it gets a steady notice,
 * never this.) Lets a caller flag the warning somewhere smaller than itself.
 */
export function systemAudioNeedsAttention(status: SystemAudioStatus | null): boolean {
  return !(status == null || status === 'capturing' || status === 'disabled')
}

/**
 * Inline warning shown during a live capture when the system-audio stream
 * isn't actually being captured even though the user asked for it. Without
 * this, a meeting silently records mic-only — you only hear yourself, not the
 * other participants — and the user has no idea until they read the transcript.
 *
 * Desktop: renders nothing when system audio is capturing normally or was
 * intentionally disabled (mic-only). For the permission case it offers a
 * one-click grant that opens the macOS prompt / System Settings.
 *
 * Web (`platform="web"`): the browser has no system-audio tap at all, so every
 * web capture is mic-only by definition. We always show a steady (non-alarming)
 * notice that explains this and links to the desktop app for full meeting
 * capture — the download funnel. On web `status` is always 'disabled'.
 */
export function SystemAudioWarning({
  status,
  className,
  platform = 'desktop',
}: {
  status: SystemAudioStatus | null
  className?: string
  platform?: 'desktop' | 'web'
}) {
  const [requesting, setRequesting] = useState(false)
  const [outcome, setOutcome] = useState<GrantOutcome | null>(null)
  // Windows has no system-audio permission: nothing there to grant.
  const windows = useDesktopOS() === 'windows'

  // Web is mic-only by design — show a steady, informative notice (not an
  // amber warning) that points to the desktop app for full capture.
  if (platform === 'web') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground',
          className,
        )}
        role="status"
      >
        <MicOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1 leading-snug">
          Recording your mic only.
          {hasDownload() && (
            <>
              {' '}
              To capture the other side of meetings (system audio),{' '}
              <a
                href="/api/download"
                className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
              >
                download the desktop app
              </a>
              .
            </>
          )}
        </div>
      </div>
    )
  }

  // Healthy or intentional states — nothing to warn about.
  if (!systemAudioNeedsAttention(status)) {
    return null
  }

  const isPermission = status === 'permissionDenied' && !windows

  const message = isPermission
    ? "Recording your mic only — system audio needs permission, so other participants won't be captured."
    : status === 'unavailable'
      ? "Recording your mic only — system audio capture is unavailable on this build, so other participants won't be captured."
      : "Recording your mic only — system audio failed to start, so other participants won't be captured."

  const handleGrant = async () => {
    if (requesting) return
    setRequesting(true)
    try {
      // not-determined → the real OS prompt; already denied → macOS never
      // re-prompts, so the command opens the Screen & System Audio Recording
      // pane ('opened-settings'). Old builds fall back to the legacy probe.
      const next = await requestSystemAudioWithFallback()
      trackRecordingEvent('system_audio_permission_requested', {
        source: 'live_warning',
        result: next.result,
      })
      setOutcome(next)
    } catch {
      // Both commands rejected — nothing opened; leave the button to retry.
      trackRecordingEvent('system_audio_permission_requested', {
        source: 'live_warning',
        result: 'error',
      })
    } finally {
      setRequesting(false)
    }
  }

  // The button shows until a click lands, and again after a denial — then as
  // "Open System Settings", since the next request can only open the pane.
  const showGrantButton = outcome === null || outcome.result === 'denied'

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300',
        className,
      )}
      role="status"
    >
      <MicOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="leading-snug">{message}</p>
        {isPermission && (
          <>
            {outcome && (
              <p className="leading-snug text-amber-700/80 dark:text-amber-300/80">
                {grantMessage(outcome)}
              </p>
            )}
            {showGrantButton && (
              <button
                onClick={handleGrant}
                disabled={requesting}
                className="font-medium underline underline-offset-2 hover:no-underline disabled:opacity-60"
              >
                {requesting
                  ? 'Opening…'
                  : outcome?.result === 'denied'
                    ? 'Open System Settings'
                    : 'Grant permission'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
