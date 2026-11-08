'use client'

/**
 * Devices settings — manage long-lived API tokens for hardware devices
 * (the XIAO ESP32S3 capture device) and other headless clients.
 *
 * A device token is minted here, shown ONCE, and pasted into the device's
 * config. The plaintext is never recoverable afterward — only revoke + remint.
 * Modeled on the inbound-MCP "connected clients" section.
 */

import { useCallback, useEffect, useState } from 'react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { Check, Copy, Cpu, Plus, X, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface DeviceToken {
  id: string
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  is_expired: boolean
}

export function DevicesSettingsView() {
  const [tokens, setTokens] = useState<DeviceToken[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The freshly-minted plaintext token, shown once until dismissed.
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchTokens = useCallback(() => {
    setLoading(true)
    fetch('/api/account/device-tokens')
      .then((r) => r.json())
      .then((d) => setTokens(d.tokens || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchTokens()
  }, [fetchTokens])

  async function handleCreate() {
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/account/device-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to create token')
        return
      }
      setNewToken({ name: data.name, token: data.token })
      setName('')
      fetchTokens()
    } catch {
      setError('Failed to create token')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: string) {
    setRevoking(id)
    const res = await fetch(`/api/account/device-tokens/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setTokens((prev) => prev.filter((t) => t.id !== id))
    }
    setRevoking(null)
  }

  async function copyToken() {
    if (!newToken) return
    await copyTextToClipboard(newToken.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-800">
            <Cpu className="h-5 w-5 text-emerald-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Devices</h1>
            <p className="text-sm text-muted-foreground">
              Generate access tokens for hardware devices that connect to your Native Intelligence workspace.
            </p>
          </div>
        </div>

        <div className="mt-8 space-y-8">
          {/* Create */}
          <section>
            <h2 className="text-base font-semibold">Add a device</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Name a device, then paste the generated token into its configuration. The token has
              the same access as your account in this workspace, so treat it like a password.
            </p>

            <div className="mt-4 flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                }}
                placeholder="e.g. XIAO on my desk"
                maxLength={100}
                disabled={creating}
              />
              <Button onClick={handleCreate} disabled={creating || !name.trim()}>
                <Plus className="mr-1 h-4 w-4" />
                {creating ? 'Generating…' : 'Generate token'}
              </Button>
            </div>
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

            {/* One-time reveal of the freshly-minted token */}
            {newToken && (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      Copy your token for “{newToken.name}” now
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      This is the only time it will be shown. If you lose it, revoke it and
                      generate a new one.
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background p-2 text-xs font-mono">
                        {newToken.token}
                      </pre>
                      <Button variant="outline" size="sm" onClick={copyToken}>
                        {copied ? (
                          <>
                            <Check className="mr-1 h-3 w-3" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="mr-1 h-3 w-3" /> Copy
                          </>
                        )}
                      </Button>
                    </div>
                    <button
                      onClick={() => setNewToken(null)}
                      className="mt-3 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Done — I’ve saved it
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* List */}
          <section>
            <h3 className="text-sm font-medium">Your devices</h3>
            {loading ? (
              <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
            ) : tokens.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No devices yet. Generate a token above to connect one.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {tokens.map((t) => (
                  <div
                    key={t.id}
                    className="group flex items-center gap-3 rounded-md border px-3 py-2"
                  >
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                        t.is_expired ? 'bg-red-400' : 'bg-emerald-400'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{t.name}</p>
                      <p className="truncate text-xs text-muted-foreground font-mono">
                        {t.token_prefix}…
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t.last_used_at
                        ? `Used ${formatRelative(t.last_used_at)}`
                        : 'Never used'}
                    </span>
                    <button
                      onClick={() => handleRevoke(t.id)}
                      disabled={revoking === t.id}
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      title="Revoke this device"
                      aria-label={`Revoke ${t.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
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
