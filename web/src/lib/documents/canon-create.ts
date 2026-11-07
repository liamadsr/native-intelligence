/**
 * Creating a canon document from its template (canon documents D2;
 * docs/plans/documents-as-ground-truth.md §3.2): the template's fixed `##`
 * headings, empty, under the key, as a published system document.
 *
 *   who      workspace canon (product, team-playbook): an owner or admin, as
 *            setting a canon key always was (366). Personal canon
 *            (person:voice, content-brief:<channel>): any member, for
 *            themselves (375). Guests: never.
 *   once     a key that already has its document returns that document
 *            (`existing`); nothing is created twice.
 *   product  decision 10: the product doc grows into the brand context. A
 *            workspace whose product doc pointer already names a document
 *            keeps that document: it is given the key (`adopted`), its text
 *            untouched, and the template's missing sections are listed for the
 *            agent to add. A new product doc also becomes the pointer's, so
 *            every reader of the product doc (the live agent, the admin-only
 *            edit rule) reads the canon.
 *
 * The template text lives in code (canon.ts), never in the database. Callers
 * pass a SERVICE-ROLE client: the checks are here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readProductDocPointer, setWorkspaceProductDoc } from '@/lib/workspace/product-doc'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import { canonDefaultTitle, canonSkeleton, isPersonalCanonKey, templateForKey } from './canon'
import { resolveCanonDocument } from './canon-doc'
import { forgetCanonRegistry } from './canon-registry'
import { findSection, parseOutline } from './markdown-structure'

export type CreateCanonResult =
  | {
      ok: true
      outcome: 'created' | 'existing' | 'adopted'
      document: { id: string; title: string | null; canon_key: string }
      /** The template's headings the document lacks (an adopted or older document). */
      missingSections: string[]
    }
  | { ok: false; status: 400 | 403 | 409 | 500; error: string }

/** The template headings `content` lacks. Pure. */
export function missingTemplateSections(key: string, content: string | null | undefined): string[] {
  const template = templateForKey(key)
  if (!template) return []
  const outline = parseOutline(content ?? '')
  return template.sections.filter((s) => !findSection(outline, s.heading).ok).map((s) => s.heading)
}

export async function createCanonDocument(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; key: string; title?: string | null },
): Promise<CreateCanonResult> {
  const { workspaceId, key } = args
  const template = templateForKey(key)
  if (!template) return { ok: false, status: 400, error: `No template makes \`${key}\`. Templates: product, team-playbook, person:voice, content-brief:<channel>.` }

  const { data: member } = await supabase.from('member').select('id, role').eq('workspace_id', workspaceId).eq('user_id', args.userId).maybeSingle()
  const memberId = (member as { id?: unknown } | null)?.id
  const role = (member as { role?: unknown } | null)?.role
  if (typeof memberId !== 'string' || (role !== 'owner' && role !== 'admin' && role !== 'member')) {
    return { ok: false, status: 403, error: 'Not a workspace member' }
  }
  const personal = isPersonalCanonKey(key)
  if (!personal && role !== 'owner' && role !== 'admin') {
    return { ok: false, status: 403, error: `Only an owner or admin can create the workspace's \`${key}\` document. Ask one of them, or suggest it to them.` }
  }

  const settings = key === 'product' ? await fetchWorkspaceSettings(supabase, workspaceId) : undefined
  const existing = await resolveCanonDocument(supabase, { workspaceId, userId: args.userId, key, settings })
  if (existing.ok) {
    const doc = existing.doc
    if (!doc.canon_key) {
      // The product doc, not yet keyed: it becomes the canon, its text kept.
      const { error } = await supabase
        .from('document')
        .update({ canon_key: key })
        .eq('id', doc.id)
        .eq('workspace_id', workspaceId)
        .is('canon_key', null)
      if (error) return { ok: false, status: error.code === '23505' ? 409 : 500, error: error.message }
      forgetCanonRegistry(workspaceId)
      return { ok: true, outcome: 'adopted', document: { id: doc.id, title: doc.title, canon_key: key }, missingSections: missingTemplateSections(key, doc.content) }
    }
    return { ok: true, outcome: 'existing', document: { id: doc.id, title: doc.title, canon_key: key }, missingSections: missingTemplateSections(key, doc.content) }
  }
  if (existing.reason === 'error') return { ok: false, status: 500, error: existing.error }
  if (existing.reason === 'not_member') return { ok: false, status: 403, error: 'Not a workspace member' }

  const title = args.title?.trim() || canonDefaultTitle(key)
  const { data, error } = await supabase
    .from('document')
    .insert({
      workspace_id: workspaceId,
      title,
      content: canonSkeleton(template),
      canon_key: key,
      created_by: memberId,
      last_edited_by: memberId,
      status: 'active',
      published_status: 'published',
      visibility: 'workspace',
    })
    .select('id, title, canon_key')
    .single()
  if (error || !data) {
    // Two creates at once: the unique index (366/375) keeps one; return it.
    if ((error as { code?: string } | null)?.code === '23505') {
      const again = await resolveCanonDocument(supabase, { workspaceId, userId: args.userId, key, settings })
      if (again.ok) return { ok: true, outcome: 'existing', document: { id: again.doc.id, title: again.doc.title, canon_key: key }, missingSections: [] }
    }
    return { ok: false, status: 500, error: error?.message ?? 'Could not create the document' }
  }

  // A new product doc is the workspace product doc too (decision 10).
  if (key === 'product' && !readProductDocPointer(settings)) {
    const set = await setWorkspaceProductDoc(supabase, workspaceId, { document_id: data.id as string, set_by: memberId, set_at: new Date().toISOString() })
    if (!set.ok) console.warn('[canon-create] product doc pointer not set:', set.error)
  }
  forgetCanonRegistry(workspaceId)
  return { ok: true, outcome: 'created', document: { id: data.id as string, title: (data.title as string | null) ?? title, canon_key: key }, missingSections: [] }
}
