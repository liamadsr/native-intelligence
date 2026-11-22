'use client'

/**
 * The Create menu (owner, 11-22: Macro's one Create menu): what C and the
 * rail's + open. Every type the workspace can make, grouped as the rail
 * groups its pages, each with its letter; type to filter, ↑↓ and ↵ pick,
 * or C then a letter goes straight to a type (lib/create/create-keys.ts:
 * the menu reads that letter as its first key, soon after it opened, while
 * nothing is typed). Picking opens the type's composer in the same dialog.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { CREATE_TYPE_GROUPS, type CreateTypeDef, type CreateTypeId } from '@/lib/create/create-types'
import { CREATE_LETTERS, createTypeForLetter, isCreateLetterKey } from '@/lib/create/create-keys'
import { containerLabel, type CreateContainer } from '@/lib/create/create-context'

export interface CreateMenuOption extends CreateTypeDef {
  icon: ReactNode
}

export function CreateMenu({
  options,
  onPick,
  openedAt,
  container,
}: {
  options: CreateMenuOption[]
  onPick: (id: CreateTypeId) => void
  /** When the menu opened (Date.now()): a letter right after goes straight to its type. */
  openedAt: number
  /** The place it was opened in, said on top ("Create in <name>"). */
  container?: CreateContainer | null
}) {
  const [search, setSearch] = useState('')
  const groups = CREATE_TYPE_GROUPS.map((g) => ({ ...g, options: options.filter((o) => o.group === g.id) })).filter((g) => g.options.length > 0)
  const available = useRef(options.map((o) => o.id))
  available.current = options.map((o) => o.id)

  return (
    <Command
      data-create-menu=""
      className="rounded-none bg-transparent"
      // Match on the label and keywords, not the id.
      filter={(itemValue, q) => (itemValue.toLowerCase().includes(q.trim().toLowerCase()) ? 1 : 0)}
    >
      <div className="flex items-center gap-2 px-1">
        <CommandInput
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder={container ? `${containerLabel(container)}…` : 'Create…'}
          aria-label="Create"
          data-create-menu-search=""
          className="h-11 text-sm"
          onKeyDown={(e) => {
            if (!isCreateLetterKey(e, { search, openedAt })) return
            const id = createTypeForLetter(e.key, available.current)
            if (!id) return
            e.preventDefault()
            onPick(id)
          }}
        />
      </div>
      <CommandList className="max-h-[min(440px,60vh)]">
        <CommandEmpty>Nothing to create by that name</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.id} heading={g.label}>
            {g.options.map((opt) => {
              const letter = CREATE_LETTERS[opt.id]
              return (
                <CommandItem
                  key={opt.id}
                  value={[opt.label, ...(opt.keywords ?? [])].join(' ')}
                  data-create-menu-type={opt.id}
                  onSelect={() => onPick(opt.id)}
                  className="gap-2"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">{opt.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{opt.label}</span>
                  {opt.opensPage && <span className="shrink-0 text-[10px] text-muted-foreground">Opens page</span>}
                  {letter ? (
                    <kbd
                      aria-label={`C then ${letter.toUpperCase()}`}
                      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border bg-muted/60 px-1 font-sans text-[10px] font-medium text-muted-foreground"
                    >
                      {letter.toUpperCase()}
                    </kbd>
                  ) : (
                    <span aria-hidden className="h-5 w-5 shrink-0" />
                  )}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        <span>Type to filter · ↵ to pick</span>
        <span>C then a letter goes straight there</span>
      </div>
    </Command>
  )
}
