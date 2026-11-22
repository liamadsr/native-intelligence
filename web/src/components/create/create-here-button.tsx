'use client'

/**
 * "New …" on a record's own header (a project, an initiative, a company, a
 * deal): the one Create composer, preset to a type and to this place, so what
 * is made is linked to it ("Create in <name>", lib/create/create-context.ts).
 * One type: a + button; several: a + menu naming each.
 */
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EntityIcon } from '@/components/entities/entity-icon'
import { createTypeDef, type CreateTypeId } from '@/lib/create/create-types'
import { containerLabel, type CreateContainer } from '@/lib/create/create-context'
import { openCreateDialog } from '@/lib/create/open-create'

export function CreateHereButton({ container, types }: { container: CreateContainer; types: readonly CreateTypeId[] }) {
  if (types.length === 0) return null
  const open = (type: CreateTypeId) => openCreateDialog({ type, context: { container } })
  const trigger = (label: string, onClick?: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
      title={label}
      aria-label={label}
      data-create-here={container.kind}
      onClick={onClick}
    >
      <Plus className="h-3.5 w-3.5" />
    </Button>
  )
  if (types.length === 1) {
    const only = types[0]
    return trigger(`New ${createTypeDef(only).label.toLowerCase()} in ${container.name}`, () => open(only))
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger(containerLabel(container))}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{containerLabel(container)}</DropdownMenuLabel>
        {types.map((type) => (
          <DropdownMenuItem key={type} data-create-here-type={type} onSelect={() => open(type)} className="gap-2">
            <EntityIcon kind={type} size="sm" strokeWidth={2} />
            New {createTypeDef(type).label.toLowerCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
