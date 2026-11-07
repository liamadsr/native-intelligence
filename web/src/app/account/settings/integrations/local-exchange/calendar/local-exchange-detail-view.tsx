'use client'

import { useCallback, useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import {
  ArrowLeft, Monitor, Loader2, CheckCircle2, XCircle, Info, Eye,
  Users, UserPlus, Plus, X,
} from 'lucide-react'
import Link from 'next/link'
import { useSettingsNavigate } from '../../../settings-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { isDesktopApp } from '@/lib/platform'
import { isLocalExchangeEnabledForWorkspace, setEnabledWorkspaceIds } from '@/lib/integrations/calendar-local'
import type { LocalCalendarStatus, ExchangeCalendarInfo } from '@/lib/tauri-bridge'

const STORAGE_KEY_DISABLED_CALENDARS = 'dial8:local-exchange:disabled-calendars'
const STORAGE_KEY_SYNC_CONTACTS = 'dial8:local-exchange:sync-contacts'
const STORAGE_KEY_ENABLED_WORKSPACES = 'dial8:local-exchange:enabled-workspaces'

interface Workspace {
  id: string
  name: string
}

function getDisabledCalendarIds(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_DISABLED_CALENDARS)
    return stored ? new Set(JSON.parse(stored)) : new Set()
  } catch {
    return new Set()
  }
}

function setDisabledCalendarIds(ids: Set<string>) {
  localStorage.setItem(STORAGE_KEY_DISABLED_CALENDARS, JSON.stringify([...ids]))
}

function getSyncContactsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_SYNC_CONTACTS) === 'true'
  } catch {
    return false
  }
}

