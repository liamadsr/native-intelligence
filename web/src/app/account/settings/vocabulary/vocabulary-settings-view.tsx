'use client'

/**
 * Settings → Vocabulary (docs/plans/custom-vocabulary.md §10): the names and
 * terms Native Intelligence has learned, so transcripts, dictation and voice mode spell them
 * right (src/lib/vocabulary/sound-match.ts).
 *
 * Nothing to set up or approve (Liam, 2026-10-24: "the less configuration the
 * user has to do, the better"). Words come from what Native Intelligence already knows
 * (teammates, projects, contacts and their companies), what the team writes
 * (src/lib/vocabulary/harvest.ts), and anything someone asked Native Intelligence to add.
 * The one thing to do here is remove a word it got wrong: one tap, with Undo.
 * Removing a learned word hides it for you; removing one someone added deletes it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { invalidateVocabulary } from '@/lib/vocabulary/client'
import type { AutomaticKind, AutomaticTerm, VocabularyTerm } from '@/lib/vocabulary/store'

interface Loaded {
  terms: VocabularyTerm[]
  automatic: AutomaticTerm[]
}

/** One word in the list, and how it goes away. */
export interface LearnedWord {
  term: string
  /** Person, Company or Project for a name Native Intelligence knows; empty for a term. */
  label: string
  /** A word someone added (by hand or by asking Native Intelligence): removing deletes it. */
  added?: VocabularyTerm
}

const KIND_LABEL: Record<AutomaticKind, string> = {
  teammate: 'Person',
  contact: 'Person',
  company: 'Company',
  project: 'Project',
}

const PAGE = 50
const SEARCH_FROM = 15

async function call<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<{ ok: boolean; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    return { ok: res.ok, data }
  } catch {
    return { ok: false, data: { error: 'Network error' } as T & { error?: string } }
  }
}

/**
 * Everything transcription will use, once each: words people added first, then
 * the ones learned from what the team writes, then the names Native Intelligence knows.
 * Anything this person removed is left out. Pure.
 */
export function learnedWords(data: Loaded): LearnedWord[] {
  const removed = new Set(data.terms.filter((t) => t.status === 'dismissed' && t.source === 'auto').map((t) => t.term.toLowerCase()))
  const seen = new Set<string>()
  const out: LearnedWord[] = []
  const push = (w: LearnedWord) => {
    const key = w.term.toLowerCase()
    if (seen.has(key) || (!w.added && removed.has(key))) return
    seen.add(key)
    out.push(w)
  }
  const active = data.terms.filter((t) => t.status === 'active')
  for (const t of active) if (t.source === 'manual' || t.source === 'agent') push({ term: t.term, label: '', added: t })
  for (const t of active) if (t.source === 'workspace') push({ term: t.term, label: '' })
  for (const a of data.automatic) push({ term: a.term, label: KIND_LABEL[a.kind] })
  return out
}

export function VocabularySettingsView() {
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const load = useCallback(async () => {
    const res = await call<Loaded>('/api/account/vocabulary')
    if (!res.ok) {
      setLoadError(res.data.error ?? 'Could not load your vocabulary')
      return
    }
    setLoadError(null)
    setData({ terms: res.data.terms ?? [], automatic: res.data.automatic ?? [] })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const words = useMemo(() => (data ? learnedWords(data) : []), [data])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? words.filter((w) => w.term.toLowerCase().includes(q)) : words
  }, [words, query])

  /** After a change: refresh the list and what transcription uses. */
  const refresh = useCallback(async () => {
    await Promise.all([load(), invalidateVocabulary()])
  }, [load])

  const remove = useCallback(
    async (w: LearnedWord) => {
      // Gone from the list at once; put back if the server says no.
      setData((d) =>
        d && {
          terms: w.added
            ? d.terms.filter((t) => t.id !== w.added?.id)
            : [...d.terms, { term: w.term, status: 'dismissed', source: 'auto' } as VocabularyTerm],
          automatic: d.automatic,
        },
      )
      const res = w.added
        ? await call(`/api/account/vocabulary/${w.added.id}`, { method: 'DELETE' })
        : await call<{ term?: VocabularyTerm }>('/api/account/vocabulary', { method: 'POST', body: JSON.stringify({ term: w.term, hide: true }) })
      if (!res.ok) {
        toast.error(res.data.error ?? 'Could not remove the word')
        await load()
        return
      }
      const hiddenRow = (res.data as { term?: VocabularyTerm }).term
      void refresh()
      toast.success(`Removed “${w.term}”`, {
        action: {
          label: 'Undo',
          onClick: () =>
            void (async () => {
              const back = w.added
                ? await call('/api/account/vocabulary', {
                    method: 'POST',
                    body: JSON.stringify({ term: w.added.term, sounds_like: w.added.soundsLike, scope: w.added.scope }),
                  })
                : hiddenRow
                  ? await call(`/api/account/vocabulary/${hiddenRow.id}`, { method: 'DELETE' })
                  : { ok: false, data: { error: 'Could not undo' } }
              if (!back.ok) toast.error(back.data.error ?? 'Could not undo')
              await refresh()
            })(),
        },
      })
    },
    [load, refresh],
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Vocabulary</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Native Intelligence learns the names and terms you use and spells them right in transcripts, getting better as you work. Remove anything it got wrong.
        </p>

        {loadError && <p className="mt-8 text-sm text-destructive">{loadError}</p>}

        {!data && !loadError && (
          <div className="mt-8 space-y-2" aria-label="Loading">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {data && words.length === 0 && (
          <p className="mt-8 text-sm text-muted-foreground">Nothing yet. Words appear here as Native Intelligence learns them.</p>
        )}

        {data && words.length > 0 && (
          <section className="mt-8">
            {words.length >= SEARCH_FROM && (
              <Input
                aria-label="Search words"
                placeholder={`Search ${words.length.toLocaleString()} words`}
                className="mb-3 h-8"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setLimit(PAGE)
                }}
              />
            )}
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No words match.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {shown.slice(0, limit).map((w) => (
                  <li key={w.term.toLowerCase()} data-testid="vocabulary-word" className="group flex items-center gap-3 px-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">{w.term}</span>
                    {w.label && <span className="shrink-0 text-xs text-muted-foreground">{w.label}</span>}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${w.term}`}
                      className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => void remove(w)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {shown.length > limit && (
              <Button size="sm" variant="ghost" className="mt-2 h-7 px-2 text-xs text-muted-foreground" onClick={() => setLimit((n) => n + PAGE * 4)}>
                Show more
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
