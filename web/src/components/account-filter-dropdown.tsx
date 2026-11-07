'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isDesktopApp } from '@/lib/platform'
import { useWorkspaceId } from '@/app/account/workspace-switcher'

interface ConnectedAccount {
  id: string
  provider: 'google' | 'microsoft'
  capability: 'email' | 'calendar'
  account_email: string
  display_name: string | null
  color: string
  is_enabled: boolean
}

type RawConnectedAccount = ConnectedAccount & { workspace_ids?: string[] }

// /api/oauth/status is user-level and changes only when an account is
// (dis)connected, yet every mounted dropdown (calendar page header, calendar
// widget, email view) used to refetch it per mount. One module-level copy,
// mirrored to localStorage so a cold page load renders the connected accounts
// in the first frame; persisted data is a placeholder only (timestamp stays 0,
// so the next mount still revalidates).
const OAUTH_ACCOUNTS_PERSIST_KEY = 'dial8:oauth-accounts:v1'
const OAUTH_ACCOUNTS_FRESH_MS = 60_000
let cachedOauthAccounts: RawConnectedAccount[] | null = null
let cachedOauthAccountsAt = 0

function getCachedOauthAccounts(): RawConnectedAccount[] | null {
  if (cachedOauthAccounts) return cachedOauthAccounts
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(OAUTH_ACCOUNTS_PERSIST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RawConnectedAccount[]
    if (!Array.isArray(parsed)) return null
    cachedOauthAccounts = parsed
    return parsed
  } catch {
    return null
  }
}

function setCachedOauthAccounts(accounts: RawConnectedAccount[]) {
  cachedOauthAccounts = accounts
  cachedOauthAccountsAt = Date.now()
  try {
    localStorage.setItem(OAUTH_ACCOUNTS_PERSIST_KEY, JSON.stringify(accounts))
  } catch {
    // Persistence is best-effort
  }
}

function filterAccountsFor(
  accounts: RawConnectedAccount[],
  capability: 'email' | 'calendar',
  workspaceId: string | null | undefined,
): ConnectedAccount[] {
  return accounts.filter(
    (a) =>
      a.capability === capability &&
      a.is_enabled &&
      // Filter to accounts assigned to current workspace
      (!workspaceId || !a.workspace_ids || a.workspace_ids.length === 0 || a.workspace_ids.includes(workspaceId)),
  )
}

interface LocalCalendarEntry {
  id: string
  title: string
  accountName: string
  color: string
}

const ACCOUNT_TYPE_LABELS: Record<string, Record<string, string>> = {
  email: { google: 'Gmail', microsoft: 'Outlook' },
  calendar: { google: 'Google Calendar', microsoft: 'Outlook Calendar' },
}

interface AccountFilterDropdownProps {
  capability: 'email' | 'calendar'
  selectedAccountIds: string[] | null // null = "All"
  onSelectionChange: (accountIds: string[] | null) => void
  triggerClassName?: string
}

