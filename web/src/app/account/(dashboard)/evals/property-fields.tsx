'use client'

/**
 * The two Properties controls the shared picker set has no primitive for: the
 * suite's TARGET (a recipe) and its JUDGE MODEL.
 *
 * WHY THEY LIVE HERE AND NOT IN `src/components/views/properties/`. That
 * directory is the views system's vocabulary — every picker in it is wired to a
 * registered filterable field and reused by cells, panels and the filter bar.
 * These two have exactly one caller each and no cell rendering, so promoting
 * them now would be inventing a shared contract from a single use. When a
 * second surface needs a recipe picker, that is the moment to move it.
 *
 * BOTH FOLLOW THE `InitiativePickerContent` SHAPE — a Popover over a Command
 * list — because that is what a panel field that opens a searchable list looks
 * like in this app, and a bespoke dropdown here would read as a different
 * control for the same gesture.
 */

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { DeepSeekIcon, KimiIcon } from '@/components/brand-icons'
import { CHAT_MODELS, getModelProvider } from '@/lib/ai/models'
import { DEFAULT_JUDGE_MODEL_ID } from '@/lib/evals/types'
import type { EvalTargetKind } from '@/lib/evals/types'
import { LIBRARY_CATEGORY_ICONS } from '@/lib/types/library-icons'
import { cn } from '@/lib/utils'
import { SiClaude } from '@icons-pack/react-simple-icons'
import { Boxes, Loader2 } from 'lucide-react'
import * as React from 'react'

// ============================================================
// Target — the recipe this suite grades
// ============================================================

/** One pickable recipe. The list routes return far more per row; this is all a
 *  picker needs, and narrowing it here means a route field rename cannot
 *  silently change what the popover renders. */
export interface RecipeOption {
  id: string
  name: string
}

/** The label a kind carries in the row, as a muted suffix after the name. */
function kindLabel(kind: EvalTargetKind): string {
  return kind === 'agent' ? 'Agent' : 'Skill'
}

/**
 * Fetch the recipes of one kind, ONCE, on first open.
 *
 * Lazily rather than on mount: the suite page already renders the target's name
 * from its own payload, so the full list is only needed by someone who has
 * decided to change it. Fetching on mount would put a second request on every
 * suite open to populate a popover most visits never see.
 */
