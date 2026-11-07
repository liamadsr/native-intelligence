'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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

type ClaimResolution = 'pending' | 'confirmed' | 'dismissed' | 'editing'

export function ReviewClient({
  initialClaims,
  initialDrafts,
}: {
  initialClaims: ClaimWithSources[]
  initialDrafts: DraftDoc[]
}) {
  const router = useRouter()
  const [claims, setClaims] = useState<ClaimWithSources[]>(initialClaims)
  const [resolutions, setResolutions] = useState<Record<string, ClaimResolution>>({})
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})

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
    setStatus(id, 'confirmed')
    setClaims((cs) => cs.filter((c) => c.id !== id))
  }

  const dismiss = async (id: string) => {
    if (!(await callClaim(id, 'dismiss'))) return
    setStatus(id, 'dismissed')
    setClaims((cs) => cs.filter((c) => c.id !== id))
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
      setClaims((cs) => cs.filter((c) => c.id !== claim.id))
    } catch (err) {
      console.error('claim action failed', err)
    } finally {
      setBusy((b) => ({ ...b, [claim.id]: false }))
    }
  }

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 flex items-baseline gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Suggested claims
          <span className="font-mono normal-case tracking-normal">· {claims.length}</span>
        </h2>
        {claims.length === 0 ? (
          <div className="rounded border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing pending. Suggested claims show up here as captures process and sources are ingested.
          </div>
        ) : (
          <ul className="space-y-3">
            {claims.map((c) => {
              const status = resolutions[c.id] ?? 'pending'
              const isBusy = busy[c.id]
              return (
                <li
                  key={c.id}
                  className={cn(
                    'rounded-md border border-border p-4 transition-colors',
                    status === 'pending' ? 'bg-card' : 'bg-muted/40',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {status === 'editing' ? (
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
                      {status === 'editing' ? (
                        <>
                          <Button
                            size="sm"
                            disabled={isBusy}
                            onClick={() => saveEdit(c)}
                          >
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
                          <Button
                            size="sm"
                            disabled={isBusy}
                            onClick={() => confirm(c.id)}
                          >
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

      <section>
        <h2 className="mb-3 flex items-baseline gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Page drafts
          <span className="font-mono normal-case tracking-normal">· {initialDrafts.length}</span>
        </h2>
        {initialDrafts.length === 0 ? (
          <div className="rounded border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No page drafts pending.
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {initialDrafts.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/account/wiki/${d.id}`}
                  className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-muted/50"
                  onClick={() => router.prefetch(`/account/wiki/${d.id}`)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{d.title || '(untitled)'}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {d.type}
                      </span>
                    </div>
                    {d.slug && <div className="mt-0.5 font-mono text-xs text-muted-foreground">[[{d.slug}]]</div>}
                  </div>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {new Date(d.updated_at).toISOString().slice(0, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
