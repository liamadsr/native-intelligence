'use client'

/**
 * Settings › Dial8 MCP's body: Dial8 as an MCP server.
 *
 * This is the inbound direction — AI apps (Claude, ChatGPT, Cursor, Claude
 * Code, …) connect to Dial8 and get our workspace tools. The user picks
 * their app and gets its quickest way in (connect-apps.tsx), and sees the
 * apps currently holding tokens. The page (mcp-settings-view.tsx) carries
 * the heading.
 *
 * The outbound direction (MCP servers the agent connects to) is Settings ›
 * Connectors (connectors/connectors-view.tsx).
 */

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ConnectApps } from './connect-apps'

interface ConnectedClient {
  token_id: string
  client_id: string
  client_name: string
  client_host: string | null
  created_at: string
  last_used_at: string | null
  is_expired: boolean
}

export function InboundMcpSection() {
  const [clients, setClients] = useState<ConnectedClient[]>([])
  const [revoking, setRevoking] = useState<string | null>(null)

  const fetchClients = useCallback(() => {
    fetch('/api/mcp/oauth/clients')
      .then((r) => r.json())
      .then((d) => setClients(d.clients || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchClients()
  }, [fetchClients])

  async function handleRevoke(tokenId: string) {
    setRevoking(tokenId)
    const res = await fetch('/api/mcp/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_id: tokenId }),
    })
    if (res.ok) {
      setClients((prev) => prev.filter((c) => c.token_id !== tokenId))
    }
    setRevoking(null)
  }

  return (
    <div className="space-y-8">
      {/* Nothing connected yet: no empty list, the picker is the page. */}
      {clients.length > 0 && (
        <section aria-labelledby="dial8-mcp-connected">
          <h2
            id="dial8-mcp-connected"
            className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Connected apps
          </h2>
          <div className="space-y-1">
            {clients.map((client) => (
              <div
                key={client.token_id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 group"
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                    client.is_expired ? 'bg-red-400' : 'bg-emerald-400'
                  }`}
                />
                <span className="text-sm truncate flex-1">
                  {client.client_name}
                  {client.client_host && <span className="ml-1.5 text-xs text-muted-foreground">{client.client_host}</span>}
                </span>
                {client.is_expired && (
                  <Badge
                    variant="outline"
                    className="h-5 text-[10px] border-red-500/30 text-red-500"
                  >
                    Expired
                  </Badge>
                )}
                {client.last_used_at && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatRelative(client.last_used_at)}
                  </span>
                )}
                <button
                  onClick={() => handleRevoke(client.token_id)}
                  disabled={revoking === client.token_id}
                  className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive transition-opacity"
                  title="Revoke access"
                  aria-label={`Revoke access for ${client.client_name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <ConnectApps />
    </div>
  )
}

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
