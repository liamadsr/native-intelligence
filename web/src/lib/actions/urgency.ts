/**
 * The order a list of actions is read in: most urgent first, then the earliest
 * due date, with undated work last.
 *
 * `actions.priority` is the Postgres enum `action_priority` ('none', 'low',
 * 'medium', 'high', 'urgent', migration 022), and an enum sorts by its declared
 * order. Ascending therefore puts `none` first and `urgent` LAST, which, under a
 * limit or a page, pushes the urgent rows off the list entirely. Priority sorts
 * DESCENDING; `due_at` ascending with nulls last.
 */

/** A PostgREST-style `.order(...)`, as a Supabase query builder exposes it. */
interface OrderChain {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): OrderChain
}

/** Order a Supabase `actions` query urgent first, then earliest due, undated last. */
export function orderByUrgency<T>(query: T): T {
  // Unconstrained T + a local cast: a recursive `T extends Orderable<T>` over
  // Supabase's builder type hit TS2589 in Next's production type check.
  return (query as unknown as OrderChain)
    .order('priority', { ascending: false, nullsFirst: false })
    .order('due_at', { ascending: true, nullsFirst: false }) as unknown as T
}

/** Rank per priority, lowest first: the in-memory twin of the enum sorted descending. */
const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

/** Comparator for `Array.prototype.sort`, matching {@link orderByUrgency}. */
export function compareByUrgency(
  a: { priority?: string | null; due_at?: string | null },
  b: { priority?: string | null; due_at?: string | null },
): number {
  const rank = (p: string | null | undefined) => PRIORITY_RANK[p ?? 'none'] ?? PRIORITY_RANK.none
  const byPriority = rank(a.priority) - rank(b.priority)
  if (byPriority !== 0) return byPriority
  if (a.due_at && b.due_at) return a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0
  if (a.due_at) return -1
  if (b.due_at) return 1
  return 0
}
