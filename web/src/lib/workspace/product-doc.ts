/**
 * The workspace's ONE curated product doc (live sidekick plan, Phase 6): the
 * document an owner or admin names as the source of truth for product facts
 * (features, pricing, limits, integrations, roadmap). On a call the live agent
 * states product facts only from it; the chat agent can reuse the loader later.
 *
 * Storage: a pointer at `workspace.settings.product_doc`
 * (`{ document_id, set_by, set_at }`), written by
 * /api/account/workspace/product-doc. No migration: `settings` already holds
 * sibling keys (edition, trust_policy, default_agents).
 *
 * WHICH DOCUMENTS QUALIFY (isProductDocEligible), checked when it is set AND
 * every time it is read, because the agent serves every member's calls and a
 * document can change after it was picked:
 *   - in this workspace and `status = 'active'` (not archived);
 *   - published (`published_status = 'published'`): an unreviewed draft (the
 *     wiki review queue) is not curated;
 *   - not a generated spec page (`type = 'spec'`, rebuilt by machine);
 *   - not someone's own: a private document (migration 369, "Only me"), or a
 *     meeting prep (`frontmatter.meeting_prep`, which 369 made private but a
 *     prep is one person's whatever its visibility, precall-brief.ts).
 *
 * SERVICE-ROLE SAFE: the loader scopes its one query by (id, workspace), so it
 * is fenced without RLS (the live agent's eve rebuild runs on the service role).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MEETING_PREP_KEY } from '@/lib/agent-events/prep-ref'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'

/** The key under `workspace.settings`. */
export const PRODUCT_DOC_SETTINGS_KEY = 'product_doc'

export interface ProductDocPointer {
  document_id: string
  /** The member who set it; null when the stored value had none. */
  set_by: string | null
  /** When it was set (ISO); null when the stored value had none. */
  set_at: string | null
}

const ID_RE = /^[0-9a-zA-Z_-]{1,64}$/

/** Whether a value is a plain id the pointer may hold (the route checks input with it). Pure. */
export function isProductDocId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/**
 * The pointer from a raw `workspace.settings` blob, or null. Tolerates junk: a
 * non-object blob, a missing or malformed key, or a document id that isn't a
 * plain id all read as "no product doc". Pure.
 */
export function readProductDocPointer(settings: unknown): ProductDocPointer | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const raw = (settings as Record<string, unknown>)[PRODUCT_DOC_SETTINGS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (typeof v.document_id !== 'string' || !ID_RE.test(v.document_id)) return null
  const setBy = typeof v.set_by === 'string' && ID_RE.test(v.set_by) ? v.set_by : null
  const setAt = typeof v.set_at === 'string' && Number.isFinite(Date.parse(v.set_at)) ? v.set_at : null
  return { document_id: v.document_id, set_by: setBy, set_at: setAt }
}

/**
 * The product doc's id in this workspace, or null (none set, or the settings
 * couldn't be read). A batch archive leaves it out: it is a system document
 * (migration 366), and one refused row would fail the whole update.
 */
export async function productDocIdOf(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  return readProductDocPointer(await fetchWorkspaceSettings(supabase, workspaceId))?.document_id ?? null
}

/** The document columns eligibility and the loader read. */
export const PRODUCT_DOC_COLUMNS = 'id, title, content, updated_at, status, published_status, type, frontmatter, visibility'

export interface ProductDocRow {
  id?: unknown
  title?: unknown
  content?: unknown
  updated_at?: unknown
  status?: unknown
  published_status?: unknown
  type?: unknown
  frontmatter?: unknown
  visibility?: unknown
}

export type ProductDocIneligibleReason = 'archived' | 'draft' | 'spec' | 'private' | 'personal'

/**
 * Whether a document row may be the product doc, and why not. The row must
 * already be scoped to the workspace (the caller's query does that). Pure.
 */
