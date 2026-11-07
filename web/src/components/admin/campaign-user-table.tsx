'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Crown, Gift, X } from 'lucide-react'
import { UserCell } from './user-cell'
import { SavedViewsBar } from './saved-views-bar'
import { useSavedViews } from '@/hooks/use-saved-views'
import { formatRelativeTime } from '@/lib/campaign-utils'
import type {
  CampaignUser,
  CampaignColumnDef,
  CampaignAction,
  FilterConfig,
} from '@/lib/campaign-types'
import { DEFAULT_FILTERS } from '@/lib/campaign-types'

const SIGNED_UP_OPTIONS = [
  { value: 'any', label: 'Signed up: Any' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
]

const LAST_SIGN_IN_OPTIONS = [
  { value: 'any', label: 'Last sign in: Any' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
]

const TIER_OPTIONS = [
  { value: 'all', label: 'All tiers' },
  { value: 'free', label: 'Free' },
  { value: 'pro_paid', label: 'Pro (Paid)' },
  { value: 'pro_granted', label: 'Pro (Granted)' },
]

const PURCHASE_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'yes', label: 'Has purchases' },
  { value: 'no', label: 'No purchases' },
]

function applyFilters(users: CampaignUser[], filters: FilterConfig): CampaignUser[] {
  return users.filter((user) => {
    if (filters.tier !== 'all' && user.tier !== filters.tier) return false

    if (filters.signedUpDays !== null) {
      const cutoff = new Date(Date.now() - filters.signedUpDays * 86400000)
      if (new Date(user.createdAt) < cutoff) return false
    }

    if (filters.lastSignInDays !== null) {
      if (!user.lastSignInAt) return false
      const cutoff = new Date(Date.now() - filters.lastSignInDays * 86400000)
      if (new Date(user.lastSignInAt) < cutoff) return false
    }

    if (filters.hasPurchase === true && user.tier === 'free') return false
    if (filters.hasPurchase === false && user.tier !== 'free') return false

    if (filters.campaignStatus !== 'all' && user.campaignStatus !== filters.campaignStatus)
      return false

    return true
  })
}

function isDefaultFilters(filters: FilterConfig): boolean {
  return (
    filters.tier === 'all' &&
    filters.signedUpDays === null &&
    filters.lastSignInDays === null &&
    filters.hasPurchase === null &&
    filters.campaignStatus === 'all'
  )
}

interface CampaignUserTableProps {
  campaignSlug: string
  users: CampaignUser[]
  statusOptions: { value: string; label: string }[]
  extraColumns?: CampaignColumnDef[]
  bulkActions?: CampaignAction[]
  emptyMessage?: string
}

