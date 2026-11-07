'use client'

/**
 * Settings › Connectors' "Add custom connector": an MCP server by its URL
 * (Claude's Add › Custom › Web). A name, the server URL, and under Advanced
 * settings the transport and a bearer token when the server takes one.
 * `POST /api/account/mcp-servers` lists the server's tools before it saves,
 * so a server that can't be reached is never added.
 */
import { useState } from 'react'
import { AlertCircle, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function AddCustomConnectorDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The saved server (its id opens its page). */
  onCreated: (server: { id: string }) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [transport, setTransport] = useState<'streamable_http' | 'sse'>('streamable_http')
  const [authType, setAuthType] = useState<'none' | 'bearer'>('none')
  const [accessToken, setAccessToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // A token being entered keeps Advanced open: a hidden required field would block the submit unseen.
  const showAdvanced = advanced || authType === 'bearer'

  function reset() {
    setDisplayName('')
    setServerUrl('')
    setAdvanced(false)
    setTransport('streamable_http')
    setAuthType('none')
    setAccessToken('')
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/account/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          server_url: serverUrl,
          transport,
          auth_type: authType,
          access_token: authType === 'bearer' ? accessToken : undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'Failed to add the connector')
        return
      }
      onCreated(json.server)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add the connector')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add custom connector</DialogTitle>
          <DialogDescription>
            Connect any MCP server by its URL. We list its tools before saving, and its tools that can change
            something ask for your approval until you say otherwise.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="custom-connector-name">Name</Label>
            <Input
              id="custom-connector-name"
              placeholder="e.g. Notion"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-connector-url">Remote MCP server URL</Label>
            <Input
              id="custom-connector-url"
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              required
            />
          </div>

          <div>
            <button
              type="button"
              aria-expanded={showAdvanced}
              aria-controls="custom-connector-advanced"
              onClick={() => setAdvanced((v) => !v)}
              className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', showAdvanced && 'rotate-90')} />
              Advanced settings
            </button>
            <div id="custom-connector-advanced" hidden={!showAdvanced} className="mt-3 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Transport</Label>
                  <Select value={transport} onValueChange={(v) => setTransport(v as typeof transport)}>
                    <SelectTrigger aria-label="Transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
                      <SelectItem value="sse">SSE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Authentication</Label>
                  <Select value={authType} onValueChange={(v) => setAuthType(v as typeof authType)}>
                    <SelectTrigger aria-label="Authentication">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="bearer">Bearer token</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {authType === 'bearer' && (
                <div className="space-y-2">
                  <Label htmlFor="custom-connector-token">Access token</Label>
                  <Input
                    id="custom-connector-token"
                    type="password"
                    placeholder="Pasted from the server"
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">Encrypted at rest. We never log or display it after saving.</p>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                <span className="text-xs text-red-500">{error}</span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
