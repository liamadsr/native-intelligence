'use client'

/**
 * Starting an audit: the one start path (useStartAudit), the inline form the
 * first-run screen carries, and the dialog "New audit" opens once there are
 * audits (prospecting/find-dialog.tsx's look).
 *
 *   An address the server can't use (NO_SITE, INVALID_URL, NOT_PUBLIC) is
 *   said beside the field, never in a toast: the person corrects it there.
 *   A start while one runs (409 AUDIT_ALREADY_RUNNING) opens that audit.
 *   Anything else is a toast, and the form keeps what was typed.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SiteAuditView } from '@/lib/seo/audit/view'
import { START_FIELD_CODES, errorCode, errorMessage, runningAuditOf, startAudit, type AuditLimits } from './api'
import { PAGE_PRESETS } from './ui-helpers'

/** The one start path: POST, then the audit it made (or the one already running). */
export function useStartAudit({ onStarted, onRunning }: { onStarted: (audit: SiteAuditView) => void; onRunning: (audit: SiteAuditView) => void }) {
  const [busy, setBusy] = React.useState(false)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const start = React.useCallback(
    async (url: string, maxPages?: number) => {
      setBusy(true)
      setFieldError(null)
      try {
        const audit = await startAudit({ url: url.trim() || null, maxPages })
        onStarted(audit)
        return true
      } catch (err) {
        const running = runningAuditOf(err)
        if (running) {
          onRunning(running)
          return true
        }
        if (START_FIELD_CODES.has(errorCode(err) ?? '')) setFieldError(errorMessage(err))
        else toast.error('Could not start the audit', { description: errorMessage(err, 'Try again in a moment.') })
        return false
      } finally {
        setBusy(false)
      }
    },
    [onStarted, onRunning],
  )
  return { start, busy, fieldError, clearError: () => setFieldError(null) }
}

/** The address field: its label, the input, and the error beside it. */
function AddressField({
  id,
  value,
  onChange,
  onEnter,
  error,
  autoFocus,
  trailing,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  onEnter: () => void
  error: string | null
  autoFocus?: boolean
  trailing?: React.ReactNode
}) {
  return (
    <div className="w-full space-y-1.5">
      <label htmlFor={id} className="block text-left text-xs text-muted-foreground">
        Website address
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-seo-start-url=""
          autoFocus={autoFocus}
          value={value}
          placeholder="example.com"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnter()
            }
          }}
          className="h-8 text-sm"
        />
        {trailing}
      </div>
      {error && (
        <p data-seo-start-error="" className="text-left text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The first-run screen's form: the address (prefilled with the workspace's site) and Start audit. */
export function InlineStartForm({
  defaultUrl,
  limits,
  onStarted,
  onRunning,
}: {
  defaultUrl: string | null
  limits: AuditLimits
  onStarted: (audit: SiteAuditView) => void
  onRunning: (audit: SiteAuditView) => void
}) {
  const [url, setUrl] = React.useState(defaultUrl ?? '')
  const { start, busy, fieldError, clearError } = useStartAudit({ onStarted, onRunning })
  const submit = () => {
    if (busy || !url.trim()) return
    void start(url, limits.default_pages)
  }
  return (
    <AddressField
      id="seo-start-url-inline"
      value={url}
      onChange={(next) => {
        setUrl(next)
        if (fieldError) clearError()
      }}
      onEnter={submit}
      error={fieldError}
      trailing={
        <Button size="sm" data-seo-start="" className="h-8 shrink-0" onClick={submit} disabled={busy || !url.trim()}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Start audit
        </Button>
      }
    />
  )
}

/** The presets this workspace's bounds allow, the default among them. */
export function pagePresets(limits: AuditLimits): number[] {
  const within = PAGE_PRESETS.filter((n) => n >= limits.min_pages && n <= limits.max_pages)
  return within.includes(limits.default_pages) ? within : [...within, limits.default_pages].sort((a, b) => a - b)
}

/** "New audit": the address and how many pages to check. */
export function StartAuditDialog({
  open,
  defaultUrl,
  defaultPages,
  limits,
  onClose,
  onStarted,
  onRunning,
}: {
  open: boolean
  defaultUrl: string | null
  /** The page budget to start on (a "Run again" keeps the last one's). */
  defaultPages?: number
  limits: AuditLimits
  onClose: () => void
  onStarted: (audit: SiteAuditView) => void
  onRunning: (audit: SiteAuditView) => void
}) {
  const presets = pagePresets(limits)
  const initialPages = defaultPages !== undefined && presets.includes(defaultPages) ? defaultPages : limits.default_pages
  const [url, setUrl] = React.useState(defaultUrl ?? '')
  const [pages, setPages] = React.useState(initialPages)
  const done = React.useCallback(
    (fn: (audit: SiteAuditView) => void) => (audit: SiteAuditView) => {
      onClose()
      fn(audit)
    },
    [onClose],
  )
  const { start, busy, fieldError, clearError } = useStartAudit({
    onStarted: React.useMemo(() => done(onStarted), [done, onStarted]),
    onRunning: React.useMemo(() => done(onRunning), [done, onRunning]),
  })
  // Each opening starts from the defaults it was given.
  React.useEffect(() => {
    if (!open) return
    setUrl(defaultUrl ?? '')
    setPages(initialPages)
    clearError()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open])

  const submit = () => {
    if (busy || !url.trim()) return
    void start(url, pages)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent aria-label="New audit" data-seo-start-dialog="" className="w-[min(30rem,calc(100vw-2rem))] max-w-[30rem] gap-0 rounded-lg border-border p-4">
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm font-semibold">New audit</DialogTitle>
          <DialogDescription className="mt-1 text-xs leading-relaxed">
            Reads the site the way a search engine does and lists what to fix. It takes a few minutes and costs nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4">
          <AddressField
            id="seo-start-url-dialog"
            autoFocus
            value={url}
            onChange={(next) => {
              setUrl(next)
              if (fieldError) clearError()
            }}
            onEnter={submit}
            error={fieldError}
          />
        </div>

        <div className="mt-4 space-y-1.5">
          <p id="seo-start-pages" className="text-xs text-muted-foreground">
            Pages to check
          </p>
          <div role="radiogroup" aria-labelledby="seo-start-pages" className="flex flex-wrap items-center gap-1">
            {presets.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={pages === n}
                data-seo-pages={n}
                onClick={() => setPages(n)}
                className={cn(
                  'h-7 rounded-lg px-2.5 text-xs tabular-nums transition-colors',
                  pages === n ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {n.toLocaleString()}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">About a second per page.</p>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" data-seo-start="" disabled={busy || !url.trim()} onClick={submit}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Start audit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
