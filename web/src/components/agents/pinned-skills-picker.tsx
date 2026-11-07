'use client'

/**
 * The skills a bot always checks (docs/plans/bots-v4.md, Phase B1): the
 * agent's, in order, at most five. Each loads in full into every prompt the
 * bot has (its chat and its runs), so the list is short on purpose; in its
 * chat the bot can still load any other skill when it needs one.
 *
 * Only shared skills are offered (the workspace's own and the system ones,
 * never a personal one: isPinnableSkill). A skill already pinned that the
 * person can't read shows as such and stays until they remove it.
 *
 * Plain buttons rather than a portal'd select, so the list reads top to bottom
 * for a screen reader: each pinned skill has Move up, Move down and Remove,
 * named for the skill; "Add a skill" opens the rest of the list under it,
 * with a filter once it's long.
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { LibraryItemIcon } from '@/components/library-item-icon'
import { MAX_PINNED_SKILLS } from '@/lib/agents/editable-fields'
import { cn } from '@/lib/utils'

export interface SkillOption {
  id: string
  name: string
  description: string | null
  color: string | null
}

/** Show a filter over the skills to add once there are more than this. */
const FILTER_FROM = 8

export function PinnedSkillsPicker({
  value,
  onChange,
  options,
  disabled = false,
  labelledBy,
  max = MAX_PINNED_SKILLS,
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  /** The skills that may be pinned (shared ones only). */
  options: readonly SkillOption[]
  disabled?: boolean
  labelledBy?: string
  max?: number
}) {
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const pinned = useMemo(
    () => value.map((id) => options.find((o) => o.id === id) ?? { id, name: 'A skill you can’t see', description: null, color: null }),
    [value, options],
  )
  const rest = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return options.filter((o) => !value.includes(o.id) && (!q || o.name.toLowerCase().includes(q)))
  }, [options, value, filter])
  const full = value.length >= max
  const anyLeft = options.some((o) => !value.includes(o.id))

  const move = (index: number, by: -1 | 1) => {
    const next = [...value]
    const [id] = next.splice(index, 1)
    next.splice(index + by, 0, id)
    onChange(next)
  }

  return (
    <div data-pinned-skills="">
      {pinned.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ol aria-labelledby={labelledBy} className="space-y-1">
          {pinned.map((s, i) => (
            <li key={s.id} data-pinned-skill={s.id} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
              <LibraryItemIcon color={s.color} seed={s.id} size="xs" />
              <span className="min-w-0 flex-1 truncate text-sm" title={s.description ?? undefined}>
                {s.name}
              </span>
              {!disabled && (
                <span className="flex shrink-0 items-center">
                  <IconButton label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label={`Move ${s.name} down`} disabled={i === pinned.length - 1} onClick={() => move(i, 1)}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label={`Remove ${s.name}`} onClick={() => onChange(value.filter((id) => id !== s.id))}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {!disabled && (
        <div className="mt-1.5">
          <button
            type="button"
            data-add-skill=""
            disabled={full || !anyLeft}
            aria-expanded={adding}
            onClick={() => setAdding((a) => !a)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5" />
            {full ? `Up to ${max} skills` : anyLeft ? 'Add a skill' : 'No more skills to add'}
          </button>
          {adding && !full && anyLeft && (
            <div className="mt-1 rounded-md border p-1.5" data-skill-choices="">
              {options.length - value.length > FILTER_FROM && (
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Find a skill…"
                  aria-label="Find a skill"
                  className="mb-1.5 h-7 text-xs"
                />
              )}
              <ul className="max-h-44 space-y-0.5 overflow-y-auto">
                {rest.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      data-skill-choice={o.id}
                      onClick={() => {
                        onChange([...value, o.id])
                        if (value.length + 1 >= max) setAdding(false)
                      }}
                      className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-muted"
                    >
                      <LibraryItemIcon color={o.color} seed={o.id} size="xs" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{o.name}</span>
                        {o.description && <span className="block truncate text-[11px] text-muted-foreground">{o.description}</span>}
                      </span>
                    </button>
                  </li>
                ))}
                {rest.length === 0 && <li className="px-1.5 py-1 text-xs text-muted-foreground">No skill matches.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground" data-pinned-count="">
        {value.length} of {max}
      </p>
    </div>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-30',
      )}
    >
      {children}
    </button>
  )
}
