'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import { Check, Loader2, Shield, Terminal } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import { grantedScopes } from '@/lib/mcp/scopes'
import { isWithinAppDomain } from '@/lib/app-url'

/** Redirect URI schemes that would run script or read local data on navigation. */
const UNSAFE_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'file:'])

/** The app asking, as /api/mcp/oauth/client-info checked it. */
interface ClientInfo {
  client_name: string
  publisher_host: string | null
  publisher_path: string | null
}

function AuthorizeContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [isApproving, setIsApproving] = useState(false)
  const [isDenying, setIsDenying] = useState(false)

  const clientId = searchParams.get('client_id') || ''
  const redirectUri = searchParams.get('redirect_uri') || ''
  const codeChallenge = searchParams.get('code_challenge') || ''
  const codeChallengeMethod = searchParams.get('code_challenge_method') || 'S256'
  const scope = searchParams.get('scope') || 'read write'
  const state = searchParams.get('state') || ''


  // Who is asking, from the server, never from this URL: its query is anyone's
  // to write, so a name read from it could say anything. For an app named by
  // its metadata document (an https client_id) the server also says the host
  // that published it. Allow waits for the answer.
  const [info, setInfo] = useState<ClientInfo | null>(null)
  const [infoFailed, setInfoFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/mcp/oauth/client-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri }),
    })
      .then(async (res) => {
        if (!live) return
        if (res.ok) setInfo((await res.json()) as ClientInfo)
        else setInfoFailed(true)
      })
      .catch(() => {
        if (live) setInfoFailed(true)
      })
    return () => {
      live = false
    }
  }, [clientId, redirectUri])
  const clientName = info?.client_name ?? 'This app'
  const publisherHost = info?.publisher_host ?? null
  const publisherPath = info?.publisher_path ?? ''

  const scopeDescriptions: Record<string, string> = {
    read: 'Read your workspace data (actions, projects, documents, captures)',
    write: 'Create and update actions, comments, and other workspace items',
  }
  // What approve will grant, by the same rule, each in its own words: never
  // text from this URL, and `write` always shows the read it brings.
  const scopes = grantedScopes(scope) ?? []

  // Surface WHERE the authorization code will be sent. The register endpoint is
  // unauthenticated and accepts any client_name + redirect_uri, so a phishing
  // client can pick a trustworthy-looking name; showing the actual destination
  // origin lets the user catch a mismatch. An origin that isn't a known Native Intelligence
  // origin is flagged with a warning.
  //
  // Parsed ONCE. Native clients register custom schemes (cursor://, vscode://)
  // whose `.origin` is the string "null", so the destination shown is scheme +
  // host. Script-bearing schemes are refused outright: Allow/Deny navigate to
  // the redirect, and a javascript: URL would run on this page.
  let redirectUrl: URL | null = null
  try {
    redirectUrl = redirectUri ? new URL(redirectUri) : null
  } catch {
    redirectUrl = null
  }
  if (redirectUrl && UNSAFE_REDIRECT_SCHEMES.has(redirectUrl.protocol)) redirectUrl = null
  const redirectRejected = !!redirectUri && !redirectUrl
  const destinationOrigin = redirectUrl
    ? redirectUrl.origin !== 'null'
      ? redirectUrl.origin
      : `${redirectUrl.protocol}//${redirectUrl.host}`
    : null
  const isWebRedirect = redirectUrl?.protocol === 'http:' || redirectUrl?.protocol === 'https:'
  // A local port or an app's own scheme (cursor://): an app on this computer.
  // Any program here can listen on a port or claim a name, registered or
  // borrowing a real app's metadata URL (MCP authorization spec, "Localhost
  // Redirect URI Risks"), so it is never a known origin: it gets the warning.
  const isLocalApp = !!redirectUrl && (!isWebRedirect || ['localhost', '127.0.0.1', '[::1]'].includes(redirectUrl.hostname))
  const isKnownOrigin = !!redirectUrl && isWebRedirect && !isLocalApp && isWithinAppDomain(redirectUrl.hostname)

  const handleApprove = async () => {
    setIsApproving(true)
    try {
      const res = await fetch('/api/mcp/oauth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          scope,
          state: state || undefined,
        }),
      })

      if (res.ok) {
        const { redirect_url } = await res.json()
        window.location.assign(redirect_url)
      } else {
        console.error('Approve failed:', await res.text())
        setIsApproving(false)
      }
    } catch (err) {
      console.error('Approve error:', err)
      setIsApproving(false)
    }
  }

  // Back to the client only at a redirect_uri the server checked is its own
  // (/api/mcp/oauth/deny, as approve checks): this page's query is anyone's
  // to write, so the raw redirect_uri made Deny a one-click open redirect. A
  // missing or script-bearing one (redirectUrl null) never gets that far, and
  // the server's answer is followed only on a safe scheme.
  const handleDeny = async () => {
    setIsDenying(true)
    if (redirectUrl) {
      try {
        const res = await fetch('/api/mcp/oauth/deny', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, state: state || undefined }),
        })
        if (res.ok) {
          const { redirect_url } = (await res.json()) as { redirect_url?: unknown }
          if (typeof redirect_url === 'string' && !UNSAFE_REDIRECT_SCHEMES.has(new URL(redirect_url).protocol)) {
            window.location.assign(redirect_url)
            return
          }
        }
      } catch (err) {
        console.error('Deny error:', err)
      }
    }
    router.push('/account/settings/connectors')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="flex justify-center">
          <div className="flex items-center gap-2">
            <img
              src="/brand/ni-mark.png"
              alt=""
              aria-hidden
              className="h-7 w-7 brightness-0 dark:invert"
            />
            <span className="text-2xl font-semibold">Native Intelligence</span>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="space-y-5">
            {/* Header */}
            <div className="text-center space-y-2">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Terminal className="h-6 w-6 text-emerald-500" />
              </div>
              <h1 className="text-lg font-semibold">{info ? `Authorize ${clientName}` : infoFailed ? "This app can't be authorized" : 'Checking this app…'}</h1>
              <p className="text-sm text-muted-foreground">
                <strong>{clientName}</strong> wants to access your Native Intelligence workspace
              </p>
              {publisherHost && (
                <p className="text-xs text-muted-foreground">
                  Published by{' '}
                  <span className="break-all">
                    <strong className="text-foreground">{publisherHost}</strong>
                    {publisherPath}
                  </span>
                </p>
              )}
            </div>

            {/* Permissions */}
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                This will allow {clientName} to:
              </p>
              <div className="space-y-2.5">
                {scopes.map((s) => (
                  <div key={s} className="flex items-start gap-2.5">
                    <Check className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" />
                    <span className="text-sm">
                      {scopeDescriptions[s]}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Destination — where the authorization code will be sent. */}
            {destinationOrigin && (
              <div
                className={
                  isKnownOrigin
                    ? 'rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground'
                    : 'rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400'
                }
              >
                <p>
                  This will send your authorization to:{' '}
                  <strong className="break-all">{destinationOrigin}</strong>
                </p>
                {!isKnownOrigin && (
                  <p className="mt-1">
                    {isLocalApp
                      ? `That is an app on this computer, and any app here can call itself ${clientName}. Only continue if you just started connecting it yourself.`
                      : 'This is not a Native Intelligence address. Only continue if you recognize and trust it.'}
                  </p>
                )}
              </div>
            )}

            {infoFailed && !redirectRejected && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                This sign-in request isn&apos;t valid, so access can&apos;t be granted.
              </div>
            )}

            {redirectRejected && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                This app&apos;s redirect address is not valid, so access can&apos;t be granted.
              </div>
            )}

            {/* Security note */}
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                You can revoke access at any time from Settings &rarr; NI MCP.{' '}
                {clientName} will only access workspaces you&apos;re a member of.
              </span>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleDeny}
                disabled={isApproving || isDenying}
              >
                {isDenying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Deny
              </Button>
              <Button
                className="flex-1"
                onClick={handleApprove}
                disabled={isApproving || isDenying || redirectRejected || !info || scopes.length === 0}
              >
                {isApproving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Allow Access
              </Button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground">
          By clicking Allow, you authorize this application to access your Native Intelligence account.
        </p>
      </div>
    </div>
  )
}

export default function McpAuthorizePage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <ThinkingOrb state="connecting" size={64} theme="auto" />
      </div>
    }>
      <AuthorizeContent />
    </Suspense>
  )
}
