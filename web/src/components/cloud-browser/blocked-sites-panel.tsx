'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { normalizeBlockedSite } from '@/lib/browser-agent/blocked-sites'
import type { BlockedSitesState, BlockedSiteWrite } from './blocked-sites-store'

/**
 * The agent site-access panel: the agent may use any site except the ones
 * blocked here. Block or unblock the current site (when the caller knows it), type in one to block
 * without opening it, and see the whole list. The list is the user's, in every
 * workspace, kept on the server (blocked-sites-store.ts); the command relay
 * refuses any read or action on a blocked site.
 *
 * Rendered over the live view's screen (absolute, inside it), with a
 * click-away backdrop: the browser gets no click while it's open.
 */
export function BlockedSitesPanel({
  currentSite,
  currentBlockedBy,
  blocked,
  onBlock,
  onUnblock,
  onRetry,
  onClose,
}: {
  /** The site a Block on the current page would add (null: not a site). */
  currentSite: string | null
  /** The entry blocking the current page (it may be a parent domain of it). */
  currentBlockedBy: string | null
  blocked: BlockedSitesState
  onBlock: (site: string) => Promise<BlockedSiteWrite>
  onUnblock: (site: string) => Promise<BlockedSiteWrite>
  onRetry: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (write: () => Promise<BlockedSiteWrite>, after?: () => void) => {
    setBusy(true)
    setError(null)
    const result = await write()
    setBusy(false)
    if (result.ok) after?.()
    else setError(result.error)
  }

  const addTyped = () => {
    const site = normalizeBlockedSite(draft)
    if (!site) {
      setError('Enter a site like linkedin.com')
      return
    }
    void run(() => onBlock(site), () => setDraft(''))
  }

  const sites = blocked.sites

  return (
    <div
      className="absolute inset-0 z-50 bg-background/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-label="Agent site access"
        className="absolute right-3 top-12 w-80 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium">Agent site access</p>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          The agent can read and act on any site except the ones you block. A blocked site and its subdomains are
          off-limits in all your workspaces. Sensitive actions still ask you first.
        </p>

        {currentSite || currentBlockedBy ? (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs" title={currentBlockedBy ?? currentSite ?? undefined}>
                {currentBlockedBy ?? currentSite}
              </p>
              <p className={currentBlockedBy ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'}>
                {currentBlockedBy ? 'Agent blocked here' : 'Agent can use this site'}
              </p>
            </div>
            {currentBlockedBy ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => onUnblock(currentBlockedBy))}
                className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
              >
                Unblock
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !currentSite}
                onClick={() => currentSite && void run(() => onBlock(currentSite))}
                className="shrink-0 rounded-full bg-destructive px-2.5 py-1 text-[11px] font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                Block agent here
              </button>
            )}
          </div>
        ) : null}

        <form
          className="mb-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addTyped()
          }}
        >
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            placeholder="Block another site, e.g. linkedin.com"
            aria-label="Site to block"
            autoComplete="off"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-ring"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            Block
          </button>
        </form>
        {error && (
          <p role="alert" className="-mt-2 mb-2 text-[11px] text-destructive">
            {error}
          </p>
        )}

        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          Blocked sites{blocked.status === 'ready' ? ` (${sites.length})` : ''}
        </p>
        {blocked.status === 'error' && sites.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">
            <p>Couldn’t load your blocked sites. The agent won’t use the browser until they load.</p>
            <button type="button" onClick={onRetry} className="mt-1 underline hover:text-foreground">
              Try again
            </button>
          </div>
        ) : blocked.status === 'loading' && sites.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : sites.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">None. The agent can use every site.</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-auto">
            {sites.map((site) => (
              <li key={site} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50">
                <span className="truncate text-[11px]" title={site}>
                  {site}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => onUnblock(site))}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20 disabled:opacity-50"
                  aria-label={`Unblock ${site}`}
                  title="Unblock"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
