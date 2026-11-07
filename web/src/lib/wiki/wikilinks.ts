import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Obsidian-style wikilink: `[[slug]]` or `[[slug|display text]]`.
 *
 * Slug shape: kebab-case-ish — letters, numbers, hyphens, underscores, dots,
 * slashes (for sub-paths). Anything more exotic is intentionally ignored so
 * we don't mis-tag random `[[foo bar]]` typos as links.
 */
const WIKILINK_RE = /\[\[([a-zA-Z0-9_\-./]+)(?:\|([^\]]+))?\]\]/g

export interface ParsedWikilink {
  raw: string
  slug: string
  display: string | null
}

/** Extract every wikilink in a markdown body. Duplicate slugs collapse. */
export function parseWikilinks(markdown: string): ParsedWikilink[] {
  const seen = new Map<string, ParsedWikilink>()
  let match: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((match = WIKILINK_RE.exec(markdown)) !== null) {
    const slug = match[1]
    if (!seen.has(slug)) {
      seen.set(slug, { raw: match[0], slug, display: match[2] ?? null })
    }
  }
  return [...seen.values()]
}

/**
 * Resolve a list of slugs to document UUIDs within a workspace.
 * Returns a `Map<slug, documentId>` — missing slugs simply aren't in the map.
 */
export async function resolveSlugs(
  supabase: SupabaseClient,
  workspaceId: string,
  slugs: string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map()
  const { data } = await supabase
    .from('document')
    .select('id, slug')
    .eq('workspace_id', workspaceId)
    .in('slug', slugs)
  const map = new Map<string, string>()
  for (const row of data || []) {
    if (row.slug) map.set(row.slug as string, row.id as string)
  }
  return map
}

/**
 * Rewrite `entity_link` rows so that the document's outbound `mentions` edges
 * match the wikilinks currently in its body.
 *
 * Only touches edges where source_type='document' AND source_id=docId AND
 * relation='mentions'. Other relations (depends_on, cites, etc.) authored by
 * agents or the user are left alone — wikilinks are a fast-moving subset.
 *
 * Unresolved slugs are intentionally dropped from the graph (red links in the
 * UI). They can still be discovered by re-parsing the body.
 */
export async function syncDocumentLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  documentId: string,
  markdown: string,
  memberId: string | null,
): Promise<{ resolved: number; unresolved: string[] }> {
  const parsed = parseWikilinks(markdown)
  const slugs = parsed.map((p) => p.slug)
  const resolved = await resolveSlugs(supabase, workspaceId, slugs)
  const unresolved = slugs.filter((s) => !resolved.has(s))

  // Wipe existing mentions edges from this document; we'll re-create.
  await supabase
    .from('entity_link')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'document')
    .eq('source_id', documentId)
    .eq('relation', 'mentions')

  const inserts: Array<Record<string, unknown>> = []
  for (const [, targetId] of resolved) {
    if (targetId === documentId) continue // can't link to self
    inserts.push({
      workspace_id: workspaceId,
      source_type: 'document',
      source_id: documentId,
      target_type: 'document',
      target_id: targetId,
      relation: 'mentions',
      created_by: memberId,
    })
  }

  if (inserts.length > 0) {
    // Idempotent insert: unique constraint will dedupe across racing writes.
    await supabase.from('entity_link').insert(inserts)
  }

  return { resolved: resolved.size, unresolved }
}
