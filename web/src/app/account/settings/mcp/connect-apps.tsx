'use client'

/**
 * Settings › Native Intelligence MCP's "Pick your app": the server URL to copy, a tile per
 * AI app, and the picked app's own way in: its one-click install link, the
 * command to paste, or the steps in its settings. What each app takes lives
 * in lib/mcp/connect-clients.ts; this only draws it.
 */

import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { ArrowUpRight, Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { SYSTEM_BROWSER_PROPS } from '@/lib/open-external'
import {
  CONNECT_CLIENTS,
  OTHER_APP_HINT,
  connectClient,
  connectServer,
  unreachableFrom,
  type ConnectClient,
  type ConnectClientId,
  type ConnectServer,
} from '@/lib/mcp/connect-clients'
import { cn } from '@/lib/utils'
import { ConnectAppIcon } from './connect-app-icon'

// The origin the apps add. SSR and the first client render both use dial8.ai
// (no hydration mismatch); on a local dev server a later commit swaps in its
// own origin. Nothing changes the hostname mid-session, so subscribe is a no-op.
const PROD_ORIGIN = 'https://dial8.ai'
function subscribeToHostname() {
  return () => {}
}
function getServerOrigin() {
  return PROD_ORIGIN
}
function getClientOrigin() {
  if (typeof window === 'undefined') return PROD_ORIGIN
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' ? window.location.origin : PROD_ORIGIN
}

const SECTION_HEADING = 'mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground'
const PANEL_ID = 'ni-mcp-app-panel'
const tabId = (id: ConnectClientId) => `ni-mcp-app-${id}`

export function ConnectApps() {
  const origin = useSyncExternalStore(subscribeToHostname, getClientOrigin, getServerOrigin)
  const server = useMemo(() => connectServer(origin, origin !== PROD_ORIGIN), [origin])
  const [picked, setPicked] = useState<ConnectClientId>(CONNECT_CLIENTS[0].id)
  const client = connectClient(picked)
  const tabs = useRef<Partial<Record<ConnectClientId, HTMLButtonElement | null>>>({})

  // The tiles are tabs: arrows, Home and End move between apps (and pick one).
  function onTabKey(e: KeyboardEvent) {
    const at = CONNECT_CLIENTS.findIndex((c) => c.id === picked)
    const last = CONNECT_CLIENTS.length - 1
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at === last ? 0 : at + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at === 0 ? last : at - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    const id = CONNECT_CLIENTS[next].id
    setPicked(id)
    tabs.current[id]?.focus()
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="ni-mcp-url">
        <h2 id="ni-mcp-url" className={SECTION_HEADING}>
          Server URL
        </h2>
        <div className="flex items-center gap-2 rounded-xl border bg-muted/40 py-1.5 pl-3 pr-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-sm">{server.url}</code>
          <CopyButton text={server.url} label="Copy URL" what="the server URL" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Every app signs in with your Native Intelligence account. No API key to make or paste.
        </p>
      </section>

      <section aria-labelledby="ni-mcp-apps">
        <h2 id="ni-mcp-apps" className={SECTION_HEADING}>
          Pick your app
        </h2>
        {/* One row at the page's full width, wrapping in a narrow pane. */}
        <div
          role="tablist"
          aria-labelledby="ni-mcp-apps"
          onKeyDown={onTabKey}
          className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2"
        >
          {CONNECT_CLIENTS.map((c) => (
            <AppTile
              key={c.id}
              ref={(el) => {
                tabs.current[c.id] = el
              }}
              client={c}
              picked={c.id === picked}
              onPick={() => setPicked(c.id)}
            />
          ))}
        </div>
        {/* Keyed: a new app starts with fresh Copy buttons. */}
        <AppPanel key={client.id} client={client} server={server} />
        <p className="mt-3 text-xs text-muted-foreground">{OTHER_APP_HINT}</p>
      </section>
    </div>
  )
}

function AppTile({
  ref,
  client,
  picked,
  onPick,
}: {
  ref: (el: HTMLButtonElement | null) => void
  client: ConnectClient
  picked: boolean
  onPick: () => void
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabId(client.id)}
      aria-selected={picked}
      aria-controls={PANEL_ID}
      tabIndex={picked ? 0 : -1}
      data-connect-tile={client.id}
      onClick={onPick}
      className={cn(
        'flex flex-col items-center gap-2 rounded-xl border px-2 pb-2.5 pt-3 text-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        picked ? 'border-foreground/30 bg-muted/70' : 'hover:bg-muted/40',
      )}
    >
      <ConnectAppIcon id={client.id} />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{client.name}</span>
        <span className="block text-[10px] text-muted-foreground">{client.how}</span>
      </span>
    </button>
  )
}

/** The picked app's way in: install link, steps, what to paste, and a note. */
function AppPanel({ client, server }: { client: ConnectClient; server: ConnectServer }) {
  const snippets = client.snippets?.(server) ?? []
  const local = unreachableFrom(client, server)
  return (
    <div
      role="tabpanel"
      id={PANEL_ID}
      aria-labelledby={tabId(client.id)}
      data-connect-app={client.id}
      className="mt-3 space-y-4 rounded-xl border p-5"
    >
      <div className="flex items-center gap-3">
        <ConnectAppIcon id={client.id} />
        <h3 className="text-sm font-semibold">Add Native Intelligence to {client.name}</h3>
      </div>

      {local && (
        <p className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          {client.name} connects from its own servers, so it can&apos;t reach this local dev server. Use dial8.ai, or a
          public tunnel to this machine.
        </p>
      )}

      {client.install && (
        <div>
          <Button asChild size="sm">
            <a href={client.install.href(server)} target="_blank" rel="noopener noreferrer" {...SYSTEM_BROWSER_PROPS}>
              {client.install.label}
              <ArrowUpRight aria-hidden className="ml-1 h-3.5 w-3.5" />
            </a>
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Opens {client.name}, which asks you to confirm. Then sign in with your Native Intelligence account when it asks.
          </p>
        </div>
      )}

      {client.steps && (
        <ol className="list-decimal space-y-1.5 pl-5 text-sm marker:text-muted-foreground">
          {client.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}

      {client.open && (
        <Button asChild variant="outline" size="sm">
          <a href={client.open.href} target="_blank" rel="noopener noreferrer" {...SYSTEM_BROWSER_PROPS}>
            {client.open.label}
            <ArrowUpRight aria-hidden className="ml-1 h-3.5 w-3.5" />
          </a>
        </Button>
      )}

      {snippets.map((snippet) => (
        <div key={snippet.label}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{snippet.label}</span>
            <CopyButton text={snippet.text} label="Copy" what={snippet.label} />
          </div>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/50 p-3 font-mono text-xs">
            {snippet.text}
          </pre>
        </div>
      ))}

      {client.note && <p className="text-xs text-muted-foreground">{client.note}</p>}
    </div>
  )
}

/** Copy, with what it copies in its name: a panel can hold two. */
function CopyButton({ text, label, what }: { text: string; label: string; what: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      aria-label={copied ? 'Copied' : `Copy ${what}`}
      onClick={async () => {
        if (!(await copyTextToClipboard(text))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <Check aria-hidden className="mr-1 h-3 w-3" /> : <Copy aria-hidden className="mr-1 h-3 w-3" />}
      {copied ? 'Copied' : label}
    </Button>
  )
}