export function LocalExchangeDetailView() {
  const settingsNavigate = useSettingsNavigate()
  const [status, setStatus] = useState<LocalCalendarStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)
  const [disabledCalendars, setDisabledCalendars] = useState<Set<string>>(new Set())
  const [syncContacts, setSyncContacts] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [enabledWorkspaceIds, setEnabledWsIds] = useState<Set<string>>(new Set())

  const fetchStatus = useCallback(async () => {
    if (!isDesktopApp()) {
      setIsLoading(false)
      return
    }
    try {
      const { tauriBridge } = await import('@/lib/tauri-bridge')
      const result = await tauriBridge.getLocalCalendarStatus()
      setStatus(result)
    } catch {
      // sidecar not available
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    setIsDesktop(isDesktopApp())
    setDisabledCalendars(getDisabledCalendarIds())
    setSyncContacts(getSyncContactsEnabled())
    fetchStatus()

    // Load workspace data
    try {
      const stored = localStorage.getItem(STORAGE_KEY_ENABLED_WORKSPACES)
      if (stored) setEnabledWsIds(new Set(JSON.parse(stored)))
    } catch { /* ignore */ }

    fetch('/api/account/workspace/list')
      .then((r) => r.ok ? r.json() : { workspaces: [] })
      .then((data) => {
        const wsList: Workspace[] = data.workspaces || []
        setWorkspaces(wsList)
        // If no workspace preferences set yet, default to all workspaces
        try {
          const stored = localStorage.getItem(STORAGE_KEY_ENABLED_WORKSPACES)
          if (!stored && wsList.length > 0) {
            const allIds = new Set(wsList.map((w) => w.id))
            setEnabledWsIds(allIds)
            setEnabledWorkspaceIds(allIds)
          }
        } catch { /* ignore */ }
      })
      .catch(() => {})
  }, [fetchStatus])

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const { tauriBridge } = await import('@/lib/tauri-bridge')
      const result = await tauriBridge.requestCalendarAccess()
      setStatus(result)

      // If access wasn't granted yet (System Settings was opened),
      // poll until the user grants access or 60s elapse.
      if (!result.hasAccess) {
        let attempts = 0
        const maxAttempts = 30 // 30 × 2s = 60s
        const poll = setInterval(async () => {
          attempts++
          try {
            const updated = await tauriBridge.getLocalCalendarStatus()
            if (updated.hasAccess) {
              clearInterval(poll)
              setStatus(updated)
              setIsConnecting(false)
            } else if (attempts >= maxAttempts) {
              clearInterval(poll)
              setIsConnecting(false)
            }
          } catch {
            clearInterval(poll)
            setIsConnecting(false)
          }
        }, 2000)
        return
      }
    } catch (err) {
      console.error('[calendar-access] failed:', err)
      console.error(`Calendar access error: ${err instanceof Error ? err.message : String(err)}`)
    }
    setIsConnecting(false)
  }

  const toggleCalendar = (calId: string) => {
    setDisabledCalendars((prev) => {
      const next = new Set(prev)
      if (next.has(calId)) {
        next.delete(calId)
      } else {
        next.add(calId)
      }
      setDisabledCalendarIds(next)
      return next
    })
  }

  const handleToggleWorkspace = (wsId: string) => {
    setEnabledWsIds((prev) => {
      const next = new Set(prev)
      if (next.has(wsId)) {
        next.delete(wsId)
      } else {
        next.add(wsId)
      }
      setEnabledWorkspaceIds(next)
      return next
    })
  }

  const handleSyncContactsToggle = (enabled: boolean) => {
    setSyncContacts(enabled)
    localStorage.setItem(STORAGE_KEY_SYNC_CONTACTS, enabled ? 'true' : 'false')
  }

  const handleSyncNow = async () => {
    setIsSyncing(true)
    setSyncResult(null)
    try {
      const { tauriBridge } = await import('@/lib/tauri-bridge')
      const now = new Date()
      const past30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      const events = await tauriBridge.getLocalExchangeEvents({
        timeMin: past30Days.toISOString(),
        timeMax: now.toISOString(),
      })

      // Collect unique attendees with emails
      const attendees = new Map<string, string>() // email -> name
      for (const event of events) {
        for (const attendee of event.attendees) {
          // Attendees may be "Name" or "email@domain.com" or "Name <email>"
          const emailMatch = attendee.match(/[\w.-]+@[\w.-]+\.\w+/)
          if (emailMatch) {
            const email = emailMatch[0].toLowerCase()
            if (!attendees.has(email)) {
              const name = attendee.replace(/<.*>/, '').replace(emailMatch[0], '').trim() || email.split('@')[0]
              attendees.set(email, name)
            }
          }
        }
      }

      if (attendees.size === 0) {
        setSyncResult('No attendees with email addresses found in recent events.')
        return
      }

      // Send to API for contact creation
      const res = await fetch('/api/account/contacts/sync-from-local-calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attendees: Array.from(attendees.entries()).map(([email, name]) => ({
            email,
            fullName: name,
          })),
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setSyncResult(`${data.created} new contacts created, ${data.existing} already existed.`)
      } else {
        setSyncResult('Failed to sync contacts. Please try again.')
      }
    } catch {
      setSyncResult('Failed to fetch events or sync contacts.')
    } finally {
      setIsSyncing(false)
    }
  }

  const isConnected = status?.hasAccess && (status?.exchangeCalendars?.length ?? 0) > 0
  const hasAccessNoCalendars = status?.hasAccess && (status?.exchangeCalendars?.length ?? 0) === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => settingsNavigate('/account/settings/connectors')}
            aria-label="Back to Connectors"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white">
            <Monitor className="h-5 w-5 text-orange-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Exchange (Local Calendar)</h1>
          </div>
          {isConnected && (
            <Badge
              variant="outline"
              className="h-7 border-green-500/30 bg-green-500/10 text-green-500"
            >
              Connected
            </Badge>
          )}
        </div>

        <p className="mt-3 text-muted-foreground pl-[52px]">
          Read Exchange calendar events directly from the macOS Calendar app — no Microsoft sign-in required.
        </p>

        <div className="mt-8 pl-[52px] space-y-8">
          {/* Not on desktop */}
          {!isDesktop && (
            <div className="rounded-lg border border-border p-6 text-center">
              <Monitor className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                This integration is only available in the Dial8 desktop app.
              </p>
            </div>
          )}

          {/* Desktop: Loading */}
          {isDesktop && isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <ThinkingOrb state="breathing" size={20} theme="auto" />
              <span className="text-sm">Checking calendar access...</span>
            </div>
          )}

          {/* Desktop: Content */}
          {isDesktop && !isLoading && (
            <>
              {/* How It Works */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How It Works
                </h3>
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex gap-3">
                    <Info className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p>
                        Some work accounts don&apos;t allow signing in to third-party apps with your Microsoft/Exchange
                        credentials, but they <em>do</em> allow syncing to macOS via <strong>System Settings &gt; Internet Accounts</strong>.
                      </p>
                      <p>
                        This integration reads your Exchange calendar events directly from the macOS Calendar app
                        using Apple&apos;s EventKit framework. Your events never leave your device — they&apos;re
                        merged locally with your other calendar accounts.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Capabilities */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Capabilities
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <Eye className="h-4 w-4 text-green-500 shrink-0" />
                    <span className="text-sm">View Exchange events</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    <span className="text-sm">Show in calendar &amp; tray</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    <span className="text-sm">Link to meeting notes</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                    <span className="text-sm">Edit &amp; move events (drag/drop)</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Changes made to Exchange events in Dial8 are written back to macOS Calendar, which syncs them
                  to your Exchange server. Your organization&apos;s policies still apply — if the server rejects a change,
                  it may revert.
                </p>
              </div>

              {/* Exchange Calendars with toggles */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {isConnected ? 'Exchange Calendars' : 'Connection'}
                </h3>

                {isConnected && status && (
                  <div className="space-y-2">
                    {status.exchangeCalendars.map((cal) => {
                      const isEnabled = !disabledCalendars.has(cal.id)
                      return (
                        <div
                          key={cal.id}
                          className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
                        >
                          <div
                            className="h-3 w-3 shrink-0 rounded-full transition-opacity"
                            style={{
                              backgroundColor: cal.color,
                              opacity: isEnabled ? 1 : 0.3,
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <span className={`text-sm font-medium ${!isEnabled ? 'text-muted-foreground' : ''}`}>
                              {cal.title}
                            </span>
                            <p className="text-xs text-muted-foreground">{cal.accountName}</p>
                          </div>
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={() => toggleCalendar(cal.id)}
                            aria-label={`Toggle ${cal.title}`}
                          />
                        </div>
                      )
                    })}
                    <p className="text-xs text-muted-foreground">
                      Disabled calendars won&apos;t appear in the calendar view or system tray.
                    </p>
                  </div>
                )}

                {hasAccessNoCalendars && (
                  <div className="rounded-lg border border-border p-4">
                    <div className="flex items-start gap-3">
                      <Info className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                      <div className="text-sm text-muted-foreground">
                        <p className="font-medium text-foreground">No Exchange accounts found</p>
                        <p className="mt-1">
                          Calendar access is granted, but no Exchange accounts were detected in macOS Calendar.
                          Add your Exchange account via <strong>System Settings &gt; Internet Accounts &gt; Exchange</strong>.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {!status?.hasAccess && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Grant Dial8 permission to read your macOS Calendar to get started.
                    </p>
                    <Button
                      onClick={handleConnect}
                      disabled={isConnecting}
                    >
                      {isConnecting ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      Grant Calendar Access
                    </Button>
                  </div>
                )}
              </div>

              {/* Workspace Visibility */}
              {isConnected && workspaces.length > 1 && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Workspace Visibility
                  </h3>
                  <div className="rounded-lg border border-border p-4 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Choose which workspaces can see your local Exchange calendar events.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground shrink-0">Visible in</span>
                      {Array.from(enabledWorkspaceIds).map((wsId) => {
                        const ws = workspaces.find((w) => w.id === wsId)
                        return ws ? (
                          <Badge
                            key={wsId}
                            variant="secondary"
                            className="h-6 gap-1 pl-2 pr-1 text-xs font-normal"
                          >
                            {ws.name}
                            <button
                              onClick={() => handleToggleWorkspace(wsId)}
                              className="rounded-sm p-0.5 hover:bg-muted-foreground/20 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ) : null
                      })}
                      {enabledWorkspaceIds.size === 0 && (
                        <span className="text-xs text-muted-foreground/60 italic">
                          No workspaces
                        </span>
                      )}
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="h-6 px-2 text-xs text-muted-foreground">
                            <Plus className="h-3 w-3 mr-1" />
                            Add
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-56 p-2" align="start">
                          <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                            Select workspaces
                          </p>
                          <div className="space-y-0.5">
                            {workspaces.map((ws) => {
                              const isEnabled = enabledWorkspaceIds.has(ws.id)
                              return (
                                <label
                                  key={ws.id}
                                  className="flex items-center gap-2.5 rounded-2xl px-2 py-1.5 text-sm cursor-pointer hover:bg-accent transition-colors"
                                >
                                  <Checkbox
                                    checked={isEnabled}
                                    onCheckedChange={() => handleToggleWorkspace(ws.id)}
                                  />
                                  <span className="truncate">{ws.name}</span>
                                </label>
                              )
                            })}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>
              )}

              {/* CRM Contact Sync */}
              {isConnected && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    CRM Contact Sync
                  </h3>
                  <div className="rounded-lg border border-border p-4 space-y-4">
                    <div className="flex items-start gap-3">
                      <Users className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="sync-contacts" className="text-sm font-medium cursor-pointer">
                            Create contacts from meeting participants
                          </Label>
                          <Switch
                            id="sync-contacts"
                            checked={syncContacts}
                            onCheckedChange={handleSyncContactsToggle}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Automatically add meeting attendees from your Exchange calendar to your CRM as contacts.
                          Existing contacts (matched by email) won&apos;t be duplicated.
                        </p>
                      </div>
                    </div>

                    {syncContacts && (
                      <div className="flex items-center gap-3 pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={handleSyncNow}
                          disabled={isSyncing}
                        >
                          {isSyncing ? (
                            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                          ) : (
                            <UserPlus className="mr-1.5 h-3 w-3" />
                          )}
                          Sync contacts now
                        </Button>
                        {syncResult && (
                          <span className="text-xs text-muted-foreground">{syncResult}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Setup Instructions */}
              {!isConnected && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Setup
                  </h3>
                  <div className="rounded-lg border border-border p-4">
                    <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
                      <li>Open <strong>System Settings &gt; Internet Accounts</strong> on your Mac</li>
                      <li>Click <strong>Add Account &gt; Exchange</strong> and sign in with your work email</li>
                      <li>Make sure <strong>Calendars</strong> is enabled for the account</li>
                      <li>Come back here and click <strong>Grant Calendar Access</strong></li>
                    </ol>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
