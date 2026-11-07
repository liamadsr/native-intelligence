'use client'

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Circle, Flag, Folder, Paperclip, Tag, User } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Switch } from '@/components/ui/switch'
import { PropertyPill as SharedPropertyPill } from '@/components/views/properties/property-pill'
import { groupLabelsByGroupName } from '@/lib/labels/utils'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'
import { cn } from '@/lib/utils'

export interface SubActionWorkflowState {
  id: string
  name: string
  category: string
  color: string
  is_default?: boolean
}

export interface SubActionMember {
  id: string
  display_name: string
  avatar_url: string | null
}

export interface SubActionProject {
  id: string
  name: string
}

export interface SubActionLabel {
  id: string
  name: string
  color: string
}

/** The composer's output — one sub-action's worth of user input. */
export interface SubActionDraft {
  title: string
  description: string
  statusId: string | null
  priority: string
  assigneeIds: string[]
  projectId: string | null
  labelIds: string[]
}

export interface SubActionComposerProps {
  workflowStates: SubActionWorkflowState[]
  members: SubActionMember[]
  projects: SubActionProject[]
  labels: SubActionLabel[]
  /**
   * Receives the completed draft. The composer does NOT persist anything — the
   * two hosts need different things to happen: the create dialog queues the
   * draft because its parent action does not exist yet, while the detail panel
   * POSTs immediately against an existing parent. Returning a promise keeps the
   * submit button disabled until the host finishes.
   */
  onSubmit: (draft: SubActionDraft) => void | Promise<void>
  onCancel: () => void
  /** Label for the confirm button. */
  submitLabel?: string
  /** Hides the "Create more" switch for hosts that add one at a time. */
  showCreateMore?: boolean
  className?: string
}

/**
 * The rich sub-action form: title, description, and pills for status,
 * priority, assignees, project and labels.
 *
 * Extracted from create-dialog.tsx so the action detail panel can embed the
 * same form inline instead of offering a bare title input — previously the two
 * surfaces disagreed about what creating a sub-action even meant.
 *
 * Deliberately presentational: it owns only its own field state and hands a
 * finished draft to `onSubmit`. Persistence differs per host (see the prop),
 * and its option lists are passed in rather than fetched, so embedding it does
 * not add a second copy of the workspace lookups the hosts already run.
 */