export function productDocIneligibility(row: ProductDocRow): ProductDocIneligibleReason | null {
  if (row.status !== 'active') return 'archived'
  if (row.published_status !== undefined && row.published_status !== 'published') return 'draft'
  if (row.type === 'spec') return 'spec'
  if (row.visibility === 'private') return 'private'
  const fm = row.frontmatter
  if (fm && typeof fm === 'object' && !Array.isArray(fm) && (fm as Record<string, unknown>)[MEETING_PREP_KEY] !== undefined) {
    return 'personal'
  }
  return null
}

export function isProductDocEligible(row: ProductDocRow): boolean {
  return productDocIneligibility(row) === null
}

/** The product doc as the agents read it. */
export interface ProductDoc {
  documentId: string
  title: string
  /** The document's text (markdown), trimmed; never empty. */
  text: string
  updatedAt: string | null
}

/**
 * The product doc by id, scoped to the workspace: ONE query. Null when it is
 * gone, not eligible, or empty. Throws on a failed read.
 */
export async function loadProductDoc(
  supabase: SupabaseClient,
  args: { workspaceId: string; documentId: string },
): Promise<ProductDoc | null> {
  const { data, error } = await supabase
    .from('document')
    .select(PRODUCT_DOC_COLUMNS)
    .eq('id', args.documentId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`product doc read failed: ${error.message}`)
  const row = data as ProductDocRow | null
  if (!row || !isProductDocEligible(row)) return null
  const text = typeof row.content === 'string' ? row.content.trim() : ''
  if (!text) return null
  return {
    documentId: args.documentId,
    title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Product doc',
    text,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  }
}

/**
 * Write (or, with null, clear) the pointer: a read-modify-write of the
 * settings blob that touches only `product_doc`, every sibling key kept. The
 * workspace UPDATE policy is owner-only (migration 013), so callers pass a
 * SERVICE client after their own owner/admin gate; `.select('id')` makes the
 * write assert its effect (a 0-row update is an error, never a silent ok).
 */
export async function setWorkspaceProductDoc(
  supabase: SupabaseClient,
  workspaceId: string,
  pointer: ProductDocPointer | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  const raw = (data as { settings?: unknown } | null)?.settings
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  if (pointer) settings[PRODUCT_DOC_SETTINGS_KEY] = pointer
  else delete settings[PRODUCT_DOC_SETTINGS_KEY]
  const { data: updated, error: writeErr } = await supabase
    .from('workspace')
    .update({ settings })
    .eq('id', workspaceId)
    .select('id')
  if (writeErr) return { ok: false, error: writeErr.message }
  if (!updated || (updated as unknown[]).length === 0) return { ok: false, error: 'Workspace product doc update affected no rows' }
  return { ok: true }
}

// ── The per-turn copy ─────────────────────────────────────────────────────────

/** How long a workspace's product doc is reused across turns. An edit reaches the agent within this. */
export const PRODUCT_DOC_TTL_MS = 15_000
const CACHE_MAX = 200
const cache = new Map<string, { at: number; doc: ProductDoc | null }>()

/**
 * The product doc for an agent turn, from the `workspace.settings` blob the
 * turn already read. No pointer → null with NO read. Otherwise loadProductDoc,
 * reused for PRODUCT_DOC_TTL_MS per (workspace, document id) in this process,
 * so a turn every few seconds reads it at most every 15 s; re-pointing to
 * another document is a new key, so it takes effect on the next turn. At most
 * CACHE_MAX entries (the oldest let go). A failed read is no doc this turn
 * (logged once, not kept). Never throws.
 */
export async function loadProductDocForTurn(
  supabase: SupabaseClient,
  args: { workspaceId: string; settings: unknown },
  nowMs: number = Date.now(),
): Promise<ProductDoc | null> {
  const pointer = readProductDocPointer(args.settings)
  if (!pointer || !args.workspaceId) return null
  const key = `${args.workspaceId}|${pointer.document_id}`
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < PRODUCT_DOC_TTL_MS) return hit.doc
  try {
    const doc = await loadProductDoc(supabase, { workspaceId: args.workspaceId, documentId: pointer.document_id })
    cache.delete(key)
    cache.set(key, { at: nowMs, doc })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return doc
  } catch (err) {
    console.warn('[product-doc] skipped this turn:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Tests: forget every kept doc. */
export function clearProductDocCache(): void {
  cache.clear()
}
