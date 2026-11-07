'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Plus, Star, StarOff, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { filtersEqual } from '@/lib/saved-views'
import { DEFAULT_FILTERS } from '@/lib/campaign-types'
import type { FilterConfig, SavedFilterView } from '@/lib/campaign-types'

interface SavedViewsBarProps {
  views: SavedFilterView[]
  activeViewId: string | null
  currentFilters: FilterConfig
  onSelectView: (viewId: string | null) => void
  onSave: (name: string) => void
  onDelete: (viewId: string) => void
  onRename: (viewId: string, name: string) => void
  onUpdateFilters: (viewId: string) => void
  onSetDefault: (viewId: string | null) => void
}

export function SavedViewsBar({
  views,
  activeViewId,
  currentFilters,
  onSelectView,
  onSave,
  onDelete,
  onRename,
  onUpdateFilters,
  onSetDefault,
}: SavedViewsBarProps) {
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const createInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isCreating) createInputRef.current?.focus()
  }, [isCreating])

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  const isDefault = filtersEqual(currentFilters, DEFAULT_FILTERS)
  const matchesAnyView = views.some((v) => filtersEqual(v.filters, currentFilters))
  const showSaveButton = !isDefault && !matchesAnyView

  function handleCreate() {
    const trimmed = newName.trim()
    if (trimmed) {
      onSave(trimmed)
    }
    setNewName('')
    setIsCreating(false)
  }

  function handleRename(viewId: string) {
    const trimmed = renameValue.trim()
    if (trimmed) {
      onRename(viewId, trimmed)
    }
    setRenamingId(null)
    setRenameValue('')
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-2">
      {/* "All" pseudo-view */}
      <Button
        variant={activeViewId === null ? 'secondary' : 'outline'}
        size="sm"
        className="h-7 rounded-full px-3 text-xs"
        onClick={() => onSelectView(null)}
      >
        All
      </Button>

      {/* Saved view pills */}
      {views.map((view) => (
        <div key={view.id} className="flex items-center">
          {renamingId === view.id ? (
            <Input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(view.id)
                if (e.key === 'Escape') {
                  setRenamingId(null)
                  setRenameValue('')
                }
              }}
              onBlur={() => handleRename(view.id)}
              className="h-7 w-[140px] rounded-full px-3 text-xs"
            />
          ) : (
            <div className="flex items-center gap-0">
              <Button
                variant={activeViewId === view.id ? 'secondary' : 'outline'}
                size="sm"
                className="h-7 rounded-full rounded-r-none border-r-0 px-3 text-xs"
                onClick={() => onSelectView(view.id)}
              >
                {view.isDefault && <Star className="mr-1 h-3 w-3 fill-current" />}
                {view.name}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={activeViewId === view.id ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-7 rounded-full rounded-l-none px-1 text-xs"
                  >
                    <MoreHorizontal className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem
                    onClick={() => {
                      setRenamingId(view.id)
                      setRenameValue(view.name)
                    }}
                  >
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onUpdateFilters(view.id)}>
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    Update filters
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onSetDefault(view.isDefault ? null : view.id)}
                  >
                    {view.isDefault ? (
                      <>
                        <StarOff className="mr-2 h-3.5 w-3.5" />
                        Remove default
                      </>
                    ) : (
                      <>
                        <Star className="mr-2 h-3.5 w-3.5" />
                        Set as default
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDelete(view.id)}
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      ))}

      {/* Save view button / inline input */}
      {showSaveButton && (
        <>
          {isCreating ? (
            <Input
              ref={createInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') {
                  setIsCreating(false)
                  setNewName('')
                }
              }}
              onBlur={handleCreate}
              placeholder="View name..."
              className="h-7 w-[150px] rounded-full px-3 text-xs"
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
              onClick={() => setIsCreating(true)}
            >
              <Plus className="mr-1 h-3 w-3" />
              Save view
            </Button>
          )}
        </>
      )}
    </div>
  )
}