export function CampaignUserTable({
  campaignSlug,
  users,
  statusOptions,
  extraColumns = [],
  bulkActions = [],
  emptyMessage = 'No users found.',
}: CampaignUserTableProps) {
  const router = useRouter()
  const savedViews = useSavedViews(campaignSlug)
  const [filters, setFilters] = useState<FilterConfig>({ ...DEFAULT_FILTERS })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmAction, setConfirmAction] = useState<CampaignAction | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionResult, setActionResult] = useState<{ success: number; failed: number; skipped?: number; error?: string } | null>(null)

  // Apply default view filters once loaded from localStorage
  const appliedInitial = useRef(false)
  useEffect(() => {
    if (savedViews.loaded && !appliedInitial.current) {
      appliedInitial.current = true
      setFilters(savedViews.initialFilters)
    }
  }, [savedViews.loaded, savedViews.initialFilters])

  // When user changes a filter manually, deactivate the current view
  function updateFilter(updater: (f: FilterConfig) => FilterConfig) {
    setFilters((prev) => {
      const next = updater(prev)
      savedViews.setActiveViewId(null)
      return next
    })
  }

  const filteredUsers = useMemo(() => applyFilters(users, filters), [users, filters])

  const allSelected = filteredUsers.length > 0 && filteredUsers.every((u) => selectedIds.has(u.id))

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredUsers.map((u) => u.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function executeAction(action: CampaignAction) {
    setActionLoading(true)
    setActionResult(null)
    try {
      const result = await action.onExecute(Array.from(selectedIds))
      setActionResult(result)
      setTimeout(() => {
        setConfirmAction(null)
        setActionResult(null)
        setSelectedIds(new Set())
        router.refresh()
      }, 1500)
    } catch (err) {
      setActionResult({ success: 0, failed: selectedIds.size, error: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setActionLoading(false)
    }
  }

  const hasBulkActions = bulkActions.length > 0

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          {/* Saved views bar */}
          <SavedViewsBar
            views={savedViews.views}
            activeViewId={savedViews.activeViewId}
            currentFilters={filters}
            onSelectView={(viewId) => {
              const newFilters = savedViews.selectView(viewId)
              setFilters(newFilters)
            }}
            onSave={(name) => savedViews.saveCurrentView(name, filters)}
            onDelete={(viewId) => savedViews.deleteView(viewId)}
            onRename={(viewId, name) => savedViews.renameView(viewId, name)}
            onUpdateFilters={(viewId) => {
              savedViews.updateViewFilters(viewId, filters)
              savedViews.setActiveViewId(viewId)
            }}
            onSetDefault={(viewId) => savedViews.setDefault(viewId)}
          />

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={filters.campaignStatus}
              onValueChange={(v) =>
                updateFilter((f) => ({ ...f, campaignStatus: v }))
              }
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.tier}
              onValueChange={(v) =>
                updateFilter((f) => ({
                  ...f,
                  tier: v as FilterConfig['tier'],
                }))
              }
            >
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue placeholder="Tier" />
              </SelectTrigger>
              <SelectContent>
                {TIER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.signedUpDays?.toString() ?? 'any'}
              onValueChange={(v) =>
                updateFilter((f) => ({
                  ...f,
                  signedUpDays: v === 'any' ? null : Number(v),
                }))
              }
            >
              <SelectTrigger className="h-8 w-[150px] text-xs">
                <SelectValue placeholder="Signed up" />
              </SelectTrigger>
              <SelectContent>
                {SIGNED_UP_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.lastSignInDays?.toString() ?? 'any'}
              onValueChange={(v) =>
                updateFilter((f) => ({
                  ...f,
                  lastSignInDays: v === 'any' ? null : Number(v),
                }))
              }
            >
              <SelectTrigger className="h-8 w-[160px] text-xs">
                <SelectValue placeholder="Last sign in" />
              </SelectTrigger>
              <SelectContent>
                {LAST_SIGN_IN_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={
                filters.hasPurchase === null
                  ? 'any'
                  : filters.hasPurchase
                    ? 'yes'
                    : 'no'
              }
              onValueChange={(v) =>
                updateFilter((f) => ({
                  ...f,
                  hasPurchase: v === 'any' ? null : v === 'yes',
                }))
              }
            >
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue placeholder="Purchases" />
              </SelectTrigger>
              <SelectContent>
                {PURCHASE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!isDefaultFilters(filters) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setFilters({ ...DEFAULT_FILTERS })
                  savedViews.setActiveViewId(null)
                }}
              >
                <X className="mr-1 h-3 w-3" />
                Clear
              </Button>
            )}

            <span className="ml-auto text-xs text-muted-foreground">
              {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {filteredUsers.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {hasBulkActions && (
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        className="h-3.5 w-3.5 rounded border-gray-300"
                      />
                    </TableHead>
                  )}
                  <TableHead>User</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Status</TableHead>
                  {extraColumns.map((col) => (
                    <TableHead key={col.key}>{col.header}</TableHead>
                  ))}
                  <TableHead>Last Sign In</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((user) => (
                  <TableRow key={user.id}>
                    {hasBulkActions && (
                      <TableCell className="w-8">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(user.id)}
                          onChange={() => toggleSelect(user.id)}
                          className="h-3.5 w-3.5 rounded border-gray-300"
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <UserCell
                        id={user.id}
                        email={user.email}
                        avatarUrl={user.avatarUrl}
                      />
                    </TableCell>
                    <TableCell>
                      <TierBadge tier={user.tier} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.campaignStatusVariant} className="text-xs">
                        {user.campaignStatus}
                      </Badge>
                    </TableCell>
                    {extraColumns.map((col) => (
                      <TableCell key={col.key}>{col.render(user)}</TableCell>
                    ))}
                    <TableCell
                      className="text-xs text-muted-foreground"
                      title={
                        user.lastSignInAt
                          ? new Date(user.lastSignInAt).toLocaleString()
                          : undefined
                      }
                    >
                      {user.lastSignInAt
                        ? formatRelativeTime(new Date(user.lastSignInAt))
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">{emptyMessage}</p>
          )}
        </CardContent>
      </Card>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && hasBulkActions && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-3 shadow-lg">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {selectedIds.size} user{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2">
              {bulkActions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant={action.variant ?? 'default'}
                  onClick={() => {
                    setConfirmAction(action)
                    setActionResult(null)
                  }}
                >
                  {action.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
              >
                <X className="mr-1 h-3 w-3" />
                Clear
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !actionLoading) {
            setConfirmAction(null)
            setActionResult(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmAction?.label}</DialogTitle>
          </DialogHeader>
          {actionResult ? (
            <div className="space-y-2">
              {actionResult.error ? (
                <p className="text-sm text-destructive">{actionResult.error}</p>
              ) : (
                <div className="space-y-1 text-sm">
                  {actionResult.success > 0 && (
                    <p className="text-green-600">{actionResult.success} sent successfully</p>
                  )}
                  {(actionResult.skipped ?? 0) > 0 && (
                    <p className="text-muted-foreground">{actionResult.skipped} skipped — already invited</p>
                  )}
                  {actionResult.failed > 0 && (
                    <p className="text-destructive">{actionResult.failed} failed — check server logs</p>
                  )}
                  {actionResult.success === 0 && (actionResult.skipped ?? 0) === 0 && actionResult.failed === 0 && (
                    <p className="text-muted-foreground">No users processed</p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {confirmAction?.description ??
                  `This will apply to ${selectedIds.size} selected user${selectedIds.size !== 1 ? 's' : ''}.`}
              </p>
              <p className="text-sm">
                Apply to <strong>{selectedIds.size}</strong> user
                {selectedIds.size !== 1 ? 's' : ''}?
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction(null)}
                  disabled={actionLoading}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant={confirmAction?.variant ?? 'default'}
                  onClick={() => confirmAction && executeAction(confirmAction)}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Processing...' : 'Confirm'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function TierBadge({ tier }: { tier: CampaignUser['tier'] }) {
  switch (tier) {
    case 'pro_paid':
      return (
        <Badge variant="default" className="gap-0.5 text-xs">
          <Crown className="h-2.5 w-2.5" />
          Pro
        </Badge>
      )
    case 'pro_granted':
      return (
        <Badge
          variant="outline"
          className="gap-0.5 border-purple-500/30 text-xs text-purple-600 dark:text-purple-400"
        >
          <Gift className="h-2.5 w-2.5" />
          Granted
        </Badge>
      )
    default:
      return (
        <Badge variant="secondary" className="text-xs">
          Free
        </Badge>
      )
  }
}
