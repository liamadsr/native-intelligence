'use client'

/**
 * Tool permissions, as Settings › Connectors shows them for an MCP server
 * (mcp-connector-view.tsx) and the agent panel's People tab shows them for a
 * person (people-panel.tsx): groups of tools, each collapsible with a count
 * and a menu that sets the whole group, then a row per tool with a one-click
 * ✓ Always allow / ✋ Needs approval / ⊘ Blocked switch
 * (lib/mcp-client/tool-permissions.ts TOOL_PERMISSIONS).
 *
 * Presentational: the caller says what each tool is set to and what a change
 * does.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Ban, ChevronDown, CircleCheck, Hand } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TOOL_PERMISSIONS, type ToolPermission } from '@/lib/mcp-client/tool-permissions'

export const PERMISSION_ICON: Record<ToolPermission, typeof Hand> = { allow: CircleCheck, ask: Hand, blocked: Ban }

export interface ToolPermissionRow {
  /** The tool's name: the row's key. */
  name: string
  /** As a person reads it. */
  label: string
  /** The row's hover text. */
  title?: string
  value: ToolPermission
  /** Always allow can't be chosen for it; `allowDisabledReason` says why. */
  allowDisabled?: boolean
  allowDisabledReason?: string
  /** Shown after the label (a "New" tag). */
  badge?: ReactNode
}

/**
 * The group's permission as its menu reads it: the one every row has, else
 * mixed (Custom). Null for no rows.
 */
export function rowsPermission(rows: readonly { value: ToolPermission }[]): ToolPermission | 'mixed' | null {
  if (rows.length === 0) return null
  const first = rows[0].value
  return rows.every((r) => r.value === first) ? first : 'mixed'
}

/** One group: collapsible, a menu that sets them all, then a row per tool. */
export function ToolPermissionGroup({
  title,
  rows,
  value,
  onSetGroup,
  onSetTool,
  defaultOpen = true,
  disabled = false,
}: {
  title: string
  rows: readonly ToolPermissionRow[]
  /** The group's permission (rowsPermission, or the caller's own reading). */
  value: ToolPermission | 'mixed'
  onSetGroup: (permission: ToolPermission) => void
  onSetTool: (name: string, permission: ToolPermission) => void
  defaultOpen?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const listId = `tool-group-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <div data-tool-group={title}>
      <div className="flex items-center justify-between gap-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 inline-flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-sm transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !open && '-rotate-90')} />
          <span className="truncate">{title}</span>
          <span className="rounded-full border px-2 text-xs text-muted-foreground">{rows.length}</span>
        </button>
        <GroupPermissionMenu value={value} label={`Permission for all ${title.toLowerCase()}`} onChange={onSetGroup} disabled={disabled} />
      </div>
      <ul id={listId} hidden={!open} className="divide-y border-b">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-3 py-2.5 pl-7" data-tool-row={row.name}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-sm text-muted-foreground" title={row.title ?? row.name}>
                {row.label}
              </span>
              {row.badge}
            </div>
            <PermissionSwitch
              value={row.value}
              label={`Permission for ${row.label}`}
              allowDisabled={row.allowDisabled ?? false}
              allowDisabledReason={row.allowDisabledReason}
              disabled={disabled}
              onChange={(p) => onSetTool(row.name, p)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A tool's permission as three one-click icons (✓ Always allow, ✋ Needs
 * approval, ⊘ Blocked), the chosen one raised. A radio group: one tab stop,
 * arrow keys move between the choices it can take.
 */
export function PermissionSwitch({
  value,
  label,
  allowDisabled,
  allowDisabledReason,
  disabled = false,
  onChange,
}: {
  value: ToolPermission
  label: string
  /** A catalog app's tool that always asks: Always allow can't be chosen. */
  allowDisabled: boolean
  allowDisabledReason?: string
  disabled?: boolean
  onChange: (permission: ToolPermission) => void
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const choices = TOOL_PERMISSIONS.map((p) => ({ ...p, disabled: p.id === 'allow' && allowDisabled }))
  function onKeyDown(e: React.KeyboardEvent) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step || disabled) return
    e.preventDefault()
    const from = choices.findIndex((c) => c.id === value)
    for (let i = 1; i <= choices.length; i++) {
      const at = (from + step * i + choices.length) % choices.length
      if (choices[at].disabled) continue
      onChange(choices[at].id)
      refs.current[at]?.focus()
      return
    }
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {choices.map((choice, i) => {
        const Icon = PERMISSION_ICON[choice.id]
        const checked = value === choice.id
        return (
          <button
            key={choice.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={choice.label}
            title={choice.disabled ? (allowDisabledReason ?? choice.label) : choice.label}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || choice.disabled}
            onClick={() => !checked && onChange(choice.id)}
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35 motion-reduce:transition-none',
              checked ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="h-4 w-4" />
          </button>
        )
      })}
    </div>
  )
}

/** A group's permission as a menu (Claude's "Always allow ⌄"); a group whose tools differ reads Custom. */
export function GroupPermissionMenu({
  value,
  label,
  onChange,
  disabled = false,
}: {
  value: ToolPermission | 'mixed'
  label: string
  onChange: (permission: ToolPermission) => void
  disabled?: boolean
}) {
  const current = TOOL_PERMISSIONS.find((p) => p.id === value)
  const Icon = value === 'mixed' ? null : PERMISSION_ICON[value]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current?.label ?? 'Custom'}`}
          disabled={disabled}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
        >
          {Icon && <Icon aria-hidden className="h-4 w-4" />}
          {current?.label ?? 'Custom'}
          <ChevronDown aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as ToolPermission)}>
          {TOOL_PERMISSIONS.map((p) => {
            const ItemIcon = PERMISSION_ICON[p.id]
            return (
              <DropdownMenuRadioItem key={p.id} value={p.id} className="gap-2">
                <ItemIcon aria-hidden className="h-3.5 w-3.5" />
                {p.label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