export function AccountFilterDropdown({
  capability,
  selectedAccountIds,
  onSelectionChange,
  triggerClassName,
}: AccountFilterDropdownProps) {
  const workspaceId = useWorkspaceId()
  const [accounts, setAccounts] = useState<ConnectedAccount[]>(() => {
    const cached = getCachedOauthAccounts()
    return cached ? filterAccountsFor(cached, capability, workspaceId) : []
  })
  const [localCalendars, setLocalCalendars] = useState<LocalCalendarEntry[]>([])
  const [loaded, setLoaded] = useState(() => getCachedOauthAccounts() !== null)

  const fetchAccounts = useCallback(async (opts?: { force?: boolean }) => {
    // Another mounted dropdown fetched moments ago — reuse its result.
    const cached = getCachedOauthAccounts()
    if (!opts?.force && cached && Date.now() - cachedOauthAccountsAt < OAUTH_ACCOUNTS_FRESH_MS) {
      setAccounts(filterAccountsFor(cached, capability, workspaceId))
      setLoaded(true)
      return
    }
    try {
      const res = await fetch('/api/oauth/status')
      if (res.ok) {
        const data = await res.json()
        const all = (data.accounts || []) as RawConnectedAccount[]
        setCachedOauthAccounts(all)
        setAccounts(filterAccountsFor(all, capability, workspaceId))
      }
    } catch {
      // silently fail
    } finally {
      setLoaded(true)
    }
  }, [capability, workspaceId])

  useEffect(() => {
    fetchAccounts()
  }, [fetchAccounts])

  // Connected accounts have no realtime source (OAuth connect/disconnect is
  // out-of-band). Light-touch revalidation only: refetch on window focus when
  // stale (>60s) or after a realtime reconnect. No polling.
  const fetchRef = useRef(fetchAccounts)
  fetchRef.current = fetchAccounts
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - cachedOauthAccountsAt > OAUTH_ACCOUNTS_FRESH_MS) fetchRef.current({ force: true })
    }
    const onRecovered = () => fetchRef.current({ force: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('dial8:realtime-recovered', onRecovered)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('dial8:realtime-recovered', onRecovered)
    }
  }, [])

  // Fetch local Exchange calendars on desktop (calendar capability only)
  useEffect(() => {
    if (capability !== 'calendar' || !isDesktopApp()) return

    // Check if local Exchange is enabled for this workspace
    async function fetchLocal() {
      try {
        const { isLocalExchangeEnabledForWorkspace } = await import('@/lib/integrations/calendar-local')
        if (workspaceId && !isLocalExchangeEnabledForWorkspace(workspaceId)) {
          setLocalCalendars([])
          return
        }
        const { tauriBridge } = await import('@/lib/tauri-bridge')
        const status = await tauriBridge.getLocalCalendarStatus()
        if (status.hasAccess && status.exchangeCalendars.length > 0) {
          setLocalCalendars(status.exchangeCalendars)
        }
      } catch {
        // sidecar not available
      }
    }
    fetchLocal()
  }, [capability, workspaceId])

  // Combined count of all filterable items
  const allItemIds = [
    ...accounts.map((a) => a.id),
    ...localCalendars.map((c) => `local:${c.id}`),
  ]
  const totalCount = allItemIds.length

  const toggleAccount = useCallback(
    (itemId: string) => {
      if (selectedAccountIds === null) {
        // Currently "All" — select only this one
        onSelectionChange([itemId])
      } else if (selectedAccountIds.includes(itemId)) {
        // Deselect it
        const next = selectedAccountIds.filter((id) => id !== itemId)
        onSelectionChange(next.length === 0 ? null : next)
      } else {
        // Add it
        const next = [...selectedAccountIds, itemId]
        if (next.length === totalCount) {
          onSelectionChange(null)
        } else {
          onSelectionChange(next)
        }
      }
    },
    [selectedAccountIds, totalCount, onSelectionChange],
  )

  // Show a subtle "Connect" link when no accounts are available for this workspace
  if (loaded && totalCount === 0) {
    const connectLabel = capability === 'calendar' ? 'Connect calendar' : 'Connect email'
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1 rounded-full px-2 text-xs font-normal text-foreground/70 hover:text-foreground"
        asChild
      >
        <Link href="/account/settings/connectors">
          <Plus className="h-3 w-3" />
          <span>{connectLabel}</span>
        </Link>
      </Button>
    )
  }

  // Don't show the dropdown if there's exactly 1 item
  if (totalCount === 1) {
    const singleAccount = accounts[0]
    const singleLocal = localCalendars[0]
    const singleLabel = singleAccount
      ? singleAccount.account_email
      : singleLocal?.title || 'Account'
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-7 gap-1 rounded-full px-2 text-xs font-normal text-muted-foreground pointer-events-none', triggerClassName)}
      >
        <span className="max-w-[140px] truncate">{singleLabel}</span>
      </Button>
    )
  }

  const isAll = selectedAccountIds === null
  const selectedCount = isAll ? totalCount : selectedAccountIds.length

  let label = 'All accounts'
  if (!isAll) {
    if (selectedCount === 1) {
      const id = selectedAccountIds[0]
      if (id.startsWith('local:')) {
        const cal = localCalendars.find((c) => `local:${c.id}` === id)
        label = cal?.title || 'Exchange (Local)'
      } else {
        const account = accounts.find((a) => a.id === id)
        label = account?.account_email || 'Account'
      }
    } else {
      label = `${selectedCount} accounts`
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:shadow-none',
          triggerClassName,
        )}
      >
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronsUpDown className="h-3 w-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onClick={() => onSelectionChange(null)}
          className="gap-2"
        >
          <div className={cn(
            'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
            isAll ? 'bg-primary text-primary-foreground' : 'opacity-50',
          )}>
            {isAll && <Check className="h-3 w-3" />}
          </div>
          <span className="text-sm">All accounts</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        {/* OAuth accounts */}
        {accounts.map((account) => {
          const isSelected = isAll || selectedAccountIds?.includes(account.id)
          const typeLabel = ACCOUNT_TYPE_LABELS[account.capability]?.[account.provider] || account.provider
          return (
            <DropdownMenuItem
              key={account.id}
              onSelect={(e) => e.preventDefault()}
              onClick={() => toggleAccount(account.id)}
              className="gap-2"
            >
              <div className={cn(
                'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50',
              )}>
                {isSelected && <Check className="h-3 w-3" />}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm truncate">{account.account_email}</span>
                <span className="text-[10px] text-muted-foreground">{typeLabel}</span>
              </div>
            </DropdownMenuItem>
          )
        })}

        {/* Local Exchange calendars (desktop only) */}
        {localCalendars.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground uppercase tracking-wide">
              Local Exchange
            </DropdownMenuLabel>
            {localCalendars.map((cal) => {
              const itemId = `local:${cal.id}`
              const isSelected = isAll || selectedAccountIds?.includes(itemId)
              return (
                <DropdownMenuItem
                  key={itemId}
                  onSelect={(e) => e.preventDefault()}
                  onClick={() => toggleAccount(itemId)}
                  className="gap-2"
                >
                  <div className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-sm border border-primary',
                    isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50',
                  )}>
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: cal.color }}
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm truncate">{cal.title}</span>
                      <span className="text-[10px] text-muted-foreground">{cal.accountName}</span>
                    </div>
                  </div>
                </DropdownMenuItem>
              )
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
