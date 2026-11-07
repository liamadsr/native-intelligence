'use client'

/**
 * Settings → Recording → Permissions (desktop shell): one live row per macOS
 * permission a meeting capture needs. Microphone records your side; System
 * Audio Recording captures everyone else — without it a meeting silently
 * records mic-only.
 *
 * Every pill comes from a PASSIVE check (useAudioPermissions), re-read every
 * 1.5s while the page is visible and again on focus: after a denial the only
 * fix is a toggle in System Settings, so a row must flip to Granted on its own
 * when the user comes back — no "check again" click. Buttons appear only where
 * a click moves things forward: Allow (not-determined → the real OS prompt)
 * and Open System Settings (denied → macOS never re-prompts, so the request
 * command opens the right pane instead).
 *
 * A desktop build that predates the checks gets an honest "Can't verify" —
 * never a guessed "Granted" (the old single "Request" button showed Granted
 * whenever the legacy probe said so, and on those builds it always did).
 *
 * Windows has no system-audio permission (the check says "not_applicable"),
 * so that row isn't there; its microphone is never prompted for, only turned
 * on in Settings, which the request command opens.
 */

import { useCallback, useState, type ComponentType, type ReactNode } from 'react'
import { Check, Loader2, Mic, Volume2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useDesktopOS } from '@/components/desktop-titlebar'
import {
  useAudioPermissions,
  type MicPermissionState,
  type SystemAudioPermissionState,
} from '@/hooks/use-audio-permissions'
import { trackRecordingEvent } from '@/lib/recording-telemetry'
import { cn } from '@/lib/utils'

const MIC_DENIED_HELP =
  'Turn on Dial8 under System Settings → Privacy & Security → Microphone. This page updates automatically.'
const MIC_DENIED_HELP_WINDOWS =
  'Turn on Microphone access and “Let desktop apps access your microphone” under Settings → Privacy & security → Microphone. This page updates automatically.'
const SYSTEM_DENIED_HELP =
  'Turn on Dial8 under System Settings → Privacy & Security → Screen & System Audio Recording. This page updates automatically.'
const UNKNOWN_HELP = "Update Dial8 to see this permission's status."

export function AudioPermissionsPanel() {
  const { mic, system, micBusy, systemBusy, requestMic, requestSystem } = useAudioPermissions()
  const windows = useDesktopOS() === 'windows'
  // Set once a system request has run. Read only while the row is 'unknown':
  // an old build's legacy probe can't report a verifiable result, so without a
  // note its Request click would look like it did nothing at all.
  const [systemRequested, setSystemRequested] = useState(false)

  const handleMicRequest = useCallback(() => {
    void requestMic()
  }, [requestMic])

  const handleSystemRequest = useCallback(async () => {
    const result = await requestSystem()
    if (result === 'busy') return // a request was already in flight; it reports itself
    trackRecordingEvent('system_audio_permission_requested', { source: 'settings', result })
    setSystemRequested(true)
  }, [requestSystem])

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <PermissionRow
        testId="permission-row-microphone"
        icon={Mic}
        title="Microphone"
        description="Needed to record your side of a meeting."
        state={mic}
        busy={micBusy}
        onRequest={handleMicRequest}
        deniedHelp={windows ? MIC_DENIED_HELP_WINDOWS : MIC_DENIED_HELP}
        settingsLabel={windows ? 'Open Settings' : 'Open System Settings'}
      />
      {/* No system-audio permission on Windows: nothing to show. */}
      {!windows && (
        <>
          <Separator />
          <PermissionRow
            testId="permission-row-system-audio"
            icon={Volume2}
            title="System Audio Recording"
            description="Needed to capture the other participants (audio from Zoom, Meet, Teams, browsers)."
            state={system}
            busy={systemBusy}
            onRequest={handleSystemRequest}
            deniedHelp={SYSTEM_DENIED_HELP}
            // Old builds keep their one-click probe (it still raises the OS prompt
            // the first time, and opens Settings when it does detect a denial) —
            // just without the unverifiable "Granted".
            requestWhileUnknown
            requestedWhileUnknown={systemRequested}
          />
        </>
      )}
    </div>
  )
}

