'use client'

import { useMemo, useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Bug, ChevronUp, Lightbulb, Lock, MessageSquare, Search, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AdminFeatureRequest {
  id: string
  title: string
  description: string | null
  type: string
  visibility: string
  status: string
  vote_count: number
  comment_count: number
  created_at: string
  user_email: string | null
}

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'declined', label: 'Declined' },
] as const

const STATUS_DOT: Record<string, string> = {
  open: 'bg-muted-foreground',
  planned: 'bg-blue-500',
  in_progress: 'bg-amber-500',
  completed: 'bg-emerald-500',
  declined: 'bg-rose-500',
}

const TYPE_OPTIONS = [
  { value: 'feedback', label: 'Feedback' },
  { value: 'feature_request', label: 'Feature requests' },
  { value: 'bug', label: 'Bugs' },
] as const

const TYPE_META: Record<string, { label: string; icon: LucideIcon; className: string }> = {
  feedback: {
    label: 'Feedback',
    icon: MessageSquare,
    className: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
  feature_request: {
    label: 'Feature',
    icon: Lightbulb,
    className: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  bug: {
    label: 'Bug',
    icon: Bug,
    className: 'border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400',
  },
}

function AdminTypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? TYPE_META.feedback
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        meta.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </span>
  )
}

export function FeatureRequestsTable({
  initialRequests,
}: {
  initialRequests: AdminFeatureRequest[]
}) {
  const [requests, setRequests] = useState(initialRequests)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return requests.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (typeFilter !== 'all' && r.type !== typeFilter) return false
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (
        r.title.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false) ||
        (r.user_email?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [requests, search, statusFilter, typeFilter])

  async function updateStatus(id: string, status: string) {
    const previous = requests.find((r) => r.id === id)?.status
    // Optimistic update.
    setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)))
    setSavingId(id)
    setError(null)
    try {
      const res = await fetch('/api/admin/feature-requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to update status')
    } catch (err: unknown) {
      // Roll back on failure.
      if (previous) {
        setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status: previous } : r)))
      }
      setError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div>
      {/* Controls */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search title, body, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72 pl-9"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {TYPE_OPTIONS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {filtered.length} of {requests.length}
        </span>
      </div>

      {error && (
        <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20 text-center">Votes</TableHead>
              <TableHead>Request</TableHead>
              <TableHead className="w-48">Submitted by</TableHead>
              <TableHead className="w-44">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                  No feature requests match.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-center align-top">
                    <div className="inline-flex flex-col items-center text-muted-foreground">
                      <ChevronUp className="h-4 w-4" />
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        {r.vote_count}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-center gap-2">
                      <AdminTypeBadge type={r.type} />
                      {r.visibility === 'private' && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <Lock className="h-2.5 w-2.5" />
                          Private
                        </span>
                      )}
                      <span className="font-medium">{r.title}</span>
                    </div>
                    {r.description && (
                      <div className="mt-0.5 line-clamp-2 max-w-xl text-sm text-muted-foreground">
                        {r.description}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        {r.comment_count}
                      </span>
                      <span>{new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {r.user_email ?? '—'}
                  </TableCell>
                  <TableCell className="align-top">
                    <Select
                      value={r.status}
                      onValueChange={(v) => updateStatus(r.id, v)}
                      disabled={savingId === r.id}
                    >
                      <SelectTrigger className="w-40">
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              'h-2 w-2 rounded-full',
                              STATUS_DOT[r.status] ?? 'bg-muted-foreground',
                            )}
                          />
                          <SelectValue />
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
