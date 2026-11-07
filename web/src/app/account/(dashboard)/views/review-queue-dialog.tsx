'use client'

/**
 * Review queue popup — the in-dashboard, centered-modal replacement for the
 * standalone /account/wiki/review page. Opened from the "Review queue" button
 * on the Knowledge library so the user reviews pending knowledge WITHOUT being
 * dumped onto a full-screen route with no way back.
 *
 * Fetches the pending payload (suggested claims + their evidence, draft wiki
 * pages) on open from /api/account/knowledge/review, and reuses the same
 * confirm / dismiss / supersede endpoints the standalone page uses. Resolving a
 * claim removes it from the list; a live count sits in the header.
 */

import { useCallback, useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { ListChecks, FileText } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

interface SourceEntry {
  type: string
  id: string | null
  uri: string | null
  excerpt: string | null
}

interface ClaimWithSources {
  id: string
  text: string
  type: string
  confidence: number | null
  created_at: string
  sources: SourceEntry[]
}

interface DraftDoc {
  id: string
  title: string
  slug: string | null
  type: string
  updated_at: string
}

type ClaimResolution = 'pending' | 'editing'

export function ReviewQueueDialog({
  suggestedClaims,
  children,
}: {
  /** Count shown on the trigger badge before the payload loads. */
  suggestedClaims: number
  /** The trigger. Rendered inside DialogTrigger asChild. */
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [claims, setClaims] = useState<ClaimWithSources[] | null>(null)
  const [drafts, setDrafts] = useState<DraftDoc[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [resolutions, setResolutions] = useState<Record<string, ClaimResolution>>({})
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/account/knowledge/review')
      if (!res.ok) throw new Error(`Failed (${res.status})`)
      const json = (await res.json()) as { claims: ClaimWithSources[]; drafts: DraftDoc[] }
      setClaims(json.claims ?? [])
      setDrafts(json.drafts ?? [])
    } catch {
      setError('Couldn’t load the review queue. Try again.')
      setClaims([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch each time the popup opens (a pull surface, not a live subscription).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) {
        setResolutions({})
        setEditValues({})
        void load()
      }
    },
    [load],
  )

  const setStatus = (id: string, status: ClaimResolution) =>
    setResolutions((r) => ({ ...r, [id]: status }))

  const callClaim = async (id: string, action: 'confirm' | 'dismiss', body?: object) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`/api/account/claims/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Failed (${res.status})`)
      }
      return true
    } catch (err) {
      console.error('claim action failed', err)
      return false
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }

  const confirm = async (id: string) => {
    if (!(await callClaim(id, 'confirm'))) return
    setClaims((cs) => (cs ? cs.filter((c) => c.id !== id) : cs))
  }

  const dismiss = async (id: string) => {
    if (!(await callClaim(id, 'dismiss'))) return
    setClaims((cs) => (cs ? cs.filter((c) => c.id !== id) : cs))
  }

  const startEdit = (claim: ClaimWithSources) => {
    setEditValues((v) => ({ ...v, [claim.id]: claim.text }))
    setStatus(claim.id, 'editing')
  }

  const saveEdit = async (claim: ClaimWithSources) => {
    const newText = editValues[claim.id]?.trim()
    if (!newText) return
    setBusy((b) => ({ ...b, [claim.id]: true }))
    try {
      const res = await fetch(`/api/account/claims/${claim.id}/supersede`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_text: newText }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `Failed (${res.status})`)
      }
      setClaims((cs) => (cs ? cs.filter((c) => c.id !== claim.id) : cs))
    } catch (err) {
      console.error('claim action failed', err)
    } finally {
      setBusy((b) => ({ ...b, [claim.id]: false }))
    }
  }

  // Keep the header count truthful once loaded; fall back to the passed-in prop.
  const pendingCount = claims?.length ?? suggestedClaims

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 space-y-1 border-b px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            Review queue
            {pendingCount > 0 && (
              <span className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                {pendingCount}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Pending knowledge from captures, ingested sources, and the agent.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-8 px-5 py-4">
            {loading && claims === null ? (
              <div className="flex items-center justify-center py-16">
                <ThinkingOrb state="solving" size={20} theme="auto" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : (
              <>
                {/* Suggested claims */}
                <section>
                  <h3 className="mb-3 flex items-baseline gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Suggested claims
                    <span className="font-mono normal-case tracking-normal">· {claims?.length ?? 0}</span>
                  </h3>
                  {!claims || claims.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                      Nothing pending. Suggested claims show up here as captures process and
                      sources are ingested.
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {claims.map((c) => {
                        const isEditing = resolutions[c.id] === 'editing'
                        const isBusy = busy[c.id]
                        return (
                          <li key={c.id} className="rounded-md border border-border bg-card p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                {isEditing ? (
                                  <Textarea
                                    value={editValues[c.id] ?? c.text}
                                    onChange={(e) =>
                                      setEditValues((v) => ({ ...v, [c.id]: e.target.value }))
                                    }
                                    rows={3}
                                    className="text-sm"
                                  />
                                ) : (
                                  <p className="text-sm leading-snug">{c.text}</p>
                                )}
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{c.type}</span>
                                  {c.confidence !== null && (
                                    <span>conf {(c.confidence * 100).toFixed(0)}%</span>
                                  )}
                                  <span>·</span>
                                  <time>{new Date(c.created_at).toLocaleString()}</time>
                                </div>
                                {c.sources.length > 0 && (
                                  <ul className="mt-3 space-y-1 border-l border-border pl-3 text-xs text-muted-foreground">
                                    {c.sources.map((s, i) => (
                                      <li key={i}>
                                        <span className="font-mono text-[10px]">{s.type}</span>{' '}
                                        {s.excerpt ? `"${s.excerpt}"` : s.uri || s.id || ''}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              <div className="flex shrink-0 flex-col gap-1.5">
                                {isEditing ? (
                                  <>
                                    <Button size="sm" disabled={isBusy} onClick={() => saveEdit(c)}>
                                      Save
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setStatus(c.id, 'pending')}
                                    >
                                      Cancel
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button size="sm" disabled={isBusy} onClick={() => confirm(c.id)}>
                                      Confirm
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={isBusy}
                                      onClick={() => startEdit(c)}
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={isBusy}
                                      onClick={() => dismiss(c.id)}
                                    >
                                      Dismiss
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                {/* Page drafts */}
                {drafts.length > 0 && (
                  <section>
                    <h3 className="mb-3 flex items-baseline gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Page drafts
                      <span className="font-mono normal-case tracking-normal">· {drafts.length}</span>
                    </h3>
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {drafts.map((d) => (
                        <li
                          key={d.id}
                          className="flex items-baseline justify-between gap-4 px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate text-sm font-medium">
                                {d.title || '(untitled)'}
                              </span>
                              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                {d.type}
                              </span>
                            </div>
                            {d.slug && (
                              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                                [[{d.slug}]]
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {new Date(d.updated_at).toISOString().slice(0, 10)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