function useRecipeOptions(kind: EvalTargetKind, enabled: boolean) {
  const [options, setOptions] = React.useState<RecipeOption[] | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    // `options !== null` is the "already fetched" gate, NOT a ref.
    //
    // A ref set on entry and checked on entry deadlocks under StrictMode's
    // double-invoke: the first pass arms the ref and starts the request, the
    // cleanup marks it cancelled, and the second pass returns early on the
    // armed ref — so nothing ever clears `loading` and the popover spins
    // forever. Gating on the STATE means the second pass re-runs the fetch and
    // is the one that lands, and once the list is in state neither pass fires
    // again.
    if (!enabled || options !== null) return
    let cancelled = false
    setLoading(true)
    const path = kind === 'agent' ? '/api/account/agents' : '/api/account/skills'
    const key = kind === 'agent' ? 'agents' : 'skills'
    void (async () => {
      try {
        const res = await fetch(path)
        if (!res.ok) throw new Error('list failed')
        const body = (await res.json()) as Record<string, unknown>
        const rows = Array.isArray(body[key]) ? (body[key] as RecipeOption[]) : []
        if (!cancelled) {
          setOptions(rows.map((r) => ({ id: r.id, name: r.name })))
        }
      } catch {
        // An empty list, not an error dialog. The popover already says "No
        // agents found" for a workspace that has none, and a failed list is
        // indistinguishable from that to the person looking at it — what they
        // do next (close it, try again) is the same either way.
        if (!cancelled) setOptions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, kind, options])

  return { options, loading }
}

/**
 * The suite's target, as an editable Properties row.
 *
 * The KIND is fixed. `target_kind` is immutable by schema (UpdateSuiteSchema
 * does not accept it) because a case's script and its expectations are written
 * against one kind of recipe — repointing an agent suite at a skill would keep
 * every case and invalidate all of them at once. So the list holds recipes of
 * this suite's own kind, and the kind renders as the row's muted suffix rather
 * than as a second control.
 */
export function RecipePanelField({
  kind,
  value,
  displayName,
  onChange,
}: {
  kind: EvalTargetKind
  /** `target_recipe_id`, or null when the suite names no recipe. */
  value: string | null | undefined
  /** The resolved name from the suite payload — what the row shows before the
   *  list has ever been fetched, and after a recipe the list cannot see. */
  displayName?: string | null
  onChange: (recipeId: string | null) => void
}) {
  const [open, setOpen] = React.useState(false)
  const { options, loading } = useRecipeOptions(kind, open)
  const Icon = LIBRARY_CATEGORY_ICONS[kind]
  const label = kindLabel(kind)

  const selected = options?.find((r) => r.id === value)
  const name = selected?.name ?? displayName ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* ICON + VALUE, one column — the capture panel's row shape. The field
            name is not written anywhere: an agent glyph followed by
            "Sales Copilot · Agent" is already unambiguous, and a "Target"
            label column would put this row out of line with every sibling. */}
        <button
          className="hover:bg-muted/50 flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm transition-colors"
          title={name ? `${name} · ${label}` : `No ${label.toLowerCase()}`}
        >
          <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
          <span
            className={cn('truncate text-left', !name && 'text-muted-foreground')}
          >
            {name ? `${name} · ${label}` : 'Set target'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput
            placeholder={`Search ${label.toLowerCase()}s...`}
            className="h-9"
          />
          <CommandList>
            {loading ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading
              </div>
            ) : (
              <>
                <CommandEmpty>No {label.toLowerCase()}s found</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="__no_target__"
                    onSelect={() => {
                      onChange(null)
                      setOpen(false)
                    }}
                    className={cn(!value && 'bg-accent')}
                  >
                    <Icon className="text-muted-foreground mr-2 h-4 w-4" />
                    <span className="text-muted-foreground">No target</span>
                  </CommandItem>
                  {(options ?? []).map((r) => (
                    <CommandItem
                      key={r.id}
                      value={r.name}
                      onSelect={() => {
                        onChange(r.id)
                        setOpen(false)
                      }}
                      className={cn(value === r.id && 'bg-accent')}
                    >
                      <Icon className="text-muted-foreground mr-2 h-4 w-4" />
                      <span className="min-w-0 truncate">{r.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================
// Judge model
// ============================================================

/** The provider glyph the chat composer uses, so a model reads the same in
 *  both places. Unknown providers fall back to a neutral mark. */
function ModelIcon({
  modelId,
  className,
}: {
  modelId: string
  className?: string
}) {
  switch (getModelProvider(modelId)) {
    case 'anthropic':
      return <SiClaude className={className} color="default" />
    case 'moonshotai':
      return <KimiIcon className={className} />
    case 'deepseek':
      return <DeepSeekIcon className={className} />
    default:
      return <Boxes className={className} />
  }
}

/** The label of whatever `judge_model: null` actually resolves to, so the
 *  sentinel row names the model rather than hiding it behind the word
 *  "Default". */
export function defaultJudgeLabel(): string {
  return (
    CHAT_MODELS.find((m) => m.id === DEFAULT_JUDGE_MODEL_ID)?.label ??
    DEFAULT_JUDGE_MODEL_ID
  )
}

/**
 * The suite's judge, as an editable Properties row.
 *
 * A FLAT COMMAND LIST, no search input: six models is a glance, and a search
 * box over six rows is a control that costs a keystroke to skip.
 *
 * THE SENTINEL IS FIRST AND NAMES ITS MODEL. `judge_model` is nullable and null
 * means "whatever the code's default judge is" — a value that can change under
 * a suite between releases. Writing the current default's id instead of null
 * would freeze this suite on today's model forever, so the sentinel PATCHes
 * null and the row says which model that is right now.
 */
export function JudgeModelPanelField({
  value,
  onChange,
}: {
  /** `judge_model`, or null for the code default. */
  value: string | null | undefined
  onChange: (modelId: string | null) => void
}) {
  const [open, setOpen] = React.useState(false)
  const selected = CHAT_MODELS.find((m) => m.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* ICON + VALUE, like every sibling row: the selected model's own
            provider glyph, then the model. The sentinel names its model too
            ("Default · Sonnet 4.5"), so the row never hides which judge is
            actually going to grade. */}
        <button
          className="hover:bg-muted/50 flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm transition-colors"
          title={
            selected
              ? `Judge model: ${selected.label}`
              : `Judge model: Default (${defaultJudgeLabel()})`
          }
        >
          <ModelIcon
            modelId={selected?.id ?? DEFAULT_JUDGE_MODEL_ID}
            className="text-muted-foreground h-4 w-4 shrink-0"
          />
          <span className="truncate text-left">
            {selected ? (
              selected.label
            ) : (
              <>
                Default
                <span className="text-muted-foreground">
                  {' '}
                  · {defaultJudgeLabel()}
                </span>
              </>
            )}
          </span>
        </button>
      </PopoverTrigger>
      {/* The house popover shell — Command + CommandItem, exactly like
          `EnumPanelField`'s — so the judge dropdown and the suite-kind dropdown
          beside it are the same control. Still no search input: six models is a
          glance, and a search box over six rows costs a keystroke to skip. */}
      <PopoverContent className="w-56 p-1" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              <CommandItem
                value="__default_judge__"
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className={cn(!selected && 'bg-accent')}
              >
                <ModelIcon
                  modelId={DEFAULT_JUDGE_MODEL_ID}
                  className="mr-2 h-4 w-4 shrink-0"
                />
                <span className="min-w-0 truncate">
                  Default
                  <span className="text-muted-foreground">
                    {' '}
                    · {defaultJudgeLabel()}
                  </span>
                </span>
              </CommandItem>
              {CHAT_MODELS.map((m) => (
                <CommandItem
                  key={m.id}
                  value={m.label}
                  onSelect={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                  className={cn(selected?.id === m.id && 'bg-accent')}
                >
                  <ModelIcon modelId={m.id} className="mr-2 h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{m.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
