'use client'

/**
 * The Connect card (flows-connectors F2 §2.1): what the `connect` tool puts in
 * the chat. It is the Connectors panel's own row (side-panels/connections-
 * section.tsx: its icon tile, its name, its ONE action word in its tones) in
 * a small bordered card, plus, for a server from a URL, the domain and the
 * tools it exposes before the person authorizes.
 *
 * The tap is the existing connect flow (useConnectProvider, origin 'panel' so
 * a desktop return doesn't open Settings over the chat):
 *   integration   /api/oauth/{provider}/authorize (a popup on the web, the
 *                 system browser on the desktop);
 *   catalog app   the MCP OAuth start route (startMcpOAuth);
 *   URL app       the same start route when it needs a sign-in, or the add
 *                 route when it answered without one.
 * Nobody here sees a token. When the flow returns, the card re-reads the
 * connection (connect-card-status.ts, shared reads) and settles, and its
 * outcome waits for the agent's next turn (recordConnectionNote).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RowIcon, toneOf } from '../side-panels/connections-section'
import { useConnectProvider, type ConnectResult } from '@/lib/integrations/use-connect-provider'
import { startMcpOAuth } from '@/lib/integrations/start-mcp-oauth'
import { suggestedMcpServerById } from '@/lib/mcp-client/suggested'
import { CONNECT_CARD_TOOLS_SHOWN, connectKeyOf, recordConnectionNote, type ConnectCard as Card } from '@/lib/connections/connect-card'
import { invalidateConnectStatus, readConnectState } from '@/lib/connections/connect-card-status'

type Phase = { at: 'idle' } | { at: 'connected'; detail: string | null } | { at: 'failed'; error: string | null }

/** The word on the card's one action. */
export function connectCardWord(card: Card, phase: Phase): string {
  if (phase.at === 'connected') return 'Connected'
  if (phase.at === 'failed') return 'Try again'
  if (card.status === 'needs_reconnect') return 'Reconnect'
  if (card.status === 'needs_update') return 'Update access'
  return card.kind === 'url_app' ? 'Authorize' : 'Connect'
}

/** POST a no-sign-in server to the add route; the saved row's tool count, or an error. */
async function addOpenServer(card: Extract<Card, { kind: 'url_app' }>): Promise<{ ok: true; tools: number } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/account/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // What the card showed is what gets allowed: a tool the server adds
      // between the card and the tap stays new (hidden) until added.
      body: JSON.stringify({ display_name: card.name, server_url: card.server_url, transport: card.transport, auth_type: 'none', shown_tools: (card.tools ?? []).map((t) => t.name) }),
    })
    const json = (await res.json().catch(() => ({}))) as { server?: { tools_cache?: unknown[] }; error?: string }
    if (!res.ok || !json.server) return { ok: false, error: json.error || `Couldn't add it (HTTP ${res.status})` }
    return { ok: true, tools: Array.isArray(json.server.tools_cache) ? json.server.tools_cache.length : 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't add it" }
  }
}

