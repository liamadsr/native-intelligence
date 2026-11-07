'use client'

/**
 * One connected MCP server's page under Settings › Connectors
 * (`connectors/mcp/{id}`), laid out like Claude's per-connector page:
 *
 *   ← Your connectors
 *   [icon] Name  label                       Disconnect  ⋯ (Refresh tools, Turn off/on)
 *   what it is, where it lives
 *   Tool permissions   Read-only / Write & delete groups, each collapsible,
 *                      with a menu that sets the whole group; every tool row
 *                      has a one-click ✓ Always allow / ✋ Needs approval /
 *                      ⊘ Blocked switch (lib/mcp-client/tool-permissions.ts).
 *                      A tool the server added since is New (and Blocked)
 *                      until the person picks a permission.
 *
 * Reads `GET /api/account/mcp-servers` (the row is in the list; again on
 * window focus, so a change made elsewhere shows), writes `PATCH
 * /api/account/mcp-servers/{id}`. A permission change is sent as the change
 * itself (`tool_permission`), which the route applies to the row as it is
 * then, never as lists computed from this page's copy. Writes are shown at
 * once, sent one after another, and only the last one's answer is kept; a
 * failed write re-reads. Refresh is `POST …/refresh-tools`, Disconnect is `DELETE`.
 * An OAuth server whose sign-in expired (GEN-1171) says so in an amber box
 * with Reconnect: the MCP OAuth flow again, which renews this row in place
 * (its tool permissions kept).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Ban, ChevronDown, CircleCheck, Ellipsis, Hand, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { mcpCause } from '@/lib/integrations/connections'
import { useConnectProvider } from '@/lib/integrations/use-connect-provider'
import { startMcpOAuth } from '@/lib/integrations/start-mcp-oauth'
import { suggestedMcpServerFor } from '@/lib/mcp-client/suggested'
import type { McpToolAnnotations } from '@/lib/mcp-client/approval-policy'
import { isNewMcpTool } from '@/lib/mcp-client/tool-access'
import {
  canAlwaysAllow,
  groupPermission,
  groupToolsByType,
  TOOL_PERMISSIONS,
  toolDisplayName,
  toolPermission,
  withToolPermission,
  type ToolPermission,
} from '@/lib/mcp-client/tool-permissions'
import { ToolPermissionGroup, type ToolPermissionRow } from '@/components/tool-permissions/tool-permission-controls'
import { RowIcon } from '../../(dashboard)/side-panels/connections-section'
import { useSettingsNavigate } from '../settings-shell'

interface McpTool {
  name: string
  description?: string
  annotations?: McpToolAnnotations
}

interface McpServer {
  id: string
  display_name: string
  server_url: string
  transport: 'streamable_http' | 'sse'
  auth_type: 'none' | 'bearer' | 'oauth2'
  is_enabled: boolean
  disabled_tools: string[]
  require_approval_tools: string[]
  approval_free_tools?: string[]
  allowed_tools?: string[] | null
  tools_cache: McpTool[] | null
  last_error: string | null
  token_expires_at: string | null
  /** Its sign-in expired for good (migration 451; absent before it). */
  reauth_required_at?: string | null
  created_at: string
}

/** What the page writes: the on/off switch, or one permission change. */
type ServerWrite = { is_enabled: boolean } | { tool_permission: { tools: string[]; permission: ToolPermission } }

const AUTH_LABEL: Record<McpServer['auth_type'], string> = { none: 'No sign-in', bearer: 'Bearer token', oauth2: 'OAuth' }


const ALWAYS_ASKS = 'It can publish, schedule or delete for you, so it always asks.'

