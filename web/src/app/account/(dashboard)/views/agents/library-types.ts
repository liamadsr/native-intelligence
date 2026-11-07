/**
 * Shared vocabulary for the Agents & Skills page (Phase 1 rebuild).
 *
 * The page is now TYPE-FIRST: the primary axis is Agents | Skills (a
 * `LibraryCategory`), and "whose stuff" (`LibraryScope`) is a secondary filter
 * inside each type. This module holds the view-model row shape and the scope
 * enum so the orchestrator, the pure filter helpers, and the row/dialog
 * components all speak the same types without importing each other.
 */

import type { LibraryCategory, LibraryVisibility } from '@/lib/types/library'

export type { LibraryCategory, LibraryVisibility }

/**
 * Secondary scope filter within a type tab.
 *
 * - `all`      — everything usable in this workspace: built-ins (is_system) +
 *                workspace-visible items + your personal items, deduped. This is
 *                the union of the old Mine + Workspace data.
 * - `mine`     — items the current user created (incl. their personal ones).
 * - `workspace`— workspace-visible items (incl. built-ins).
 * - `discover` — the public cross-tenant catalog (marketplace fetch), with the
 *                fork ("Add to Workspace") flow and already-forked dedupe.
 */
export type { LibraryScope } from '@/lib/views/types'

/**
 * Local view-model. Matches what the marketplace + account/library endpoints
 * return — a superset of `LibraryItem` with the marketplace provenance fields.
 * Kept structural (not the discriminated `LibraryItem`) because the list
 * endpoints return a slightly looser shape and we normalize category via the
 * account route the row came from.
 */
export interface LibraryRow {
  id: string
  name: string
  icon: string | null
  color: string | null
  description: string | null
  category: LibraryCategory
  slug: string | null
  is_system: boolean
  is_default: boolean
  visibility: LibraryVisibility
  created_by: string | null
  fork_count: number
  forked_from: string | null
  author_name: string | null
  author_avatar_url: string | null
  marketplace_category: string | null
  featured: boolean
  created_at: string
  system_prompt?: string | null
  agent_config?: Record<string, unknown> | null
  /** A skill's area (migration 316): the pack that loads it. */
  area?: string | null
  extraction_config?: Record<string, unknown> | null
  /**
   * Fork-lineage display facts, merged server-side by the account list routes
   * (queries.ts `annotateLineage`). Present only on forked rows whose source
   * still resolves; a deleted/unreadable source leaves both null so the UI
   * shows no "forked from" chip. `source_updated_at` > `created_at` means the
   * Discover listing diverged after this copy was added.
   */
  source_name?: string | null
  source_updated_at?: string | null
}

/**
 * One-line framing shown as the subtitle / empty-state teaching copy per type.
 * These are the approved north-star sentences (redesign doc §5) — the page
 * teaches exactly this and nothing here should say "Skills agents can run".
 */
export const TYPE_FRAMING: Record<LibraryCategory, string> = {
  agent:
    'An agent is who does the work — a persona with its own tools you can talk to, bring to a meeting, or assign work to.',
  skill:
    'A skill is a move any agent can pick up — discovered from its description, invoked with /, or run on a schedule.',
}

/** Placeholder-name examples per type for the create dialog's name field. */
export const NAME_PLACEHOLDER: Record<LibraryCategory, string> = {
  agent: 'Project Manager',
  skill: 'plan-week',
}

/**
 * The lineage chip's display state for a row, or null when nothing should
 * render. A "forked from" chip shows only when the source still resolves
 * (server merged a `source_name`); the `diverged` flag adds the quiet
 * "· source has changed" hint when the Discover listing was updated after this
 * copy was added (`source_updated_at` strictly after the fork's `created_at`).
 *
 * Pure and self-contained (no React) so the row and the detail dialog render
 * identical provenance from one source of truth, and it's unit-testable.
 */
export interface LineageChip {
  sourceName: string
  diverged: boolean
}

export function lineageChip(item: {
  forked_from?: string | null
  source_name?: string | null
  source_updated_at?: string | null
  created_at?: string | null
}): LineageChip | null {
  // No fork, or the source was deleted/unreadable (null'd forked_from, or the
  // batched lookup missed it) → the server leaves source_name null → show nothing.
  if (!item.forked_from || !item.source_name) return null
  const diverged =
    !!item.source_updated_at &&
    !!item.created_at &&
    item.source_updated_at > item.created_at
  return { sourceName: item.source_name, diverged }
}
