'use client'

/**
 * One settings row for a desktop local module (an on-device sidecar the
 * desktop downloads and runs — `local-stt` today, `local-tts` later). Pure
 * presentation over useLocalModule(): the caller owns the hook so it can also
 * decide whether to render the surrounding section at all.
 *
 * Lifecycle it renders (docs/plans/local-modules.md §1.8): Waiting →
 * Downloading x% → Verifying → Setting up → Ready. The model is not a
 * choice: it downloads on its own (local-modules-keeper.ts) and is used as
 * soon as it is ready (Liam, 2026-10-08). So the row has no switch. It is
 * where a user checks on the model, and where they fix it when it fails:
 * the error in plain words, and Try again.
 */

import type { ReactNode } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { LocalModuleHandle } from '@/hooks/use-local-module'
import { describeModuleError, formatDownloadSize } from '@/lib/local-modules'
import { retryClass } from '@/lib/local-modules-keeper'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'

export interface LocalModuleRowProps {
  module: LocalModuleHandle
  title: string
  /** Small tag after the title, e.g. "Beta". */
  badge?: string
  /** What the module does. The row appends the download size while it
   *  waits to download. */
  description: string
  /** Secondary guidance, e.g. a hardware recommendation. */
  hint?: string
  /** What the app does meanwhile, shown while the module downloads and sets
   *  up, e.g. "Until it's ready, meetings are transcribed in the cloud." */
  pendingNote?: string
  /** Credit line for what the module runs (e.g. its models and their
   *  licenses), shown last in muted small text. Use LocalModuleLink for links. */
  attribution?: ReactNode
  testId?: string
}

type PillTone = 'muted' | 'success' | 'danger'

const PILL_TONES: Record<PillTone, string> = {
  muted: 'text-muted-foreground',
  success: 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  danger: 'border-red-600/30 bg-red-500/10 text-red-700 dark:text-red-400',
}

export function LocalModuleRow({
  module,
  title,
  badge,
  description,
  hint,
  pendingNote,
  attribution,
  testId,
}: LocalModuleRowProps) {
  const { info, state, enabled, busy, error } = module
  if (!module.supported || !info) return null

  const size = formatDownloadSize(info.downloadBytes)
  const fraction = Math.min(1, Math.max(0, module.progress ?? 0))
  const percent = Math.round(fraction * 100)
  const inFlight = state === 'downloading' || state === 'verifying' || state === 'warming'
  // The desktop verifies each file as it lands, so a module of several files
  // goes downloading → verifying → downloading… One download to the eye
  // until the last file is in.
  const downloading =
    state === 'downloading' || (state === 'verifying' && module.progress !== null && module.progress < 1)
  // Off only until the keeper turns it on (transcription waits for
  // read-aloud's download to finish first).
  const waiting = !enabled && state !== 'unavailable'

  let pill: ReactNode = null
  if (waiting) {
    pill = <StatusPill tone="muted">Waiting to download</StatusPill>
  } else if (downloading) {
    pill = <StatusPill tone="muted"><Loader2 className="h-3 w-3 animate-spin" />Downloading {percent}%</StatusPill>
  } else {
    switch (state) {
      case 'verifying':
        pill = <StatusPill tone="muted"><Loader2 className="h-3 w-3 animate-spin" />Verifying…</StatusPill>
        break
      case 'warming':
        pill = <StatusPill tone="muted"><Loader2 className="h-3 w-3 animate-spin" />Setting up…</StatusPill>
        break
      case 'ready':
        pill = <StatusPill tone="success"><Check className="h-3 w-3" />Ready</StatusPill>
        break
      case 'error':
        pill = <StatusPill tone="danger"><AlertCircle className="h-3 w-3" />Didn’t finish</StatusPill>
        break
      case 'unavailable':
        pill = <StatusPill tone="muted">Not in this version</StatusPill>
        break
    }
  }
  // Bytes so far, for the bar ("310 MB of 807 MB").
  const doneBytes = formatDownloadSize(fraction * info.downloadBytes)?.replace('~', '')
  const totalBytes = size?.replace('~', '')
  // The module's own error (the keeper retries those) or a failed command's.
  const ownError = state === 'error' && error === info.error

  return (
    <div data-testid={testId} data-state={state ?? undefined} className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium">{title}</Label>
            {badge && (
              <Badge variant="outline" className="rounded-full px-1.5 py-0 text-[10px] font-medium">
                {badge}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {description}
            {waiting && !info.assetsPresent && size && ` Downloads automatically (${size}).`}
          </p>
          {pendingNote && (waiting || inFlight) && (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80" data-local-module-pending="">
              {pendingNote}
            </p>
          )}
          {hint && <p className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>}
          {attribution && <p className="mt-1 text-[11px] text-muted-foreground">{attribution}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">{pill}</div>
      </div>

      {downloading && (
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={`${title} download`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          {doneBytes && totalBytes && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {doneBytes} of {totalBytes}
            </span>
          )}
        </div>
      )}

      {/* The module's error, or a failed command's (state unchanged) message,
          in plain words; the desktop's own wording stays on hover. */}
      {error && (state === 'error' || error !== info.error) && (
        <p className="text-[11px] text-red-700 dark:text-red-400" title={error}>
          {describeModuleError(error)}
          {ownError && retryClass(error) !== 'never' && (
            <span className="text-muted-foreground"> Dial8 also keeps trying in the background.</span>
          )}
        </p>
      )}

      {state === 'error' && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => { void module.enable() }}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * An external link in a row's attribution. The row only renders in the
 * desktop app, whose WKWebView swallows target="_blank", so the click goes
 * through openExternalUrl (the OS browser); the href keeps it a real link.
 */
export function LocalModuleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm underline underline-offset-2 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:decoration-2"
      onClick={(e) => {
        e.preventDefault()
        void openExternalUrl(href)
      }}
    >
      {children}
    </a>
  )
}

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      // Polite live region: the status moves on its own (download → ready).
      aria-live="polite"
      className={cn('gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', PILL_TONES[tone])}
    >
      {children}
    </Badge>
  )
}
