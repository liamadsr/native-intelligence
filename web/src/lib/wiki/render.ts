import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, inChunks, type PageResult } from '@/lib/supabase/paging'
import { canonicalEntityType } from '@/lib/knowledge/entity-registry'

/**
 * Embedded-query block syntax. Lives inside markdown bodies and is resolved
 * at render time against live tables. The stored body is the source of truth —
 * resolved blocks are never written back.
 *
 * Examples:
 *   {{claims: about=contact:abc-123 type=open_question limit=10}}
 *   {{captures: contact=abc-123 limit=5}}
 *   {{links: to=project:onboarding}}
 *
 * Grammar (per block):
 *   {{<kind>: <key>=<value> <key>=<value> ...}}
 *
 * Values are simple scalars (no quoted strings, no commas). `<entity>:<uuid>`
 * is the convention for typed entity refs.
 */
const BLOCK_RE = /\{\{(claims|captures|links):\s*([^}]*?)\}\}/g

const ALLOWED_ENTITY_TYPES = new Set([
  'document',
  'claim',
  'capture',
  'contact',
  'project',
  'action',
  'initiative',
  'cycle',
  'email_thread',
  'attachment',
])

const CLAIM_TYPES = new Set(['fact', 'open_question', 'inference', 'decision_summary'])
const CLAIM_STATUSES = new Set(['active', 'superseded', 'disputed', 'archived'])

interface ParsedBlock {
  raw: string
  kind: 'claims' | 'captures' | 'links'
  params: Record<string, string>
}

