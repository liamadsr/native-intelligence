/**
 * The canon registry for one reader (canon documents D1;
 * docs/plans/documents-as-ground-truth.md §3.1): which canon documents exist
 * in a workspace, as the "Canon documents" section of every agent's stable
 * system prompt lists them (src/lib/documents/canon.ts renderCanonRegistry).
 *
 * What a reader sees:
 *   - every workspace canon document (a canon_key that isn't personal), and
 *     the workspace product doc as `product` while it has no key of its own
 *     (the pointer, workspace.settings.product_doc);
 *   - their OWN personal canon only (person:voice, content-brief:<channel>):
 *     somebody else's content brief is theirs, not the reader's ground truth;
 *   - never a document they can't see (migration 369: a private document is
 *     its creator's alone). A canon document can't be private (369's guard),
 *     so this only holds the line if that ever changes.
 *   - never an archived one (a system document can't be archived either).
 *
 * Flat cost: three reads in parallel (the workspace canon rows, the reader's
 * own personal canon rows and, unless the caller already has it, the settings
 * blob), plus one only when a product-doc pointer
 * names a document without a key. Kept per (workspace, reader) for
 * CANON_REGISTRY_TTL_MS in this process, so a chat that builds its spec every
 * turn reads it at most that often. Never throws: a failed read is an empty
 * registry this time (the section is left out), never a failed spec.
 *
 * SERVICE-ROLE SAFE: every read is scoped by workspace id.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import { isProductDocEligible, readProductDocPointer, type ProductDocRow } from '@/lib/workspace/product-doc'
import { isPersonalCanonKey, renderCanonRegistry, sortCanonEntries, type CanonEntry } from './canon'

/** How long a reader's registry is reused. An edit or a new canon doc reaches the prompt within this. */
export const CANON_REGISTRY_TTL_MS = 30_000
/** The most canon documents one workspace lists (the registry stays a few lines). */
export const CANON_REGISTRY_MAX = 40
const CACHE_MAX = 500

const cache = new Map<string, { at: number; entries: CanonEntry[] }>()

interface CanonRow {
  id?: unknown
  title?: unknown
  canon_key?: unknown
  updated_at?: unknown
  visibility?: unknown
  owner?: unknown
}

function ownerUserId(row: CanonRow): string | null {
  const owner = Array.isArray(row.owner) ? row.owner[0] : row.owner
  const id = (owner as { user_id?: unknown } | null)?.user_id
  return typeof id === 'string' ? id : null
}

/**
 * The registry entries a reader sees, from the rows (pure): workspace canon,
 * the reader's own personal canon, nothing they can't see. Exported for tests.
 */
export function canonEntriesFor(rows: readonly CanonRow[], readerUserId: string | null): CanonEntry[] {
  const out: CanonEntry[] = []
  for (const row of rows) {
    const key = typeof row.canon_key === 'string' ? row.canon_key : null
    if (!key) continue
    const owner = ownerUserId(row)
    const mine = readerUserId !== null && owner === readerUserId
    if (row.visibility === 'private' && !mine) continue
    const personal = isPersonalCanonKey(key)
    if (personal && !mine) continue
    out.push({
      key,
      title: typeof row.title === 'string' && row.title.trim() ? row.title : key,
      owner: personal ? 'you' : 'admins',
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    })
  }
  return sortCanonEntries(out)
}

/**
 * The reader's registry entries (see the header). `settings` is the
 * workspace.settings blob when the caller already read it (the chat spec
 * does); otherwise it is read here, beside the canon rows.
 */
export async function loadCanonRegistry(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string | null; settings?: unknown | Promise<unknown> },
  nowMs: number = Date.now(),
): Promise<CanonEntry[]> {
  if (!args.workspaceId) return []
  const cacheKey = `${args.workspaceId}|${args.userId ?? ''}`
  const hit = cache.get(cacheKey)
  if (hit && nowMs - hit.at < CANON_REGISTRY_TTL_MS) return hit.entries
  try {
    // Two reads, so the cap applies to each kind on its own: everyone's
    // personal canon (a content brief per person) can never crowd `product`
    // out of the workspace list, and the reader's own is read by itself.
    const [sharedRes, mineRes, settings] = await Promise.all([
      supabase
        .from('document')
        .select('id, title, canon_key, updated_at, visibility, owner:member!created_by(user_id)')
        .eq('workspace_id', args.workspaceId)
        .not('canon_key', 'is', null)
        .not('canon_key', 'like', 'person:%')
        .not('canon_key', 'like', 'content-brief:%')
        .neq('status', 'archived')
        .order('canon_key', { ascending: true })
        .limit(CANON_REGISTRY_MAX),
      args.userId
        ? supabase
            .from('document')
            .select('id, title, canon_key, updated_at, visibility, owner:member!created_by!inner(user_id)')
            .eq('workspace_id', args.workspaceId)
            .eq('owner.user_id', args.userId)
            .or('canon_key.like.person:*,canon_key.like.content-brief:*')
            .neq('status', 'archived')
            .order('canon_key', { ascending: true })
            .limit(CANON_REGISTRY_MAX)
        : Promise.resolve({ data: [], error: null }),
      args.settings !== undefined ? Promise.resolve(args.settings) : fetchWorkspaceSettings(supabase, args.workspaceId),
    ])
    if (sharedRes.error) throw new Error(sharedRes.error.message)
    if (mineRes.error) throw new Error(mineRes.error.message)
    const rows = [...((sharedRes.data ?? []) as CanonRow[]), ...((mineRes.data ?? []) as CanonRow[])]
    const entries = canonEntriesFor(rows, args.userId)

    // The product doc is canon `product` while it has no key of its own.
    const pointer = readProductDocPointer(settings)
    if (pointer && !entries.some((e) => e.key === 'product') && !rows.some((r) => r.id === pointer.document_id)) {
      const { data } = await supabase
        .from('document')
        .select('id, title, updated_at, status, published_status, type, frontmatter, visibility')
        .eq('id', pointer.document_id)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      const doc = data as (ProductDocRow & { title?: unknown; updated_at?: unknown }) | null
      if (doc && isProductDocEligible(doc)) {
        entries.push({
          key: 'product',
          title: typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'Product doc',
          owner: 'admins',
          updatedAt: typeof doc.updated_at === 'string' ? doc.updated_at : null,
        })
      }
    }

    const sorted = sortCanonEntries(entries)
    cache.delete(cacheKey)
    cache.set(cacheKey, { at: nowMs, entries: sorted })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return sorted
  } catch (err) {
    console.warn('[canon-registry] skipped:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * The "Canon documents" prompt section for a reader, with its leading blank
 * line, or '' when the workspace has none (or the read failed). What every
 * spec builder appends beside "Available skills".
 */
export async function canonRegistrySection(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string | null; settings?: unknown | Promise<unknown> },
): Promise<string> {
  const section = renderCanonRegistry(await loadCanonRegistry(supabase, args))
  return section ? `\n\n${section}` : ''
}

/** Forget a workspace's kept registries (after a canon document is created or retitled here). */
export function forgetCanonRegistry(workspaceId: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${workspaceId}|`)) cache.delete(key)
}

/** Tests: forget every kept registry. */
export function clearCanonRegistryCache(): void {
  cache.clear()
}