export function McpConnectorView({ id }: { id: string }) {
  const settingsNavigate = useSettingsNavigate()
  const [server, setServer] = useState<McpServer | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  /** The write queue's tail, the newest write's number, and how many are still out. */
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const writeSeqRef = useRef(0)
  const inFlightRef = useRef(0)

  const backToConnectors = useCallback(() => settingsNavigate('/account/settings/connectors'), [settingsNavigate])
  const [reconnectError, setReconnectError] = useState<string | null>(null)

  const fetchServer = useCallback(async () => {
    try {
      const res = await fetch('/api/account/mcp-servers')
      if (!res.ok || !mountedRef.current) return
      const json = (await res.json()) as { servers?: McpServer[] }
      if (mountedRef.current) setServer(json.servers?.find((s) => s.id === id) ?? null)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setLoading(true)
    void fetchServer()
  }, [fetchServer])

  // Back from another window or tab: show what changed there (not mid-write, whose answer is on its way).
  useEffect(() => {
    const onFocus = () => {
      if (inFlightRef.current === 0) void fetchServer()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchServer])

  /** Send one write after the ones before it; keep only the newest answer; re-read when one fails. */
  const write = useCallback(
    (body: ServerWrite) => {
      const seq = ++writeSeqRef.current
      inFlightRef.current++
      const send = async () => {
        let ok = false
        try {
          const res = await fetch(`/api/account/mcp-servers/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (res.ok) {
            const json = (await res.json()) as { server?: McpServer }
            ok = true
            if (json.server && mountedRef.current && seq === writeSeqRef.current) setServer(json.server)
          }
        } catch {
          // Offline, or the app slept mid-write: the re-read below shows what was saved.
        } finally {
          inFlightRef.current--
        }
        if (!ok && mountedRef.current) await fetchServer()
      }
      queueRef.current = queueRef.current.then(send)
    },
    [id, fetchServer],
  )

  const setPermission = useCallback(
    (tools: McpTool[], permission: ToolPermission) => {
      // Shown at once from this page's copy; the route applies the same change to the row as it is.
      setServer((prev) => {
        if (!prev) return prev
        const { allowed_tools, ...lists } = withToolPermission(prev, tools, permission)
        return { ...prev, ...lists, allowed_tools: allowed_tools ?? prev.allowed_tools }
      })
      write({ tool_permission: { tools: tools.map((t) => t.name), permission } })
    },
    [write],
  )

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setServer((prev) => (prev ? { ...prev, is_enabled: enabled } : prev))
      write({ is_enabled: enabled })
    },
    [write],
  )

  async function refreshTools() {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/account/mcp-servers/${id}/refresh-tools`, { method: 'POST' })
      // A non-JSON body (a proxy's 502 page) still surfaces as an error on the page.
      let json: { server?: McpServer; error?: string } = {}
      try {
        json = await res.json()
      } catch {
        json = { error: `Refresh failed (HTTP ${res.status})` }
      }
      if (!mountedRef.current) return
      if (json.server) setServer(json.server)
      else if (json.error) {
        const message = json.error
        setServer((prev) => (prev ? { ...prev, last_error: message } : prev))
      } else await fetchServer()
    } finally {
      if (mountedRef.current) setRefreshing(false)
    }
  }

  async function disconnect() {
    setDisconnecting(true)
    try {
      const res = await fetch(`/api/account/mcp-servers/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setConfirmOpen(false)
        backToConnectors()
      }
    } finally {
      if (mountedRef.current) setDisconnecting(false)
    }
  }

  const { connectWithUrl, connectingId } = useConnectProvider({
    origin: 'settings',
    onReturn: (result) => {
      setReconnectError(result.success ? null : (result.error ?? "Didn't reconnect. Try again when you're ready."))
      void fetchServer()
    },
  })

  const suggested = server ? (suggestedMcpServerFor(server.server_url) ?? null) : null
  const tools = useMemo(() => server?.tools_cache ?? [], [server])
  const groups = useMemo(() => (server ? groupToolsByType(tools, server) : { readOnly: [], write: [] }), [server, tools])
  const cause = server ? mcpCause(server) : null
  const reconnectKey = `mcp:${id}`
  const reconnecting = connectingId === reconnectKey
  // Its own name and URL, so the OAuth callback renews this very row (a path or query the person set stays).
  const reconnect = () => {
    if (!server) return
    setReconnectError(null)
    void connectWithUrl(reconnectKey, () => startMcpOAuth({ display_name: server.display_name, server_url: server.server_url, transport: server.transport }))
  }
  let host = ''
  try {
    host = server ? new URL(server.server_url).host : ''
  } catch {
    host = server?.server_url ?? ''
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <button
          type="button"
          onClick={backToConnectors}
          className="-ml-1 inline-flex items-center gap-2 rounded-md px-1 py-0.5 text-sm text-foreground transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Your connectors
        </button>

        {loading ? (
          <div className="mt-8 space-y-4" aria-hidden>
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-lg" />
              <Skeleton className="h-6 w-40" />
            </div>
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : !server ? (
          <div className="mt-8">
            <p className="text-sm text-muted-foreground">This connector isn&apos;t connected anymore.</p>
          </div>
        ) : (
          <>
            <div className="mt-6 flex items-center gap-3">
              <RowIcon
                size="md"
                row={{
                  kind: 'mcp',
                  provider: suggested?.id ?? 'mcp',
                  capability: 'mcp',
                  mcp: { serverId: server.id, serverUrl: server.server_url, suggested },
                }}
              />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <h1 className="truncate text-xl font-semibold">{server.display_name}</h1>
                <span className="shrink-0 rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {suggested ? 'MCP' : 'Custom MCP'}
                </span>
              </div>
              <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setConfirmOpen(true)}>
                Disconnect
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`More for ${server.display_name}`}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  >
                    {refreshing ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Ellipsis aria-hidden className="h-4 w-4" />}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem disabled={refreshing} onSelect={() => void refreshTools()}>
                    Refresh tools
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setEnabled(!server.is_enabled)}>
                    {server.is_enabled ? 'Turn off' : 'Turn on'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {suggested?.description && <p className="mt-4 text-muted-foreground">{suggested.description}.</p>}
            <p className={cn('text-sm text-muted-foreground', suggested?.description ? 'mt-1' : 'mt-4')}>
              <span className="select-text">{host}</span> · {AUTH_LABEL[server.auth_type]}
            </p>

            {!server.is_enabled && (
              <div className="mt-5 flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
                <span className="text-muted-foreground">Off: the agent sees none of {server.display_name}&apos;s tools.</span>
                <Button variant="outline" size="sm" className="h-7 shrink-0 px-3 text-xs" onClick={() => setEnabled(true)}>
                  Turn on
                </Button>
              </div>
            )}

            {cause === 'mcp_expired' && server.auth_type === 'oauth2' ? (
              <div data-mcp-reconnect="" className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium text-foreground">Sign-in expired</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {server.display_name} couldn&apos;t renew its sign-in, so the agent can&apos;t use its tools. Reconnect to sign in again; your tool permissions stay as they are.
                    </p>
                    {reconnectError && <p className="mt-1 select-text text-xs text-amber-700 dark:text-amber-400">{reconnectError}</p>}
                  </div>
                  <Button size="sm" className="h-7 shrink-0 px-3 text-xs" onClick={reconnect} disabled={reconnecting} aria-busy={reconnecting || undefined}>
                    {reconnecting && <Loader2 aria-hidden className="mr-1 size-3 animate-spin motion-reduce:animate-none" />}
                    Reconnect
                  </Button>
                </div>
              </div>
            ) : (
              server.last_error && (
                <div className="mt-5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                    <div className="min-w-0 text-xs text-red-500">
                      <p className="select-text">{server.last_error}</p>
                    </div>
                  </div>
                </div>
              )
            )}

            <section aria-labelledby="tool-permissions" className="mt-10">
              <h2 id="tool-permissions" className="text-base font-semibold">
                Tool permissions
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">Choose when the agent is allowed to use these tools.</p>

              {tools.length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  No tools found yet.{' '}
                  <button
                    type="button"
                    onClick={() => void refreshTools()}
                    disabled={refreshing}
                    className="text-foreground underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    Refresh tools
                  </button>
                </div>
              ) : (
                <div className="mt-4 space-y-2">
                  <ToolGroup title="Read-only tools" tools={groups.readOnly} server={server} onSet={setPermission} />
                  <ToolGroup title="Write & delete tools" tools={groups.write} server={server} onSet={setPermission} />
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {server && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Disconnect ${server.display_name}?`}
          description="The agent loses its tools and your permission choices are forgotten. You can connect it again from Discover."
          confirmLabel="Disconnect"
          busy={disconnecting}
          onConfirm={() => void disconnect()}
        />
      )}
    </div>
  )
}

/** One group (Read-only, Write & delete): the shared Tool permissions group, read from this server's lists. */
function ToolGroup({
  title,
  tools,
  server,
  onSet,
}: {
  title: string
  tools: McpTool[]
  server: McpServer
  onSet: (tools: McpTool[], permission: ToolPermission) => void
}) {
  const value = groupPermission(tools, server)
  if (value === null) return null
  const rows: ToolPermissionRow[] = tools.map((tool) => ({
    name: tool.name,
    label: toolDisplayName(tool),
    title: tool.description ? `${tool.name}: ${tool.description}` : tool.name,
    value: toolPermission(tool, server),
    allowDisabled: !canAlwaysAllow(tool, server),
    allowDisabledReason: ALWAYS_ASKS,
    badge: isNewMcpTool(server, tool.name) ? (
      <span
        className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground"
        title="The server added this tool after you connected it. The agent can't see it until you pick a permission."
      >
        New
      </span>
    ) : undefined,
  }))
  return (
    <ToolPermissionGroup
      title={title}
      rows={rows}
      value={value}
      onSetGroup={(p) => onSet(tools, p)}
      onSetTool={(name, p) => {
        const tool = tools.find((t) => t.name === name)
        if (tool) onSet([tool], p)
      }}
    />
  )
}
