'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ExternalLink, Loader2, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { WebsiteRepoView, WebsiteView } from '@/lib/website/view'
import { PickerLoadError, SearchableOptionList } from './destination-picker-slots'

/**
 * "Website" on the GitHub connector's page (roadmap track E,
 * docs/plans/website-by-text.md): pick which of your repositories is your
 * business's website, see what Native Intelligence found in it, and connect its form so
 * customers' requests reach you. The same flow the agent runs by text: the
 * pull request it opens goes live only on your yes (the card in your chat, or
 * yes with the code from the text).
 */

/** A repo typed in full (owner/name): picked even when it isn't among the listed ones. */
const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/** How often the section re-reads a change in flight (it also re-reads on focus). */
const OPEN_CHANGE_POLL_MS = 30_000

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error || 'That didn’t work. Try again in a moment.')
  return body as T
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

export function WebsiteSection() {
  const [view, setView] = useState<WebsiteView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [repos, setRepos] = useState<WebsiteRepoView[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<null | 'connect' | 'wire' | 'address'>(null)
  const [connectingRepo, setConnectingRepo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingAddress, setEditingAddress] = useState(false)
  const [address, setAddress] = useState('')
  // Each read or write takes a number: a read that answers after a newer one (a poll landing mid-save) is dropped.
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const next = await call<WebsiteView>('/api/account/website')
      if (mine !== seq.current) return
      setView(next)
      setLoadError(null)
    } catch (err) {
      if (mine === seq.current) setLoadError(err instanceof Error ? err.message : 'Could not load your website.')
    }
  }, [])

  const loadRepos = useCallback(async () => {
    setReposError(null)
    try {
      setRepos((await call<{ repos: WebsiteRepoView[] }>('/api/account/website/repos')).repos)
    } catch (err) {
      setReposError(err instanceof Error ? err.message : 'Could not list your repositories.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // The picker shows with no site yet (to whoever may connect one), or when they ask to change it: its list loads once.
  const showPicker = !!view && ((!view.site && view.canConnect) || picking)
  useEffect(() => {
    if (showPicker && repos === null && !reposError) void loadRepos()
  }, [showPicker, repos, reposError, loadRepos])

  // A change in flight moves on its own (the run, their yes, the deploy): re-read it now and then, and on focus.
  const changeOpen = !!view?.change?.open
  useEffect(() => {
    if (!changeOpen) return
    const onFocus = () => void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, OPEN_CHANGE_POLL_MS)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [changeOpen, load])

  async function connect(repo: string, siteUrl?: string) {
    if (busy) return
    // The repo it already is: nothing to do (re-reading it would only cost a GitHub round trip).
    if (siteUrl === undefined && view?.site?.repo.toLowerCase() === repo.toLowerCase()) {
      setPicking(false)
      setQuery('')
      return
    }
    const mine = ++seq.current
    setBusy(siteUrl === undefined ? 'connect' : 'address')
    setConnectingRepo(repo)
    setError(null)
    try {
      const next = await call<WebsiteView>('/api/account/website', post(siteUrl === undefined ? { repo } : { repo, site_url: siteUrl }))
      if (mine === seq.current) setView(next)
      setPicking(false)
      setEditingAddress(false)
      setQuery('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work.')
    } finally {
      setBusy(null)
      setConnectingRepo(null)
    }
  }

  async function wire() {
    if (busy) return
    setBusy('wire')
    setError(null)
    try {
      await call('/api/account/website/wire', post())
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work.')
    } finally {
      setBusy(null)
    }
  }

  if (!view && !loadError) {
    return (
      <Section>
        <div className="rounded-lg border border-border px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-64" />
        </div>
      </Section>
    )
  }
  if (!view) {
    return (
      <Section>
        <PickerLoadError message={loadError ?? 'Could not load your website.'} onRetry={() => void load()} />
      </Section>
    )
  }

  const { site, change } = view
  const needle = query.trim().toLowerCase()
  const options = (repos ?? []).filter((r) => !needle || r.fullName.toLowerCase().includes(needle)).map((r) => ({ id: r.fullName, name: r.fullName }))
  // Past the listed ones (GitHub lists the newest few hundred): a repo typed in full.
  if (repos && REPO_NAME.test(query.trim()) && !options.some((o) => o.id.toLowerCase() === needle)) options.push({ id: query.trim(), name: `Use ${query.trim()}` })

  const picker = (
    <div className={site ? 'mt-3 border-t border-border pt-3' : ''}>
      <p className="text-sm font-medium">{site ? 'Pick another repository' : 'Which repository is your website?'}</p>
      {!site && (
        <p className="mt-1 text-xs text-muted-foreground">
          Native Intelligence reads it, finds the form customers fill in, and can connect it so their requests reach you. Nothing on your site changes without your yes.
        </p>
      )}
      {site && !site.connectedByYou && (
        <p className="mt-1 text-xs text-muted-foreground">Picking another repository makes the website yours: its changes run on your GitHub.</p>
      )}
      {connectingRepo && busy === 'connect' ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Reading {connectingRepo}…
        </p>
      ) : reposError ? (
        <div className="mt-2">
          <PickerLoadError message={reposError} onRetry={() => void loadRepos()} />
        </div>
      ) : (
        <SearchableOptionList
          query={query}
          onQueryChange={setQuery}
          loading={repos === null}
          options={options}
          selectedId={site?.repo ?? null}
          onSelect={(repo) => void connect(repo)}
          emptyMessage={repos === null ? 'Loading your repositories…' : needle ? 'No repository matches.' : 'No repositories you can change. Your GitHub account needs write access to the website’s repository.'}
          placeholder="Search repositories..."
        />
      )}
      {site && !busy && (
        <Button variant="ghost" size="sm" className="mt-2 h-7 text-xs" onClick={() => { setPicking(false); setQuery(''); setError(null) }}>
          Cancel
        </Button>
      )}
    </div>
  )

  if (!site) {
    return (
      <Section>
        <div className="rounded-lg border border-border px-4 py-3">
          {view.canConnect ? picker : <p className="text-xs text-muted-foreground">An owner or admin of your workspace picks which repository is its website.</p>}
          {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
        </div>
      </Section>
    )
  }

  const saveAddress = () => {
    if (!busy && address.trim()) void connect(site.repo, address.trim())
  }
  // Moving the repo or the address under a change in flight would strand it: both wait until it's done.
  const canRepoint = site.canRepoint && !changeOpen

  return (
    <Section>
      <div className="rounded-lg border border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <a
            href={`https://github.com/${site.repo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-sm font-medium hover:underline"
          >
            {site.repo}
          </a>
          {!picking && canRepoint && (
            <Button variant="ghost" size="sm" className="ml-auto h-7 shrink-0 text-xs" onClick={() => setPicking(true)} disabled={!!busy}>
              Change
            </Button>
          )}
        </div>

        {/* The address customers visit: the form only takes requests from it. */}
        {canRepoint && (editingAddress || !site.siteUrl) ? (
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAddress()
              }}
              placeholder="The address customers visit, e.g. janescleaning.com"
              className="h-8 text-xs"
              aria-label="Website address"
            />
            <Button size="sm" className="h-8 shrink-0 text-xs" onClick={saveAddress} disabled={busy === 'address' || !address.trim()}>
              {busy === 'address' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              <span className="ml-1">Save</span>
            </Button>
            {site.siteUrl && (
              <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label="Cancel" onClick={() => { setEditingAddress(false); setError(null) }}>
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Live at</span>
            {site.siteUrl ? (
              <a href={site.siteUrl} target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline">
                {site.siteUrl.replace(/^https:\/\//, '')}
              </a>
            ) : (
              <span>an address not set yet</span>
            )}
            {canRepoint && (
              <button
                onClick={() => { setAddress(site.siteUrl?.replace(/^https:\/\//, '') ?? ''); setEditingAddress(true) }}
                aria-label="Edit the address"
                className="rounded p-0.5 hover:bg-accent hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
        {site.siteUrl && site.hostAddress && !editingAddress && canRepoint && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">This is your host’s own address. If customers visit a domain of your own, add it with the pencil.</p>
        )}

        {site.found && <p className="mt-2 break-words text-xs text-muted-foreground">{site.found}</p>}

        {/* Where its form stands: a change in flight, connected, or ready to connect. */}
        {change ? (
          <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs" aria-live="polite">
            <p className={change.state === 'failed' ? 'text-red-500' : ''}>
              {change.open && <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin align-[-2px]" />}
              {change.status}
            </p>
            {(change.prUrl || change.previewUrl) && (
              <div className="mt-1.5 flex gap-3">
                {change.previewUrl && <LinkOut href={change.previewUrl}>Preview</LinkOut>}
                {change.prUrl && <LinkOut href={change.prUrl}>See the change on GitHub</LinkOut>}
              </div>
            )}
          </div>
        ) : null}
        {!change?.open && (
          site.wired ? (
            <p className="mt-3 text-xs text-green-600 dark:text-green-500">Your form sends customers’ requests to you.</p>
          ) : site.hasForm && !site.connectedByYou ? (
            <p className="mt-3 text-xs text-muted-foreground">Whoever connected the website connects its form: its changes run on their GitHub.</p>
          ) : site.hasForm ? (
            <div className="mt-3">
              <Button size="sm" className="h-8 text-xs" onClick={() => void wire()} disabled={!!busy || !site.siteUrl || editingAddress || picking}>
                {busy === 'wire' && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Connect the form
              </Button>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Opens a pull request that also sends each request to Native Intelligence, keeping what the form does today. It goes live only when you say yes.
              </p>
            </div>
          ) : null
        )}

        {picking && picker}
        {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
      </div>
    </Section>
  )
}

function Section({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Website</h3>
      {children}
    </div>
  )
}

function LinkOut({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground hover:underline">
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}
