'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface DocumentOption {
  id: string
  title: string
}

/**
 * A popover that searches a list of documents by title and hands back the
 * picked id. The trigger is a full-width row ("+ <label>"). Used by an action's
 * Documents row and the Product facts card in Settings → Workspace.
 */
export function DocumentSearchPicker({
  open,
  onOpenChange,
  documents,
  onSelect,
  label = 'Link document',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  documents: DocumentOption[]
  onSelect: (id: string) => void
  /** The trigger row's text. */
  label?: string
}) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setSearch('')
      const timer = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [open])

  const filtered = search.trim()
    ? documents.filter((d) => d.title.toLowerCase().includes(search.toLowerCase()))
    : documents

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
          <Plus className="h-4 w-4 shrink-0" />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        align="start"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <div className="flex items-center border-b border-border px-3">
          <FileText className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-8 w-full bg-transparent py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted-foreground">No documents found</div>
          ) : (
            filtered.map((d) => (
              <button
                key={d.id}
                onClick={() => onSelect(d.id)}
                className="flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-xs text-left text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