// ─── One permission row ────────────────────────────────────────

type RowState = MicPermissionState | SystemAudioPermissionState
type PillTone = 'muted' | 'neutral' | 'success' | 'danger' | 'warning'

const PILL_TONES: Record<PillTone, string> = {
  muted: 'text-muted-foreground',
  neutral: 'text-foreground',
  success: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  danger: 'border-red-600/30 bg-red-500/10 text-red-700 dark:text-red-400',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
}

interface RowView {
  pill: ReactNode
  action: { label: string; variant: 'default' | 'outline' } | null
  help: string | null
}

function rowView(
  state: RowState,
  opts: { deniedHelp: string; settingsLabel: string; requestWhileUnknown: boolean; requestedWhileUnknown: boolean },
): RowView {
  switch (state) {
    case 'checking':
      return { pill: <StatusPill tone="muted">Checking…</StatusPill>, action: null, help: null }
    case 'granted':
      return {
        pill: (
          <StatusPill tone="success">
            <Check className="h-3 w-3" />
            Granted
          </StatusPill>
        ),
        action: null,
        help: null,
      }
    case 'not-determined':
      // Allow runs the request command, which shows the real OS prompt.
      return {
        pill: <StatusPill tone="neutral">Not granted</StatusPill>,
        action: { label: 'Allow', variant: 'default' },
        help: null,
      }
    case 'denied':
      // Same request command: once denied it can't prompt, so it opens the
      // right Settings pane. The poll then picks up the toggle.
      return {
        pill: <StatusPill tone="danger">Denied</StatusPill>,
        action: { label: opts.settingsLabel, variant: 'default' },
        help: opts.deniedHelp,
      }
    case 'unsupported':
      return {
        pill: <StatusPill tone="muted">Unavailable on this macOS</StatusPill>,
        action: null,
        help: 'Needs macOS 14.4 or later.',
      }
    case 'unknown':
      return {
        pill: <StatusPill tone="warning">{"Can't verify"}</StatusPill>,
        action: opts.requestWhileUnknown ? { label: 'Request', variant: 'outline' } : null,
        help: opts.requestedWhileUnknown
          ? `Request sent — this version of Dial8 can't confirm the result. ${UNKNOWN_HELP}`
          : UNKNOWN_HELP,
      }
  }
}

function PermissionRow({
  testId,
  icon: Icon,
  title,
  description,
  state,
  busy,
  onRequest,
  deniedHelp,
  settingsLabel = 'Open System Settings',
  requestWhileUnknown = false,
  requestedWhileUnknown = false,
}: {
  testId: string
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  state: RowState
  busy: boolean
  onRequest: () => void
  deniedHelp: string
  /** The denied row's button, which opens the OS settings. */
  settingsLabel?: string
  /** Offer a "Request" button while the status can't be verified. */
  requestWhileUnknown?: boolean
  /** A request already ran while unverifiable — say so in the helper. */
  requestedWhileUnknown?: boolean
}) {
  const { pill, action, help } = rowView(state, {
    deniedHelp,
    settingsLabel,
    requestWhileUnknown,
    requestedWhileUnknown,
  })

  return (
    <div data-testid={testId} data-state={state} className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-xs font-medium">{title}</p>
          <p className="text-[10px] text-muted-foreground">{description}</p>
          {help && <p className="mt-1 text-[10px] text-foreground/80">{help}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pill}
        {action && (
          <Button size="sm" variant={action.variant} disabled={busy} onClick={onRequest}>
            {busy && <Loader2 className="animate-spin" />}
            {action.label}
          </Button>
        )}
      </div>
    </div>
  )
}

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      // Polite live region: the status changes on its own (a toggle flipped in
      // System Settings), so announce it rather than leave it silent.
      aria-live="polite"
      className={cn('gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', PILL_TONES[tone])}
    >
      {children}
    </Badge>
  )
}
