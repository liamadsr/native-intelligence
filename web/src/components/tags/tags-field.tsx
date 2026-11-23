'use client'

/**
 * The Tags row of a record's properties panel, for any taggable kind: the
 * record's tags as pills (× takes one off), and "Add tag" opening a search of
 * the workspace's tags and yours, with "Create #name" at the end.
 *
 * Self-contained: it reads and writes through api/account/tags/on/[kind]/[id].
 * Wrap it in OptionalProperty with `set={tags.length > 0}` to get the panel's
 * row-or-chip behaviour (useRecordTags gives the count).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lock, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import type { LabelScope } from '@/lib/labels/utils'
import { addTagToRecord, createTag, removeTagFromRecord } from '@/lib/tags/client'
import { tagColorStore } from '@/lib/tags/color-store'
import type { TagKind } from '@/lib/tags/kinds'
import { normalizeTagName, sameTagName } from '@/lib/tags/names'
import { nextTagColor } from '@/lib/tags/palette'
import { TagPill, type PillTag } from './tag-pill'

export interface RecordTagsState {
  tags: PillTag[]
  loading: boolean
  add: (tag: PillTag) => Promise<void>
  remove: (tag: PillTag) => Promise<void>
  reload: () => void
}

/** The tags on one record, kept in step with the adds and removes made here. */
export function useRecordTags(kind: TagKind, id: string | null | undefined, initial?: PillTag[]): RecordTagsState {
  const [tags, setTags] = useState<PillTag[]>(initial ?? [])
  const [loading, setLoading] = useState(!initial && Boolean(id))
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/account/tags/on/${kind}/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d: { tags?: PillTag[] }) => {
        if (cancelled) return
        const next = d.tags ?? []
        tagColorStore.put(next.map((t) => ({ id: t.id, color: t.color })))
        setTags(next)
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [kind, id, nonce])

  const add = useCallback(
    async (tag: PillTag) => {
      if (!id) return
      setTags((t) => (t.some((x) => x.id === tag.id) ? t : [...t, tag].sort((a, b) => a.name.localeCompare(b.name))))
      try {
        await addTagToRecord(kind, id, tag.id)
      } catch (err) {
        setTags((t) => t.filter((x) => x.id !== tag.id))
        toast.error((err as Error).message || 'Could not add the tag')
      }
    },
    [kind, id],
  )

  const remove = useCallback(
    async (tag: PillTag) => {
      if (!id) return
      setTags((t) => t.filter((x) => x.id !== tag.id))
      try {
        await removeTagFromRecord(kind, id, tag.id)
      } catch (err) {
        setTags((t) => [...t, tag].sort((a, b) => a.name.localeCompare(b.name)))
        toast.error((err as Error).message || 'Could not remove the tag')
      }
    },
    [kind, id],
  )

  return { tags, loading, add, remove, reload: () => setNonce((n) => n + 1) }
}

export function TagsField({
  state,
  scope,
  readOnly = false,
  className,
}: {
  state: RecordTagsState
  scope?: LabelScope
  readOnly?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [personal, setPersonal] = useState(false)
  const [busy, setBusy] = useState(false)
  const { labels } = useScopedLabels(scope)
  const attached = new Set(state.tags.map((t) => t.id))

  const q = query.trim().toLowerCase()
  const options = useMemo(
    () => labels.filter((l) => !attached.has(l.id) && (!q || l.name.toLowerCase().includes(q))).slice(0, 30),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels, q, state.tags],
  )
  const createName = normalizeTagName(query)
  const canCreate = Boolean(createName) && !labels.some((l) => sameTagName(l.name, createName!))

  const create = async () => {
    if (!createName || busy) return
    setBusy(true)
    try {
      const label = await createTag({ name: createName, color: nextTagColor(createName, labels.map((l) => l.color)), personal })
      await state.add({ id: label.id, name: label.name, color: label.color, personal: Boolean(label.personal ?? personal) })
      setQuery('')
    } catch (err) {
      toast.error((err as Error).message || 'Could not create the tag')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)} data-tags-field="">
      {state.tags.map((t) => (
        <TagPill key={t.id} tag={t} onRemove={readOnly ? undefined : (tag) => void state.remove(tag)} />
      ))}
      {!readOnly && (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) setQuery('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
              aria-label="Add tag"
            >
              <Plus className="h-3 w-3" />
              {state.tags.length === 0 && 'Add tag'}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-1" align="start" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const first = options[0]
                  if (first && (!canCreate || sameTagName(first.name, query))) {
                    void state.add({ id: first.id, name: first.name, color: first.color, personal: first.personal })
                    setQuery('')
                  } else if (canCreate) void create()
                }
              }}
              placeholder="Find or create a tag"
              className="mb-1 w-full rounded-md border bg-transparent px-2 py-1 text-sm outline-none"
            />
            <div className="max-h-60 overflow-y-auto" role="listbox" aria-label="Tags">
              {options.map((l) => (
                <div
                  key={l.id}
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    void state.add({ id: l.id, name: l.name, color: l.color, personal: l.personal })
                    setQuery('')
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: l.color }} />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  {l.personal && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Only you" />}
                </div>
              ))}
              {canCreate && (
                <div className="mt-1 border-t pt-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void create()}
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60"
                  >
                    Create <span className="font-medium">#{createName}</span>
                  </button>
                  <label className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                    <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} />
                    Only me
                  </label>
                </div>
              )}
              {options.length === 0 && !canCreate && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{labels.length ? 'No other tags' : 'No tags yet'}</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