export function SubActionComposer({
  workflowStates,
  members,
  projects,
  labels,
  onSubmit,
  onCancel,
  submitLabel = 'Add sub-action',
  showCreateMore = true,
  className,
}: SubActionComposerProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [statusId, setStatusId] = useState<string | null>(null)
  const [priority, setPriority] = useState('none')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [createMore, setCreateMore] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  function reset() {
    setTitle('')
    setDescription('')
    setStatusId(null)
    setPriority('none')
    setAssigneeIds([])
    setProjectId(null)
    setLabelIds([])
  }

  async function submit() {
    const trimmed = title.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onSubmit({
        title: trimmed,
        description: description.trim(),
        statusId,
        priority,
        assigneeIds: [...assigneeIds],
        projectId,
        labelIds: [...labelIds],
      })
      reset()
      // "Create more" keeps the form open and focused for the next one;
      // otherwise adding a sub-action closes it, which is the common case.
      if (createMore && showCreateMore) {
        setTimeout(() => titleRef.current?.focus(), 50)
      } else {
        onCancel()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const currentState = workflowStates.find((s) => s.id === statusId)
  const currentPriority = PRIORITY_OPTIONS.find((o) => o.value === priority) ?? PRIORITY_OPTIONS[0]
  const currentProject = projects.find((p) => p.id === projectId) || null
  const selectedLabels = labels.filter((l) => labelIds.includes(l.id))

  return (
    <div
      data-sub-action-composer=""
      className={cn(
        'rounded-lg border border-dashed border-border/80 bg-muted/30 p-3',
        className,
      )}
    >
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Action title"
        className="w-full bg-transparent text-sm font-medium placeholder:text-muted-foreground/50 focus:outline-none"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Add description..."
        rows={2}
        className="mt-1 w-full resize-none bg-transparent text-xs text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none"
      />

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Pill
          icon={
            <Circle
              className="h-2.5 w-2.5"
              style={{ color: currentState?.color || '#6b7280' }}
              fill={currentState?.color || '#6b7280'}
            />
          }
          label={currentState?.name || 'Backlog'}
        >
          {(close) => (
            <Command>
              <CommandInput placeholder="Set status..." />
              <CommandList>
                <CommandEmpty>No states found</CommandEmpty>
                <CommandGroup>
                  {workflowStates.map((state) => (
                    <CommandItem
                      key={state.id}
                      value={state.name}
                      onSelect={() => {
                        setStatusId(state.id)
                        close()
                      }}
                    >
                      <Circle className="mr-2 h-3 w-3" style={{ color: state.color }} fill={state.color} />
                      {state.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </Pill>

        <Pill
          icon={<Flag className={cn('h-2.5 w-2.5', currentPriority.color)} />}
          label={priority === 'none' ? 'Priority' : currentPriority.label}
          muted={priority === 'none'}
        >
          {(close) => (
            <Command>
              <CommandInput placeholder="Set priority..." />
              <CommandList>
                <CommandGroup>
                  {PRIORITY_OPTIONS.map((opt) => (
                    <CommandItem
                      key={opt.value}
                      value={opt.label}
                      onSelect={() => {
                        setPriority(opt.value)
                        close()
                      }}
                    >
                      <Flag className={cn('mr-2 h-3 w-3', opt.color)} />
                      {opt.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </Pill>

        <Pill
          icon={
            assigneeIds.length > 0 ? (
              <div className="flex -space-x-0.5">
                {members
                  .filter((m) => assigneeIds.includes(m.id))
                  .slice(0, 2)
                  .map((a) =>
                    a.avatar_url ? (
                      <img
                        key={a.id}
                        src={a.avatar_url}
                        alt=""
                        className="h-3 w-3 rounded-full ring-1 ring-background"
                      />
                    ) : (
                      <User key={a.id} className="h-2.5 w-2.5 text-muted-foreground" />
                    ),
                  )}
              </div>
            ) : (
              <User className="h-2.5 w-2.5 text-muted-foreground" />
            )
          }
          label={
            assigneeIds.length === 0
              ? 'Assignee'
              : assigneeIds.length === 1
                ? members.find((m) => m.id === assigneeIds[0])?.display_name || 'Assignee'
                : `${assigneeIds.length} assignees`
          }
          muted={assigneeIds.length === 0}
          keepOpen
        >
          {() => (
            <Command>
              <CommandInput placeholder="Assign to..." />
              <CommandList>
                <CommandEmpty>No members found</CommandEmpty>
                <CommandGroup>
                  {members.map((m) => {
                    const isSelected = assigneeIds.includes(m.id)
                    return (
                      <CommandItem
                        key={m.id}
                        value={m.display_name}
                        onSelect={() => {
                          setAssigneeIds((prev) =>
                            isSelected ? prev.filter((id) => id !== m.id) : [...prev, m.id],
                          )
                        }}
                      >
                        <div
                          className={cn(
                            'mr-2 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border',
                            isSelected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/30',
                          )}
                        >
                          {isSelected && <Check className="h-2.5 w-2.5" />}
                        </div>
                        {m.avatar_url ? (
                          <img src={m.avatar_url} alt="" className="mr-2 h-3.5 w-3.5 rounded-full" />
                        ) : (
                          <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        {m.display_name}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </Pill>

        <Pill
          icon={<Folder className="h-2.5 w-2.5 text-muted-foreground" />}
          label={currentProject?.name || 'Project'}
          muted={!currentProject}
        >
          {(close) => (
            <Command>
              <CommandInput placeholder="Set project..." />
              <CommandList>
                <CommandEmpty>No projects found</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="none"
                    onSelect={() => {
                      setProjectId(null)
                      close()
                    }}
                  >
                    <Folder className="mr-2 h-3 w-3 text-muted-foreground" />
                    No project
                  </CommandItem>
                  {projects.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={p.name}
                      onSelect={() => {
                        setProjectId(p.id)
                        close()
                      }}
                    >
                      <Folder className="mr-2 h-3 w-3" />
                      {p.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </Pill>

        <LabelsPill
          labels={labels}
          labelIds={labelIds}
          selectedLabels={selectedLabels}
          setLabelIds={setLabelIds}
        />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Attach files"
        >
          <Paperclip className="h-3 w-3" />
        </button>
        <div className="flex items-center gap-2.5">
          {showCreateMore && (
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                checked={createMore}
                onCheckedChange={setCreateMore}
                className="h-3.5 w-7 [&>span]:h-2.5 [&>span]:w-2.5 [&>span[data-state=checked]]:translate-x-3.5"
              />
              Create more
            </label>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={!title.trim() || submitting}
            onClick={submit}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The dialog-variant pill, at the composer's dense size. */
function Pill({
  icon,
  label,
  muted,
  keepOpen,
  children,
}: {
  icon: React.ReactNode
  label: string
  muted?: boolean
  keepOpen?: boolean
  children: (close: () => void) => React.ReactNode
}) {
  return (
    <SharedPropertyPill
      variant="dialog"
      icon={icon}
      label={label}
      muted={muted}
      keepOpen={keepOpen}
      small
    >
      {children}
    </SharedPropertyPill>
  )
}

function LabelsPill({
  labels,
  labelIds,
  selectedLabels,
  setLabelIds,
}: {
  labels: SubActionLabel[]
  labelIds: string[]
  selectedLabels: SubActionLabel[]
  setLabelIds: React.Dispatch<React.SetStateAction<string[]>>
}) {
  const grouped = groupLabelsByGroupName(labels as never)
  const hasNamedGroups = grouped.some((g) => g.groupName !== null)
  return (
    <Pill
      icon={<Tag className="h-2.5 w-2.5 text-muted-foreground" />}
      label={selectedLabels.length > 0 ? selectedLabels.map((l) => l.name).join(', ') : 'Labels'}
      muted={selectedLabels.length === 0}
      keepOpen
    >
      {() => (
        <Command>
          <CommandInput placeholder="Add labels..." />
          <CommandList>
            <CommandEmpty>No labels found</CommandEmpty>
            {grouped.map((group) => (
              <CommandGroup
                key={group.groupName ?? '__ungrouped'}
                heading={hasNamedGroups ? (group.groupName ?? 'Other') : undefined}
              >
                {group.labels.map((label) => {
                  const selected = labelIds.includes(label.id)
                  return (
                    <CommandItem
                      key={label.id}
                      value={label.name}
                      onSelect={() => {
                        setLabelIds((prev) =>
                          selected ? prev.filter((id) => id !== label.id) : [...prev, label.id],
                        )
                      }}
                    >
                      <span
                        className={cn(
                          'mr-2 inline-block h-2.5 w-2.5 rounded-full border',
                          selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                        )}
                        style={{ backgroundColor: label.color }}
                      />
                      {label.name}
                      {selected && <span className="ml-auto text-xs text-primary">✓</span>}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      )}
    </Pill>
  )
}