export function ConnectCard({ card }: { card: Card }) {
  const [phase, setPhase] = useState<Phase>(card.status === 'connected' ? { at: 'connected', detail: card.kind === 'integration' ? (card.account ?? null) : null } : { at: 'idle' })
  const [adding, setAdding] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // A card from an earlier visit: is it connected by now? (One shared read for every card.)
  useEffect(() => {
    if (card.status === 'connected') return
    let live = true
    void readConnectState(card).then((s) => {
      if (live && s?.connected) setPhase({ at: 'connected', detail: s.detail })
    })
    return () => {
      live = false
    }
  }, [card])

  const settle = useCallback(
    async (result: Pick<ConnectResult, 'success' | 'error'>) => {
      invalidateConnectStatus()
      const s = await readConnectState(card)
      if (!mounted.current) return
      if (s?.connected) {
        setPhase({ at: 'connected', detail: s.detail })
        recordConnectionNote({ name: card.name, outcome: 'connected', ...(s.detail ? { detail: s.detail } : {}) })
        return
      }
      setPhase({ at: 'failed', error: result.error ?? null })
      recordConnectionNote({ name: card.name, outcome: 'not_connected', ...(result.error ? { detail: result.error } : {}) })
    },
    [card],
  )

  const { connect, connectWithUrl, connectingId } = useConnectProvider({ origin: 'panel', onReturn: (r) => void settle(r) })
  const busy = adding || connectingId === connectKeyOf(card)

  const act = useCallback(() => {
    if (phase.at === 'connected') return
    if (card.kind === 'integration') {
      const loginHint = card.status === 'needs_reconnect' || card.status === 'needs_update' ? (card.account ?? undefined) : undefined
      void connect(card.provider, card.capability, loginHint ? { loginHint } : undefined)
      return
    }
    if (card.kind === 'catalog_app') {
      if (!suggestedMcpServerById(card.catalog_id)) return
      // The card's own name and URL: the catalog's, or (a Reconnect) the person's row, which the callback renews in place.
      void connectWithUrl(connectKeyOf(card), () => startMcpOAuth({ display_name: card.name, server_url: card.server_url, transport: card.transport }))
      return
    }
    if (card.auth === 'none') {
      setAdding(true)
      void addOpenServer(card).then((r) => {
        if (mounted.current) setAdding(false)
        void settle(r.ok ? { success: true, error: null } : { success: false, error: r.error })
      })
      return
    }
    void connectWithUrl(connectKeyOf(card), () => startMcpOAuth({ display_name: card.name, server_url: card.server_url, transport: card.transport }))
  }, [card, phase.at, connect, connectWithUrl, settle])

  const iconRow = useMemo(
    () =>
      card.kind === 'integration'
        ? { kind: 'oauth' as const, provider: card.provider, capability: card.capability }
        : {
            kind: 'mcp' as const,
            provider: card.kind === 'catalog_app' ? card.catalog_id : 'mcp',
            capability: 'mcp',
            mcp: { serverId: null, serverUrl: card.server_url, suggested: card.kind === 'catalog_app' ? (suggestedMcpServerById(card.catalog_id) ?? null) : null },
          },
    [card],
  )

  const word = connectCardWord(card, phase)
  const group = phase.at === 'connected' ? 'connected' : card.status === 'needs_reconnect' || card.status === 'needs_update' || phase.at === 'failed' ? 'attention' : 'available'
  const subtitle =
    phase.at === 'connected' && phase.detail
      ? phase.detail
      : card.kind === 'url_app'
        ? card.domain
        : card.kind === 'integration' && card.account && card.status !== 'available'
          ? card.account
          : card.description

  return (
    <div data-connect-card={card.kind} data-connect-state={phase.at} className="w-full max-w-md self-start rounded-xl border border-border/60 bg-background">
      <div className="flex h-12 items-center gap-2.5 px-3">
        <RowIcon row={iconRow} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-foreground">{card.name}</p>
          {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        {phase.at === 'connected' ? (
          <span data-connect-action="connected" className="shrink-0 text-[12px] text-muted-foreground">
            {word}
          </span>
        ) : (
          <button
            type="button"
            data-connect-action={card.kind === 'url_app' ? 'authorize' : 'connect'}
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={`${word} ${card.name}`}
            onClick={act}
            className={cn(
              '-mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none',
              toneOf({ group }),
            )}
          >
            {busy && <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />}
            {word}
          </button>
        )}
      </div>
      {card.kind === 'url_app' && phase.at !== 'connected' && <UrlAppDetails card={card} />}
      {phase.at === 'failed' && (
        <p data-connect-error="" className="border-t border-border/60 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          {phase.error ? `Didn't connect: ${phase.error}` : "Didn't connect. Try again when you're ready."}
        </p>
      )}
    </div>
  )
}

/** A URL server's domain and tools, shown before the person authorizes (decision 23). */
function UrlAppDetails({ card }: { card: Extract<Card, { kind: 'url_app' }> }) {
  const tools = card.tools
  const shown = tools?.slice(0, CONNECT_CARD_TOOLS_SHOWN) ?? []
  // What it listed in all; the card carries at most CONNECT_CARD_TOOLS_MAX names.
  const total = Math.max(card.tool_count ?? 0, tools?.length ?? 0)
  const more = total - shown.length
  const unlisted = total - (tools?.length ?? 0)
  return (
    <div data-connect-details="" className="border-t border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
      <p>
        <span className="text-foreground">{card.domain}</span> isn&apos;t in Native Intelligence&apos;s catalog.{' '}
        {tools === null
          ? 'It asks you to sign in before it lists its tools. Anything that can change data will ask you first.'
          : tools.length === 0
            ? 'It lists no tools.'
            : `It exposes ${total} ${total === 1 ? 'tool' : 'tools'}; the ones that can change data ask you first.`}
        {unlisted > 0 && ` Only the first ${tools?.length ?? 0} are added; the rest stay hidden until you add them in Settings.`}
      </p>
      {shown.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {shown.map((t) => (
            <li key={t.name} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{t.name}</code>
              <span className={cn('shrink-0 text-[11px]', t.access === 'ask' && 'text-amber-700 dark:text-amber-400')}>
                {t.access === 'ask' ? 'Asks first' : 'Reads'}
              </span>
            </li>
          ))}
          {more > 0 && <li className="text-[11px]">and {more} more</li>}
        </ul>
      )}
    </div>
  )
}
