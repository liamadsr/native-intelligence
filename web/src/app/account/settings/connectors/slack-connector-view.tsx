'use client'

/**
 * Native Intelligence's Slack app under Settings › Connectors (`connectors/slack`),
 * laid out like a connector's own page:
 *
 *   ← Your connectors
 *   [icon] Slack
 *   what it does
 *   Slack workspaces   each one bound to this Native Intelligence workspace: whether the
 *                      person's own Slack account is linked there (Link my
 *                      account / Unlink me), and Disconnect for admins
 *   the code panel     a one-time code to send the bot in Slack
 *
 * An admin presses "Add to Slack": Slack's own install page, which comes back
 * here connected (the Slack workspace bound to this Native Intelligence
 * workspace, their own Slack account linked) with `?slack=<result>`, which
 * the page shows in plain words (src/lib/slack/install-result.ts) and then
 * takes off the address. In the desktop app Slack's page opens in the
 * person's own browser instead, which hands the install back to the app; the
 * window that started it claims it (src/lib/integrations/desktop-oauth-claims.ts)
 * and this page shows the result the same way. Everyone else links their Slack
 * account with a one-time code they send the bot. A code from an admin also
 * connects a Slack workspace the app is already in.
 *
 * Reads `GET /api/account/integrations/slack` (again on window focus: the
 * code is sent in Slack, so the link lands while this page is in the
 * background); writes `POST …/install`, `POST …/link-code`, `DELETE …/link`
 * (unlink me) and `DELETE …?team=` (disconnect).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { SLACK_APP_ENTRY } from '@/lib/integrations/catalog'
import { holdDesktopSlackClaim } from '@/lib/integrations/desktop-oauth-claims'
import { onSlackInstallCallback } from '@/lib/navigation-events'
import { isDesktopApp } from '@/lib/platform'
import { SLACK_INSTALL_RESULT_PARAM, parseSlackInstallResult, slackInstallMessage, type SlackInstallResult } from '@/lib/slack/install-result'
import { RowIcon } from '../../(dashboard)/side-panels/connections-section'
import { useSettingsNavigate } from '../settings-shell'

/** GET /api/account/integrations/slack (route.ts there). */
interface SlackState {
  configured: boolean
  appId?: string | null
  canInstall?: boolean
  canLink?: boolean
  installations?: Array<{
    teamId: string
    teamName: string
    teamDomain: string
    /** False: connected here, but the app holds no token for it (connected the old way, or its token died): add it again. */
    tokenStored?: boolean
    /** alertsOn: the "needs your OK" DMs (null: unknown, no switch). */
    myLink: { slackUserName: string; alertsOn?: boolean | null } | null
  }>
}

interface LinkCode {
  code: string
  expiresAt: string
}

const SLACK_ROW = { kind: 'app', provider: SLACK_APP_ENTRY.provider, capability: SLACK_APP_ENTRY.capability } as const

/** Opens the Native Intelligence app's DM in Slack (Slack's own redirect). */
function openInSlackHref(appId: string | null | undefined, teamId?: string): string | null {
  if (!appId) return null
  return `https://slack.com/app_redirect?app=${encodeURIComponent(appId)}${teamId ? `&team=${encodeURIComponent(teamId)}` : ''}`
}

export function SlackConnectorView() {
  const settingsNavigate = useSettingsNavigate()
  const backToConnectors = useCallback(() => settingsNavigate('/account/settings/connectors'), [settingsNavigate])
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
        <SlackConnectorContent />
      </div>
    </div>
  )
}

/**
 * Everything under the page's back link: the connector's page, and (`compact`:
 * a smaller title and headings) the agent panel's Communication tab.
 */
/**
 * The Slack connector's state and actions, shared by its settings page
 * (SlackConnectorContent) and the agent panel's Slack tab
 * (components/communication/slack-card.tsx), so the two never drift.
 */
