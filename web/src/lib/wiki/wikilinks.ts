import type { SupabaseClient } from '@supabase/supabase-js'
import { ENTITY_REF_PATTERN } from '@/components/entity-refs/types'
import { MAX_MENTIONED_RECORDS, syncMentions } from '@/lib/entity-links/mentions'
import { parseDocumentMentions } from '@/lib/documents/mention-markdown'
import { MENTION_PICKER_KINDS } from '@/lib/search/menu-search'

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

/** The action identifiers (`GEN-42`) a body names, distinct, in order: the ones the chip layer draws. */
export function parseActionIdentifiers(markdown: string): string[] {
  return [...new Set(markdown.match(new RegExp(ENTITY_REF_PATTERN.source, 'g')) ?? [])]
}

/** Resolve action identifiers to action ids in the workspace; ones naming no action (ISO-8601) aren't in the map. */
export async function resolveActionIdentifiers(
  supabase: SupabaseClient,
  workspaceId: string,
  identifiers: string[],
): Promise<Map<string, string>> {
  if (identifiers.length === 0) return new Map()
  const { data } = await supabase
    .from('actions')
    .select('id, identifier')
    .eq('workspace_id', workspaceId)
    .in('identifier', identifiers.slice(0, MAX_MENTIONED_RECORDS))
  const map = new Map<string, string>()
  for (const row of data || []) {
    if (row.identifier) map.set(row.identifier as string, row.id as string)
  }
  return map
}

/**
 * The target kinds a document's body mentions: what syncDocumentLinks
 * manages. Its wikilinks (documents), identifiers (actions) and `@` chips
 * (every kind the one `@` picker finds: MENTION_PICKER_KINDS).
 */
export const DOCUMENT_MENTION_KINDS = [...new Set(['document', 'action', ...MENTION_PICKER_KINDS] as const)]

/**
 * Make the document's outbound `mentions` edges match what its body mentions
 * now: the documents its wikilinks name, the actions its identifiers
 * (`GEN-42`, drawn as chips) name, and the people and records its `@` chips
 * name (`[@Maya Chen](mention://contact/<id>)`,
 * src/lib/documents/mention-markdown.ts). Through the shared mention helper
 * (src/lib/entity-links/mentions.ts): added and removed as a diff, each target
 * fenced for the editor.
 *
 * Only targets of those kinds and relation 'mentions' are this body's; other
 * relations, and a `mentions` edge to any other kind (an agent's link_entities
 * to a decision, a message, a channel), are left alone.
 *
 * Unresolved slugs are intentionally dropped from the graph (red links in the
 * UI). They can still be discovered by re-parsing the body.
 *
 * `userId` is the editor (their private documents may be linked); absent, it
 * is read from `memberId`'s row, and with neither only workspace documents are.
 */
export async function syncDocumentLinks(
  supabase: SupabaseClient,
  workspaceId: string,
  documentId: string,
  markdown: string,
  memberId: string | null,
  userId?: string | null,
): Promise<{ resolved: number; unresolved: string[] }> {
  const parsed = parseWikilinks(markdown)
  const slugs = parsed.map((p) => p.slug)
  const [resolved, actions] = await Promise.all([
    resolveSlugs(supabase, workspaceId, slugs),
    resolveActionIdentifiers(supabase, workspaceId, parseActionIdentifiers(markdown)),
  ])
  const unresolved = slugs.filter((s) => !resolved.has(s))

  let editor = userId ?? null
  if (!editor && memberId) {
    const { data } = await supabase.from('member').select('user_id').eq('id', memberId).maybeSingle()
    editor = ((data as { user_id?: string | null } | null)?.user_id as string | undefined) ?? null
  }

  const result = await syncMentions(supabase, {
    workspaceId,
    source: { type: 'document', id: documentId },
    targets: [
      ...[...resolved.values()].map((id) => ({ type: 'document' as const, id })),
      ...[...actions.values()].map((id) => ({ type: 'action' as const, id })),
      ...parseDocumentMentions(markdown),
    ],
    userId: editor,
    memberId,
    kinds: DOCUMENT_MENTION_KINDS,
  })
  if (result.error) console.warn('[wikilinks] mention sync failed:', documentId, result.error)

  return { resolved: resolved.size, unresolved }
}