function parseParams(paramStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const token of paramStr.trim().split(/\s+/)) {
    if (!token) continue
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    const k = token.slice(0, eq).trim()
    const v = token.slice(eq + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

function parseEntityRef(value: string): { type: string; id: string } | null {
  const idx = value.indexOf(':')
  if (idx <= 0) return null
  // A stored body may still say `email:<id>`: the retired name reads as `email_thread` (503).
  const type = canonicalEntityType(value.slice(0, idx))
  const id = value.slice(idx + 1)
  if (!ALLOWED_ENTITY_TYPES.has(type) || !id) return null
  return { type, id }
}

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

export interface RenderedBlock {
  raw: string
  kind: 'claims' | 'captures' | 'links'
  data: unknown
  error?: string
}

/**
 * Parse + resolve every block in a markdown body. Returns the original body
 * and a list of resolved blocks. The caller decides how to splice them back
 * in (inline replacement, side panel, etc.).
 *
 * Errors per block are returned in-band — one bad block doesn't fail the page.
 */
export async function renderEmbeddedQueries(
  supabase: SupabaseClient,
  workspaceId: string,
  markdown: string,
): Promise<{ body: string; blocks: RenderedBlock[] }> {
  const blocks: ParsedBlock[] = []
  let match: RegExpExecArray | null
  BLOCK_RE.lastIndex = 0
  while ((match = BLOCK_RE.exec(markdown)) !== null) {
    blocks.push({
      raw: match[0],
      kind: match[1] as ParsedBlock['kind'],
      params: parseParams(match[2] ?? ''),
    })
  }

  const resolved: RenderedBlock[] = []
  for (const block of blocks) {
    try {
      const data = await resolveBlock(supabase, workspaceId, block)
      resolved.push({ raw: block.raw, kind: block.kind, data })
    } catch (err) {
      resolved.push({
        raw: block.raw,
        kind: block.kind,
        data: null,
        error: err instanceof Error ? err.message : 'Resolve failed',
      })
    }
  }

  return { body: markdown, blocks: resolved }
}

async function resolveBlock(
  supabase: SupabaseClient,
  workspaceId: string,
  block: ParsedBlock,
): Promise<unknown> {
  switch (block.kind) {
    case 'claims':
      return resolveClaims(supabase, workspaceId, block.params)
    case 'captures':
      return resolveCaptures(supabase, workspaceId, block.params)
    case 'links':
      return resolveLinks(supabase, workspaceId, block.params)
  }
}

/**
 * The newest `limit` rows among `ids`, read 100 ids at a time: a busy entity's
 * few hundred linked ids in one `id=in.(…)` overflowed the request URL and the
 * embed rendered as an error. Each chunk runs the same newest-first read capped
 * at `limit`, so the merged, re-sorted head is exact. No ids: one plain read.
 */
async function newestByIds<T extends Record<string, unknown>>(
  ids: string[] | null,
  field: string,
  limit: number,
  run: (chunkIds: string[] | null) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const { data, error } = ids ? await inChunks(ids, 100, (chunkIds) => run(chunkIds)) : await run(null)
  if (error) throw new Error(error.message)
  const at = (r: T) => Date.parse(String(r[field] ?? '')) || 0
  return [...(data ?? [])].sort((a, b) => at(b) - at(a)).slice(0, limit)
}

async function resolveClaims(
  supabase: SupabaseClient,
  workspaceId: string,
  params: Record<string, string>,
) {
  const limit = parseLimit(params.limit, 10, 100)
  const type = params.type && CLAIM_TYPES.has(params.type) ? params.type : null
  const status = params.status && CLAIM_STATUSES.has(params.status) ? params.status : 'active'

  let claimIds: string[] | null = null
  if (params.about) {
    const ref = parseEntityRef(params.about)
    if (!ref) throw new Error(`Invalid "about" ref: ${params.about}`)
    // Paged: a busy entity holds more than one response (1000) of links.
    const { data: links, error: linkError } = await fetchAllRows(() =>
      supabase
        .from('entity_link')
        .select('source_id')
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim')
        .eq('target_type', ref.type)
        .eq('target_id', ref.id),
    )
    if (linkError) throw new Error(linkError.message)
    claimIds = [...new Set(links.map((l) => l.source_id as string))]
    if (claimIds.length === 0) return []
  }

  return newestByIds(claimIds, 'updated_at', limit, (ids) => {
    let query = supabase
      .from('claim')
      .select('id, text, type, confirmation, status, confidence, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('status', status)
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (ids) query = query.in('id', ids)
    if (type) query = query.eq('type', type)
    return query
  })
}

async function resolveCaptures(
  supabase: SupabaseClient,
  workspaceId: string,
  params: Record<string, string>,
) {
  const limit = parseLimit(params.limit, 10, 50)

  let captureIds: string[] | null = null
  if (params.contact) {
    // Captures linked to a contact via entity_link (relation: any).
    const { data: links, error: linkError } = await fetchAllRows(() =>
      supabase
        .from('entity_link')
        .select('source_id')
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'capture')
        .eq('target_type', 'contact')
        .eq('target_id', params.contact),
    )
    if (linkError) throw new Error(linkError.message)
    captureIds = [...new Set(links.map((l) => l.source_id as string))]
    if (captureIds.length === 0) return []
  }

  return newestByIds(captureIds, 'created_at', limit, (ids) => {
    let query = supabase
      .from('captures')
      .select('id, title, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (ids) query = query.in('id', ids)
    if (params.project) query = query.eq('project_id', params.project)
    return query
  })
}

async function resolveLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  params: Record<string, string>,
) {
  const limit = parseLimit(params.limit, 25, 100)

  if (params.to) {
    const ref = parseEntityRef(params.to)
    if (!ref) throw new Error(`Invalid "to" ref: ${params.to}`)
    const { data, error } = await supabase
      .from('entity_link')
      .select('id, source_type, source_id, relation, created_at')
      .eq('workspace_id', workspaceId)
      .eq('target_type', ref.type)
      .eq('target_id', ref.id)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    return data || []
  }

  if (params.from) {
    const ref = parseEntityRef(params.from)
    if (!ref) throw new Error(`Invalid "from" ref: ${params.from}`)
    const { data, error } = await supabase
      .from('entity_link')
      .select('id, target_type, target_id, relation, created_at')
      .eq('workspace_id', workspaceId)
      .eq('source_type', ref.type)
      .eq('source_id', ref.id)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    return data || []
  }

  throw new Error('links block needs either to=<entity:id> or from=<entity:id>')
}