export function useSlackConnector() {
  const [state, setState] = useState<SlackState | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null)
  // The Slack workspace the code is for ("Open Native Intelligence in Slack" goes there); null for the install's first code.
  const [codeTeam, setCodeTeam] = useState<string | null>(null)
  const [makingCode, setMakingCode] = useState(false)
  const [busyTeam, setBusyTeam] = useState<string | null>(null)
  const [confirmTeam, setConfirmTeam] = useState<{ teamId: string; teamName: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What Slack's install came back with (the good news; a failure is `error`).
  const [notice, setNotice] = useState<string | null>(null)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/account/integrations/slack')
      if (!res.ok) throw new Error()
      setState((await res.json()) as SlackState)
    } catch {
      // A failed re-read keeps what's shown; a failed first read says so below.
    } finally {
      setLoading(false)
    }
  }, [])

  // How an install ended, in plain words: back on this page with `?slack=`, or
  // claimed by this window in the desktop app.
  const showInstallResult = useCallback((result: SlackInstallResult) => {
    const message = slackInstallMessage(result)
    setNotice(message.ok ? message.text : null)
    setError(message.ok ? null : message.text)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = parseSlackInstallResult(params.get(SLACK_INSTALL_RESULT_PARAM))
    if (result) {
      showInstallResult(result)
      params.delete(SLACK_INSTALL_RESULT_PARAM)
      const rest = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
    }
    void fetchState()
    const onFocus = () => void fetchState()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchState, showInstallResult])

  // Desktop: the install this window started, claimed after the person
  // finished it in their browser (deep-link-handler.tsx).
  useEffect(
    () =>
      onSlackInstallCallback(({ result }) => {
        showInstallResult(result)
        void fetchState()
      }),
    [fetchState, showInstallResult],
  )

  // A newly linked account ends the code step: the install's first code, or
  // a link in one more Slack workspace while already linked in another.
  const installations = state?.installations ?? []
  const linkedCount = installations.filter((i) => i.myLink).length
  const prevLinkedCount = useRef<number | null>(null)
  useEffect(() => {
    const prev = prevLinkedCount.current
    prevLinkedCount.current = linkedCount
    if (prev !== null && linkedCount > prev) {
      setLinkCode(null)
      setCodeTeam(null)
    }
  }, [linkedCount])

  const makeCode = useCallback(async (teamId: string | null) => {
    setMakingCode(true)
    setError(null)
    try {
      const res = await fetch('/api/account/integrations/slack/link-code', { method: 'POST' })
      if (!res.ok) throw new Error()
      setLinkCode((await res.json()) as LinkCode)
      setCodeTeam(teamId)
      setCopied(false)
    } catch {
      setError("Couldn't make a code. Try again.")
    } finally {
      setMakingCode(false)
    }
  }, [])

  const install = async () => {
    setInstalling(true)
    setError(null)
    const desktop = isDesktopApp()
    try {
      const res = await fetch('/api/account/integrations/slack/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Slack's install comes back to this page (the settings page, or the agent panel's Slack tab).
        body: JSON.stringify(desktop ? { returnTo: window.location.pathname, source: 'desktop' } : { returnTo: window.location.pathname }),
      })
      const data = (await res.json().catch(() => null)) as { url?: string; state?: string; claimSecret?: string } | null
      if (!res.ok || !data?.url) {
        setError("Couldn't start the Slack install. Try again.")
        setInstalling(false)
        return
      }
      if (desktop) {
        // Without its state and claim secret the install could never be finished here.
        if (!data.state || !data.claimSecret) {
          setError("Couldn't start the Slack install. Try again.")
          setInstalling(false)
          return
        }
        // The app keeps other sites out of its window: Slack's page opens in
        // the person's own browser, which hands the install back to this
        // window by deep link. Only this window holds the secret to claim it.
        holdDesktopSlackClaim(data.state, data.claimSecret)
        const { openUrl } = await import('@tauri-apps/plugin-opener')
        await openUrl(data.url)
        setInstalling(false)
        setNotice('Finish adding Native Intelligence to Slack in your browser. This page updates by itself.')
        return
      }
      window.location.assign(data.url)
    } catch {
      setError("Couldn't start the Slack install. Try again.")
      setInstalling(false)
    }
  }

  const unlink = async (teamId: string) => {
    setBusyTeam(teamId)
    setError(null)
    try {
      const res = await fetch(`/api/account/integrations/slack/link?team=${encodeURIComponent(teamId)}`, { method: 'DELETE' })
      if (!res.ok) setError("Couldn't unlink. Try again.")
      await fetchState()
    } finally {
      setBusyTeam(null)
    }
  }

  const setAlerts = async (teamId: string, on: boolean) => {
    setBusyTeam(teamId)
    setError(null)
    try {
      const res = await fetch(`/api/account/integrations/slack/link?team=${encodeURIComponent(teamId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerts: on }),
      })
      if (!res.ok) setError("Couldn't change Slack alerts. Try again.")
      await fetchState()
    } finally {
      setBusyTeam(null)
    }
  }

  const disconnect = async (teamId: string) => {
    setBusyTeam(teamId)
    setError(null)
    try {
      const res = await fetch(`/api/account/integrations/slack?team=${encodeURIComponent(teamId)}`, { method: 'DELETE' })
      if (!res.ok) setError("Couldn't disconnect Slack. Try again.")
      await fetchState()
    } finally {
      setBusyTeam(null)
      setConfirmTeam(null)
    }
  }

  const copyCode = async () => {
    if (!linkCode) return
    try {
      await navigator.clipboard.writeText(linkCode.code)
      setCopied(true)
    } catch {
      // Selecting the code by hand still works.
    }
  }

  const connected = installations.length > 0
  const slackHref = openInSlackHref(state?.appId, codeTeam ?? installations[0]?.teamId)

  return { state, loading, installing, linkCode, codeTeam, makingCode, busyTeam, confirmTeam, setConfirmTeam, copied, error, notice, fetchState, installations, makeCode, install, unlink, setAlerts, disconnect, copyCode, connected, slackHref }
}

export function SlackConnectorContent({ compact = false }: { compact?: boolean }) {
  const { state, loading, installing, linkCode, codeTeam, makingCode, busyTeam, confirmTeam, setConfirmTeam, copied, error, notice, fetchState, installations, makeCode, install, unlink, setAlerts, disconnect, copyCode, connected, slackHref } = useSlackConnector()

  return (
    <div data-slack-section="">
      {loading ? (
        <div className={cn(compact ? 'space-y-3' : 'mt-8 space-y-4')} aria-hidden>
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="h-6 w-40" />
          </div>
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : !state ? (
        <div className={cn('flex items-center gap-3', !compact && 'mt-8')}>
          <p className="text-sm text-muted-foreground">Couldn&apos;t load Slack.</p>
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => void fetchState()}>
            Try again
          </Button>
        </div>
      ) : !state.configured ? (
        <div className={cn(!compact && 'mt-8')}>
          <p className="text-sm text-muted-foreground">Slack isn&apos;t available here.</p>
        </div>
      ) : (
        <>
          <div className={cn('flex items-center gap-3', !compact && 'mt-6')}>
            <RowIcon size={compact ? 'sm' : 'md'} row={SLACK_ROW} />
            {compact ? (
              <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{SLACK_APP_ENTRY.name}</h3>
            ) : (
              <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">{SLACK_APP_ENTRY.name}</h1>
            )}
          </div>
          <p className={cn(compact ? 'mt-2 text-sm' : 'mt-4', 'text-muted-foreground')}>{SLACK_APP_ENTRY.description}.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            In a thread, each person&apos;s @mention gets their own agent. Approvals come to you in a direct message.
          </p>

          {!connected && !linkCode && (
            <section aria-labelledby="slack-setup" className={cn(compact ? 'mt-4' : 'mt-8', 'rounded-xl border p-4')}>
              <h2 id="slack-setup" className="text-sm font-medium">
                Set up Slack
              </h2>
              {state.canInstall ? (
                <ol className="mt-3 space-y-4 text-sm">
                  <SetupStep n={1} title="Add Native Intelligence to your Slack">
                    Slack asks you to allow it, then brings you back here, connected.
                    <div>
                      <Button size="sm" className="mt-2 h-7 px-3 text-xs" onClick={() => void install()} disabled={installing}>
                        {installing && <Loader2 aria-hidden className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" />}
                        Add to Slack
                      </Button>
                    </div>
                  </SetupStep>
                  <SetupStep n={2} title="Message your agent in Slack">
                    Open Native Intelligence under Apps in Slack. Teammates link their own Slack accounts from this page.
                  </SetupStep>
                  <li className="text-xs text-muted-foreground">
                    Native Intelligence already in your Slack?{' '}
                    <button
                      type="button"
                      onClick={() => void makeCode(null)}
                      disabled={makingCode}
                      className="text-foreground underline underline-offset-2 disabled:opacity-60"
                    >
                      Get a code
                    </button>{' '}
                    and send it to Native Intelligence there.
                  </li>
                </ol>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Someone who manages this Native Intelligence workspace sets up Slack first. Once they have, you can link your own
                  Slack account here.
                </p>
              )}
            </section>
          )}

          {notice && !error && (
            <p role="status" className="mt-5 text-sm text-muted-foreground">
              {notice}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-5 text-sm text-destructive">
              {error}
            </p>
          )}

          {linkCode && (
            <section aria-labelledby="slack-code" className={cn(compact ? 'mt-4' : 'mt-8', 'rounded-xl border p-4')}>
              <h2 id="slack-code" className="text-sm font-medium">
                {connected ? 'In Slack, send Native Intelligence this code' : 'Last step: in Slack, send this code to Native Intelligence'}
              </h2>
              {!connected && (
                <p className="mt-1 text-sm text-muted-foreground">Open Native Intelligence in Slack and send it this code as a message.</p>
              )}
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 select-all rounded-md bg-muted px-2 py-1.5 text-center font-mono text-base tracking-widest">
                  {linkCode.code}
                </code>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => void copyCode()} aria-label="Copy code">
                  {copied ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
                </Button>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Works once, for 15 minutes.{' '}
                  <button
                    type="button"
                    onClick={() => void makeCode(codeTeam)}
                    disabled={makingCode}
                    className="text-foreground underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    New code
                  </button>
                </p>
                {slackHref && (
                  <Button variant="outline" size="sm" className="h-7 shrink-0 px-3 text-xs" asChild>
                    <a href={slackHref} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden className="mr-1.5 h-3 w-3" />
                      Open Native Intelligence in Slack
                    </a>
                  </Button>
                )}
              </div>
            </section>
          )}

          {connected && (
            <section aria-labelledby="slack-workspaces" className={compact ? 'mt-5' : 'mt-10'}>
              <h2 id="slack-workspaces" className={compact ? 'text-xs font-medium uppercase tracking-wide text-muted-foreground' : 'text-base font-semibold'}>
                Slack workspaces
              </h2>
              {connected ? (
                <ul className={cn(compact ? 'mt-2' : 'mt-4', 'divide-y overflow-hidden rounded-xl border')}>
                  {installations.map((team) => {
                    const name = team.teamName || team.teamDomain || team.teamId
                    const busy = busyTeam === team.teamId
                    if (team.tokenStored === false) {
                      // Connected, but the app holds no token there: it can't answer until it is added again.
                      return (
                        <li key={team.teamId} data-slack-team={team.teamId} data-slack-readd="" className="flex items-center gap-3 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{name}</p>
                            <p className="text-xs text-muted-foreground">
                              {state.canInstall
                                ? 'Native Intelligence has to be added to this Slack workspace again before it answers there. Everyone’s links come back with it.'
                                : 'Native Intelligence has to be added to this Slack workspace again before it answers there. Ask an admin of this workspace to add it.'}
                            </p>
                          </div>
                          {state.canInstall && (
                            <Button size="sm" className="h-7 shrink-0 px-3 text-xs" disabled={installing} aria-label={`Add Native Intelligence to ${name} again`} onClick={() => void install()}>
                              {installing && <Loader2 aria-hidden className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" />}
                              Add to Slack
                            </Button>
                          )}
                          {state.canInstall && (
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-7 shrink-0 px-3 text-xs"
                              disabled={busy}
                              aria-label={`Disconnect ${name}`}
                              onClick={() => setConfirmTeam({ teamId: team.teamId, teamName: name })}
                            >
                              Disconnect
                            </Button>
                          )}
                        </li>
                      )
                    }
                    return (
                      <li key={team.teamId} data-slack-team={team.teamId} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {team.myLink
                              ? `You're ${team.myLink.slackUserName ? `@${team.myLink.slackUserName}` : 'linked'}`
                              : 'Your Slack account isn’t linked'}
                          </p>
                        </div>
                        {team.myLink && typeof team.myLink.alertsOn === 'boolean' && (
                          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" data-slack-alerts={team.teamId}>
                            <span title="Native Intelligence DMs you here when it needs your OK and you're not in the app">DM me when Native Intelligence needs my OK</span>
                            <Switch
                              checked={team.myLink.alertsOn}
                              onCheckedChange={(v) => void setAlerts(team.teamId, v)}
                              disabled={busy}
                              aria-label={`DM me in ${name} when Native Intelligence needs my OK`}
                            />
                          </label>
                        )}
                        {team.myLink ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 shrink-0 px-2 text-xs"
                            disabled={busy}
                            aria-label={`Unlink me from ${name}`}
                            onClick={() => void unlink(team.teamId)}
                          >
                            Unlink me
                          </Button>
                        ) : (
                          state.canLink &&
                          !linkCode && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 shrink-0 px-3 text-xs"
                              disabled={makingCode}
                              aria-label={`Link my account in ${name}`}
                              onClick={() => void makeCode(team.teamId)}
                            >
                              {makingCode && <Loader2 aria-hidden className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none" />}
                              Link my account
                            </Button>
                          )
                        )}
                        {state.canInstall && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-7 shrink-0 px-3 text-xs"
                            disabled={busy}
                            aria-label={`Disconnect ${name}`}
                            onClick={() => setConfirmTeam({ teamId: team.teamId, teamName: name })}
                          >
                            Disconnect
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </section>
          )}
        </>
      )}

      {confirmTeam && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmTeam(null)}
          title={`Disconnect ${confirmTeam.teamName}?`}
          description="Native Intelligence stops answering in that Slack workspace, for everyone. Adding it again brings back everyone's links."
          confirmLabel="Disconnect"
          busy={busyTeam === confirmTeam.teamId}
          onConfirm={() => void disconnect(confirmTeam.teamId)}
        />
      )}
    </div>
  )
}

function SetupStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
        {n}
      </span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <div className="mt-0.5 text-muted-foreground">{children}</div>
      </div>
    </li>
  )
}
