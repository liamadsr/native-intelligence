'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Tag,
  Check,
  Plus,
  Trash2,
  MoreHorizontal,
  Search,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Pencil,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import {
  ALL_LABEL_SCOPES,
  groupLabelsByGroupName,
  type LabelScope,
  type LabelWithScope,
} from '@/lib/labels/utils'
import {
  emitEntityCreated,
  emitEntityUpdated,
  emitEntityDeleted,
} from '@/lib/entity-events'
import { format } from 'date-fns'
import { toast } from 'sonner'

const COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f43f5e', '#6b7280', '#78716c', '#0ea5e9',
]

export function LabelsSettingsView() {
  const [labels, setLabels] = useState<LabelWithScope[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filterText, setFilterText] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Create form state
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState('#3b82f6')
  const [newLabelGroup, setNewLabelGroup] = useState('')
  const [newLabelScopes, setNewLabelScopes] = useState<LabelScope[]>([])
  const [addingLabel, setAddingLabel] = useState(false)
  const [labelError, setLabelError] = useState('')

  const filteredLabels = useMemo(() => {
    if (!filterText) return labels
    const lower = filterText.toLowerCase()
    return labels.filter(
      (l) =>
        l.name.toLowerCase().includes(lower) ||
        (l.group_name && l.group_name.toLowerCase().includes(lower)),
    )
  }, [labels, filterText])

  const grouped = useMemo(() => groupLabelsByGroupName(filteredLabels), [filteredLabels])
  const existingGroups = useMemo(
    () => Array.from(new Set(labels.map((l) => l.group_name).filter(Boolean))) as string[],
    [labels],
  )

  useEffect(() => {
    fetchLabels()
  }, [])

  async function fetchLabels() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/account/labels')
      if (res.ok) {
        const data = await res.json()
        setLabels(data.labels)
      }
    } finally {
      setIsLoading(false)
    }
  }

  function resetCreateForm() {
    setNewLabelName('')
    setNewLabelColor('#3b82f6')
    setNewLabelGroup('')
    setNewLabelScopes([])
    setLabelError('')
  }

  async function handleAddLabel() {
    const name = newLabelName.trim()
    if (!name) return

    setAddingLabel(true)
    setLabelError('')
    try {
      const res = await fetch('/api/account/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          color: newLabelColor,
          group_name: newLabelGroup.trim() || null,
          scopes: newLabelScopes.length > 0 ? newLabelScopes : null,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to create label')
      }
      const data = await res.json()
      setLabels((prev) => [...prev, data.label])
      // Update same-tab pickers immediately (and other tabs via BroadcastChannel)
      // instead of waiting for the realtime echo.
      emitEntityCreated({ entityType: 'label', id: data.label.id })
      resetCreateForm()
      setShowCreateDialog(false)
    } catch (err) {
      setLabelError(err instanceof Error ? err.message : 'Failed to create label')
    } finally {
      setAddingLabel(false)
    }
  }

  async function handleUpdateLabel(id: string, updates: Partial<LabelWithScope>) {
    setLabels((prev) => prev.map((l) => (l.id === id ? { ...l, ...updates } : l)))
    try {
      const res = await fetch(`/api/account/labels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (res.ok) {
        const data = await res.json()
        setLabels((prev) => prev.map((l) => (l.id === id ? data.label : l)))
        // Refresh same-tab pickers with the rename/recolor/scope change.
        emitEntityUpdated({ entityType: 'label', id, fields: data.label })
      } else {
        // Non-ok: re-sync with the server and surface the failure.
        toast.error('Failed to update label')
        fetchLabels()
      }
    } catch {
      toast.error('Failed to update label')
      fetchLabels()
    }
  }

  async function handleDeleteLabel(id: string) {
    setLabels((prev) => prev.filter((l) => l.id !== id))
    try {
      const res = await fetch(`/api/account/labels/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error('Failed to delete label')
        fetchLabels()
        return
      }
      // Drop the option from same-tab pickers immediately.
      emitEntityDeleted({ entityType: 'label', id })
    } catch {
      toast.error('Failed to delete label')
      fetchLabels()
    }
  }

  /**
   * Set group_name on every label of a group (one PATCH each). Other pickers
   * hear only about the labels that saved; any failure (a non-OK response or
   * a network error) toasts and refetches so the list shows the server's truth.
   */
  async function patchGroupName(labelsInGroup: LabelWithScope[], groupName: string | null, failMessage: string) {
    const results = await Promise.allSettled(
      labelsInGroup.map((l) =>
        fetch(`/api/account/labels/${l.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_name: groupName }),
        }),
      ),
    )
    let failed = false
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.ok) {
        emitEntityUpdated({ entityType: 'label', id: labelsInGroup[i].id, fields: { group_name: groupName } })
      } else {
        failed = true
      }
    })
    if (failed) {
      toast.error(failMessage)
      fetchLabels()
    }
  }

  async function handleRenameGroup(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    const labelsInGroup = labels.filter((l) => l.group_name === oldName)
    setLabels((prev) =>
      prev.map((l) => (l.group_name === oldName ? { ...l, group_name: trimmed } : l)),
    )
    await patchGroupName(labelsInGroup, trimmed, 'Failed to rename group')
  }

  async function handleDeleteGroup(groupName: string) {
    const labelsInGroup = labels.filter((l) => l.group_name === groupName)
    setLabels((prev) =>
      prev.map((l) => (l.group_name === groupName ? { ...l, group_name: null } : l)),
    )
    await patchGroupName(labelsInGroup, null, 'Failed to ungroup labels')
  }

  function toggleGroupCollapse(groupName: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupName)) next.delete(groupName)
      else next.add(groupName)
      return next
    })
  }

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          <Skeleton className="h-8 w-48" />
          <div className="mt-6 space-y-1">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        {/* Header */}
        <h1 className="text-2xl font-bold">Labels</h1>

        {/* Toolbar */}
        <div className="mt-5 flex items-center gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter by name..."
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetCreateForm()
                setShowCreateDialog(true)
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New label
            </Button>
          </div>
        </div>

        {/* Column headers */}
        <div className="mt-4 flex items-center border-b px-3 pb-2 text-xs font-medium text-muted-foreground select-none">
          <span className="flex-1 pl-8">Name</span>
          <span className="w-32 text-center">Visible in</span>
          <span className="w-24 text-right">Created</span>
          <span className="w-9" />
        </div>

        {/* Rows */}
        {filteredLabels.length > 0 ? (
          <div>
            {grouped.map((group) => {
              const isNamed = group.groupName !== null
              const isCollapsed = isNamed && collapsedGroups.has(group.groupName!)

              return (
                <div key={group.groupName ?? '__ungrouped'}>
                  {/* Group row — looks like a table row with a different icon */}
                  {isNamed && (
                    <GroupRow
                      name={group.groupName!}
                      count={group.labels.length}
                      isCollapsed={isCollapsed}
                      onToggleCollapse={() => toggleGroupCollapse(group.groupName!)}
                      onRename={(newName) => handleRenameGroup(group.groupName!, newName)}
                      onDelete={() => handleDeleteGroup(group.groupName!)}
                    />
                  )}

                  {/* Child labels — indented if in a group */}
                  {!isCollapsed &&
                    group.labels.map((label, idx) => (
                      <LabelRow
                        key={label.id}
                        label={label}
                        indented={isNamed}
                        isLast={idx === group.labels.length - 1}
                        existingGroups={existingGroups}
                        onUpdate={handleUpdateLabel}
                        onDelete={handleDeleteLabel}
                      />
                    ))}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="py-16 text-center">
            <Tag className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              {filterText ? 'No labels match your filter.' : 'No labels yet.'}
            </p>
            {!filterText && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  resetCreateForm()
                  setShowCreateDialog(true)
                }}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create your first label
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Create label dialog */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          setShowCreateDialog(open)
          if (!open) resetCreateForm()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New label</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label htmlFor="create-label-name" className="text-sm">Name</Label>
                <Input
                  id="create-label-name"
                  autoFocus
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !addingLabel) handleAddLabel()
                  }}
                  placeholder="e.g. Bug, Feature, Urgent"
                  className="mt-1.5"
                />
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  >
                    <span
                      className="h-5 w-5 rounded-full"
                      style={{ backgroundColor: newLabelColor }}
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3" align="end">
                  <div className="grid grid-cols-8 gap-1.5">
                    {COLOR_PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110"
                        style={{ backgroundColor: c }}
                        onClick={() => setNewLabelColor(c)}
                      >
                        {c === newLabelColor && <Check className="h-3 w-3 text-white" />}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div>
              <Label htmlFor="create-label-group" className="text-sm">
                Group <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="create-label-group"
                list="create-group-suggestions"
                value={newLabelGroup}
                onChange={(e) => setNewLabelGroup(e.target.value)}
                placeholder="e.g. Type, Priority"
                className="mt-1.5"
              />
              <datalist id="create-group-suggestions">
                {existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>

            <div>
              <Label className="text-sm">
                Visible in <span className="text-muted-foreground">(all if none selected)</span>
              </Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {ALL_LABEL_SCOPES.map((s) => (
                  <label
                    key={s.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                      newLabelScopes.includes(s.value)
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <Checkbox
                      checked={newLabelScopes.includes(s.value)}
                      onCheckedChange={() =>
                        setNewLabelScopes((prev) =>
                          prev.includes(s.value)
                            ? prev.filter((x) => x !== s.value)
                            : [...prev, s.value],
                        )
                      }
                      className="h-3.5 w-3.5"
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>

            {labelError && (
              <p className="text-sm text-destructive">{labelError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddLabel} disabled={addingLabel || !newLabelName.trim()}>
              {addingLabel ? 'Creating...' : 'Create label'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─── Group row ──────────────────────────────────────────────── */

function GroupRow({
  name,
  count,
  isCollapsed,
  onToggleCollapse,
  onRename,
  onDelete,
}: {
  name: string
  count: number
  isCollapsed: boolean
  onToggleCollapse: () => void
  onRename: (newName: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function commit() {
    const val = inputRef.current?.value.trim()
    if (val && val !== name) onRename(val)
    setEditing(false)
  }

  return (
    <div className="group/row flex items-center border-b border-border/40 hover:bg-muted/30 transition-colors">
      {/* Collapse chevron */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex h-10 w-8 items-center justify-center shrink-0 text-muted-foreground hover:text-foreground"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>

      {/* Group icon — 4-dot grid like Linear */}
      <div className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        <GripVertical className="h-3.5 w-3.5" />
      </div>

      {/* Name — click to edit */}
      <div className="flex-1 min-w-0 ml-2.5">
        {editing ? (
          <input
            ref={inputRef}
            defaultValue={name}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="h-7 w-48 rounded border bg-background px-2 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm font-medium hover:text-primary transition-colors"
          >
            {name}
          </button>
        )}
      </div>

      {/* Visible in — empty for group rows */}
      <span className="w-32" />

      {/* Created — empty for group rows */}
      <span className="w-24" />

      {/* Actions */}
      <div className="w-9 flex justify-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded opacity-0 group-hover/row:opacity-100 hover:bg-muted transition-all"
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Ungroup labels
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/* ─── Label row ──────────────────────────────────────────────── */

function LabelRow({
  label,
  indented,
  isLast,
  existingGroups,
  onUpdate,
  onDelete,
}: {
  label: LabelWithScope
  indented: boolean
  isLast: boolean
  existingGroups: string[]
  onUpdate: (id: string, updates: Partial<LabelWithScope>) => void
  onDelete: (id: string) => void
}) {
  const [editingName, setEditingName] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingName) {
      nameRef.current?.focus()
      nameRef.current?.select()
    }
  }, [editingName])

  function commitName() {
    const val = nameRef.current?.value.trim()
    if (val && val !== label.name) onUpdate(label.id, { name: val })
    setEditingName(false)
  }

  const scopeLabel = label.scopes && label.scopes.length > 0
    ? label.scopes.map((s) => ALL_LABEL_SCOPES.find((x) => x.value === s)?.label).filter(Boolean).join(', ')
    : ''

  return (
    <div className="group/row flex items-center border-b border-border/40 hover:bg-muted/30 transition-colors">
      {/* Indent area with tree connector */}
      {indented ? (
        <div className="w-8 flex justify-center shrink-0">
          <div className={cn(
            'w-px bg-border',
            isLast ? 'h-1/2 self-start' : 'h-full',
          )} />
        </div>
      ) : (
        <div className="w-8 shrink-0" />
      )}

      {/* Color dot */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-4 w-4 shrink-0 items-center justify-center"
          >
            <span
              className="h-3 w-3 rounded-full transition-transform hover:scale-125"
              style={{ backgroundColor: label.color }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="start">
          <div className="grid grid-cols-8 gap-1.5">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-full transition-transform hover:scale-110"
                style={{ backgroundColor: c }}
                onClick={() => onUpdate(label.id, { color: c })}
              >
                {c === label.color && <Check className="h-3 w-3 text-white" />}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Name — click to edit */}
      <div className="flex-1 min-w-0 ml-2.5">
        {editingName ? (
          <input
            ref={nameRef}
            defaultValue={label.name}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') setEditingName(false)
            }}
            className="h-7 w-48 rounded border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingName(true)}
            className="truncate text-sm hover:text-primary transition-colors"
          >
            {label.name}
          </button>
        )}
      </div>

      {/* Visible in */}
      <span className="w-32 text-center text-xs text-muted-foreground">
        {scopeLabel}
      </span>

      {/* Created */}
      <span className="w-24 text-right text-xs text-muted-foreground">
        {format(new Date(label.created_at), 'MMM d')}
      </span>

      {/* Actions menu */}
      <div className="w-9 flex justify-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded opacity-0 group-hover/row:opacity-100 hover:bg-muted transition-all"
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => setEditingName(true)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onClick={() => onUpdate(label.id, { group_name: null })}
                  className={!label.group_name ? 'font-medium' : ''}
                >
                  No group
                </DropdownMenuItem>
                {existingGroups.map((g) => (
                  <DropdownMenuItem
                    key={g}
                    onClick={() => onUpdate(label.id, { group_name: g })}
                    className={label.group_name === g ? 'font-medium' : ''}
                  >
                    {g}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Visible in</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onClick={() => onUpdate(label.id, { scopes: null })}
                  className={!label.scopes || label.scopes.length === 0 ? 'font-medium' : ''}
                >
                  All
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {ALL_LABEL_SCOPES.map((s) => {
                  const isActive = label.scopes?.includes(s.value) ?? false
                  return (
                    <DropdownMenuItem
                      key={s.value}
                      onClick={(e) => {
                        e.preventDefault()
                        const current = label.scopes ?? []
                        const newScopes = isActive
                          ? current.filter((x) => x !== s.value)
                          : [...current, s.value]
                        onUpdate(label.id, {
                          scopes: newScopes.length > 0 ? newScopes : null,
                        })
                      }}
                    >
                      <Checkbox
                        checked={isActive}
                        className="h-3.5 w-3.5 mr-2 pointer-events-none"
                      />
                      {s.label}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              onClick={() => onDelete(label.id)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
