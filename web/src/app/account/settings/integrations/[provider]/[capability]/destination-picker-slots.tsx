'use client'

import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The three pieces of destination-picker JSX that were textually identical
 * across Asana, Jira and Linear.
 *
 * These render EXACTLY what the three inline versions rendered — same elements,
 * same order, same classes, same copy — because the three destination test
 * suites read this DOM positionally (select indices, exact button textContent,
 * span adjacency). A component boundary adds no DOM, so extracting them is
 * invisible to those tests, which is the point: they are the parity proof.
 *
 * What is NOT here, deliberately: the bucket→destination map tables. Those are
 * three different shapes wearing similar clothes (editable-with-guesses,
 * editable-with-hints, read-only-with-warnings) and the MEANING of an unmapped
 * bucket differs in each. See the three renderers in bucket-maps.tsx.
 */

/**
 * The pickers can't populate without a live token, so a reconnect code REPLACES
 * them — an empty dropdown with no explanation reads as "you have no projects".
 *
 * `pickerList` is the only copy that varies between providers, and it varies
 * because the cascades genuinely differ ("workspace, project and section" vs
 * "team and project").
 */
export function ReconnectBanner({
  provider,
  pickerList,
  onReconnect,
  connecting,
}: {
  /** Display name, e.g. "Asana". Appears in the heading and the button. */
  provider: string
  /** What can't load, e.g. "the team and project pickers". */
  pickerList: ReactNode
  onReconnect: () => void
  connecting: boolean
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className="flex-1">
        <p className="text-sm font-medium">
          Reconnect {provider} to manage the destination
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Native Intelligence can no longer use your stored {provider} authorization, so{' '}
          {pickerList} can&apos;t load. Reconnect to choose where pushed actions
          land.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2.5 h-7 text-xs"
          onClick={onReconnect}
          disabled={connecting}
        >
          {connecting ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          Reconnect {provider}
        </Button>
      </div>
    </div>
  )
}

/**
 * Anything that isn't a reconnect (5xx, network) — say so and offer a retry
 * rather than rendering silent emptiness.
 */
export function PickerLoadError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-2.5">
      <p className="text-xs text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

export interface SearchableOption {
  id: string
  /** Rendered in a leading mono span before the name. Jira's project key. */
  key?: string
  name: string
}

/**
 * The search-box-plus-scrollable-button-list widget the Asana and Jira PROJECT
 * pickers share.
 *
 * Deliberately not forced onto Linear's team/project pickers: those are plain
 * `<Select>`s with no search, because a Linear token sees one organization and
 * the teams route's list is therefore COMPLETE — a search box would be
 * ceremony over a five-item list.
 *
 * The `key` span is rendered as an immediate sibling of the name span with no
 * separator, which is load-bearing: the Jira suite finds a project button by
 * the concatenated textContent ("GROGrowth"). Do not introduce whitespace
 * between them.
 */
export function SearchableOptionList({
  query,
  onQueryChange,
  loading,
  options,
  selectedId,
  onSelect,
  emptyMessage,
  placeholder = 'Search projects...',
}: {
  query: string
  onQueryChange: (value: string) => void
  loading: boolean
  options: SearchableOption[]
  selectedId: string | null
  onSelect: (id: string) => void
  emptyMessage: string
  placeholder?: string
}) {
  return (
    <>
      <div className="relative mt-2.5">
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="h-8 text-xs"
        />
        {loading && (
          <ThinkingOrb state="working" size={20} theme="auto" />
        )}
      </div>
      <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
              option.id === selectedId ? 'bg-accent' : ''
            }`}
          >
            {option.key !== undefined && (
              <span className="shrink-0 font-mono text-muted-foreground">{option.key}</span>
            )}
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {option.id === selectedId && (
              <Check className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
          </button>
        ))}
        {!loading && options.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground/60">{emptyMessage}</p>
        )}
      </div>
    </>
  )
}

// NOTE ON WHAT IS *NOT* HERE. The attribution toggle and the "Clear
// destination" button are also near-identical across the three providers, and
// both were deliberately left inline. Neither is destination-picker MACHINERY:
// the toggle is a provider-level preference that merely happens to share this
// card stack, and the clear button is two lines of JSX whose PLACEMENT is the
// interesting part (inside the project card for Asana and Jira, inside the team
// card for Linear, because "the" destination is a different field in each).
// Extracting them would trade three obvious call sites for one indirection and
// a props bag of copy strings.
