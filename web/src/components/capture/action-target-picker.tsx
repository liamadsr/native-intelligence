'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

/**
 * The update-target action picker (One Accept Authority, W-4c) — the rescue
 * affordance for a TARGET-LESS `update:action` proposal. Such a proposal names no
 * action, so its accept can only dead-end on UPDATE_TARGET_UNRESOLVED; instead of
 * a one-click "Apply update" the card's primary action opens this picker, and the
 * chosen action becomes the update's target (the attention rail retries accept
 * with `target_entity_id`; the capture card persists `entity_id` via the proposal
 * edit endpoint, then applies).
 *
 * ONE component for both card surfaces (the attention rail card and the capture
 * detail panel's proposal card) so the rescue flow can't drift between them.
 * Searches `/api/account/actions` — the ACTIVE workspace's actions by default,
 * or a named workspace's when the caller passes `workspaceId` (the attention rail
 * is a cross-workspace queue, so its cards name their own).
 */

/** A minimal action row the picker offers (and hands back on pick). */
export interface ActionTargetOption {
  id: string
  identifier: string | null
  title: string | null
}

interface ActionTargetPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The user chose the action this update targets. The picker closes itself. */
  onPick: (action: ActionTargetOption) => void
  align?: 'start' | 'center' | 'end'
  /** Search THIS workspace's actions instead of the active one. The fetch
   *  interceptor only fills `x-workspace-id` in when the caller hasn't set it
   *  (lib/workspace-fetch.ts) and the server re-verifies membership on whatever
   *  arrives — so naming the workspace is all a cross-workspace card needs, with
   *  no new API parameter. Omitted → the active workspace, as before. */
  workspaceId?: string
  /** The trigger (the card's primary "Choose target" button). */
  children: React.ReactNode
}

export function ActionTargetPicker({
  open,
  onOpenChange,
  onPick,
  align = 'end',
  workspaceId,
  children,
}: ActionTargetPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ActionTargetOption[]>([])
  const [searching, setSearching] = useState(false)
  // Only the newest search paints: an older, slower answer must not land
  // under a newer query (and be picked as the update target).
  const searchSeqRef = useRef(0)

  const search = async (q: string) => {
    const seq = ++searchSeqRef.current
    setSearching(true)
    try {
      const trimmed = q.trim()
      const url = trimmed
        ? `/api/account/actions?scope=all&status=active&search=${encodeURIComponent(trimmed)}&limit=8`
        : `/api/account/actions?scope=all&status=active&limit=8`
      const res = await fetch(url, workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : undefined)
      if (seq !== searchSeqRef.current) return
      if (res.ok) {
        const data = await res.json()
        if (seq !== searchSeqRef.current) return
        setResults(
          ((data.actions ?? []) as ActionTargetOption[]).map((a) => ({
            id: a.id,
            identifier: a.identifier ?? null,
            title: a.title ?? null,
          })),
        )
      }
    } finally {
      if (seq === searchSeqRef.current) setSearching(false)
    }
  }

  // Load initial results each time the picker opens (an empty query shows a few
  // recent actions so the picker is never blank). Keyed only on the open flag:
  // `search` is a fresh render function, so depending on it would re-run every
  // render — the intended trigger is the picker opening.
  // The input starts empty too, so it matches the list it shows.
  useEffect(() => {
    if (!open) return
    setQuery('')
    void search('')
  }, [open])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align={align}>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search actions to update…"
            value={query}
            onValueChange={(v) => {
              setQuery(v)
              void search(v)
            }}
          />
          <CommandList>
            <CommandEmpty>{searching ? 'Searching…' : 'No matching actions'}</CommandEmpty>
            <CommandGroup>
              {results.map((a) => (
                <CommandItem
                  key={a.id}
                  value={a.id}
                  onSelect={() => {
                    onOpenChange(false)
                    onPick(a)
                  }}
                >
                  <Search className="mr-2 h-3 w-3 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{a.title || 'Untitled action'}</span>
                    {a.identifier && (
                      <span className="text-[10px] text-muted-foreground">{a.identifier}</span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
