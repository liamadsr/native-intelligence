/**
 * The canon tools (canon documents D1/D2; docs/plans/documents-as-ground-truth.md
 * §3, eve-alignment.md §4): the few named documents every agent is grounded
 * in, addressed by key, never searched for.
 *
 *   read_canon(key, section?)   one canon document, or one named section of
 *                               it. No search and no time window; the caller's
 *                               visibility and access hold.
 *   create_canon_document       a canon document from its template (D2): the
 *                               fixed `##` headings, empty (canon-create.ts).
 *   propose_section_edit        one section edit (D2, decision 16): applied
 *                               at once, in the history with its sources, one
 *                               digest line, labelled when it rests on outside
 *                               text (canon-sources.ts). Never a card: a caller
 *                               who may not edit the document is refused.
 *   revert_section_edit         undo just one edit, at section level, keeping
 *                               every later edit to other sections. Attended
 *                               only (ATTENDED_ONLY_TOOL_NAMES), as restoring
 *                               a version is.
 *
 * These run on a SERVICE-ROLE client on the eve tool proxies and the MCP
 * bridge, so every read is scoped to the session workspace here (canon is
 * never resolved across workspaces) and a personal key is always the caller's
 * own (src/lib/documents/canon-doc.ts).
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canonEditForbidden, isPersonalCanonKey, normalizeCanonKey, templateForKey, templateKey, TEMPLATE_KEYS } from '@/lib/documents/canon'
import { createCanonDocument } from '@/lib/documents/canon-create'
import { canonEditCheck, lintCanonDocument } from '@/lib/documents/canon-lint'
import { evidenceFromSources } from '@/lib/marketing/claim-evidence'
import { newProvenLine } from '@/lib/marketing/grade'
import { loadCanonRegistry } from '@/lib/documents/canon-registry'
import { canonOwnerLabel, resolveCanonDocument, type CanonDocRow } from '@/lib/documents/canon-doc'
import { applyCanonSectionEdit, revertSectionEdit, type CanonSectionOp } from '@/lib/documents/canon-edit'
import { CANON_SOURCE_KINDS, canonOutsideLabel, classifyCanonSources, normalizeCanonSources, turnOutsideReads, type TurnOutsideReads } from '@/lib/documents/canon-sources'
import { documentUpdateRefusal, loadDocumentAccess } from '@/lib/documents/access'
import { resolveEntityWorkspace } from './_shared'
import { describeCandidates, findSection, outlineForModel, parseOutline, splitLines } from '@/lib/documents/markdown-structure'
import { documentContentForModel, LONG_DOCUMENT_CHARS } from './documents'

/** The outline of a canon document, with each fixed section's hint when it is still empty. Pure. */
export function canonOutline(key: string, content: string) {
  const outline = parseOutline(content)
  const template = templateForKey(key)
  const lines = splitLines(content)
  const empty = template
    ? template.sections.filter((s) => {
        const found = findSection(outline, s.heading)
        if (!found.ok) return false
        return lines.slice(found.entry.line, found.entry.endLine).every((l) => l.trim() === '')
      })
    : []
  return {
    outline: outlineForModel(outline),
    ...(empty.length ? { empty_sections: empty.map((s) => ({ heading: s.heading, what_belongs_here: s.hint })) } : {}),
  }
}

/** A section's text: its heading line and everything under it. Pure. */
export function sectionText(content: string, entry: { line: number; endLine: number }): string {
  return splitLines(content).slice(entry.line - 1, entry.endLine).join('\n').trim()
}

/** Who is asking, for an edit's provenance label (canon-sources.ts). */
export interface CanonToolContext {
  /** A person is in the conversation (default: not an unattended run). */
  attended: boolean
  /** The work run whose outside reads count (agent_run.outside_reads), when the caller is one. */
  outsideReadsRunId?: string | null
  /** A loop run's own record of what it read (skill-run-reads.ts), when the caller is one: used instead of the work run's. */
  readOutside?: () => Promise<TurnOutsideReads>
}

export function createCanonTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  ctx: CanonToolContext = { attended: true },
) {
  /** The keys the caller can read, for a refusal that names them. */
  async function knownKeys(): Promise<string[]> {
    return (await loadCanonRegistry(supabase, { workspaceId, userId })).map((e) => e.key)
  }

  function notFound(key: string, keys: string[]) {
    return {
      success: false as const,
      error:
        `No canon document \`${key}\` in this workspace.` +
        (keys.length ? ` Canon documents: ${keys.map((k) => `\`${k}\``).join(', ')}.` : ' It has none yet.') +
        (templateForKey(key) ? ` Create it from its template with create_canon_document.` : ''),
    }
  }

  function header(key: string, doc: CanonDocRow, memberId: string | null) {
    return {
      success: true as const,
      key,
      document_id: doc.id,
      title: doc.title,
      revision: doc.revision ?? 1,
      owner: canonOwnerLabel(key, doc, memberId),
      updated_at: doc.updated_at,
    }
  }

  return {
    propose_section_edit: tool({
      description:
        'Edit one section of a canon document by key: replace its text, append to it, or remove it (a fixed template section is cleared, not deleted). ' +
        'It applies at once (the owner can undo it from the history, or ask you to revert it), lands in the history with your reason and sources, and shows as one line in the daily digest. ' +
        'Name every source: the call, chat, document, claim, action or project it came from (with its id), or the email (with its sender), web page or outside message. ' +
        'An edit that rests on outside text (an email from someone the person does not know, a web page, a message from outside the workspace), or made by a run that read such text, still applies, labelled so in the history and the digest. Only someone who may edit the document can: anyone else is refused. ' +
        'Preserve wording you were not asked to change; resolve an open question by moving it, never by deleting it. ' +
        "In the product doc's Who it's for, Positioning and Messaging, end every bullet with its grade: [proven] (calls with two or more companies, or a document a person wrote, named in sources), [plausible] (it follows from how the product works) or [assumption]. " +
        'Each canon document has a size budget (read_canon shows it): an edit that would leave it over must make it no longer and name what it cuts in `removes`. Pass base_revision from read_canon.',
      inputSchema: z.object({
        key: z.string().describe('The canon key, e.g. "product"'),
        section: z.string().describe('The section heading, or a "Parent > Heading" path'),
        op: z.enum(['replace', 'append', 'remove']).describe('replace its text, append to it, or remove it'),
        text: z.string().optional().describe('The new text (markdown, without the heading); not for remove'),
        reason: z.string().describe('Why, in one line (shown in the history)'),
        sources: z
          .array(
            z.object({
              kind: z.enum(CANON_SOURCE_KINDS),
              id: z.string().optional().describe('The row id: capture, document, claim, action or project'),
              from: z.string().optional().describe('An email: the sender address'),
              url: z.string().optional().describe('A web page'),
              note: z.string().optional().describe('Which part, who said it'),
            }),
          )
          .optional()
          .describe('What the edit came from (empty: this conversation)'),
        removes: z.string().optional().describe('When the document is at its size budget: what this edit cuts to make room'),
        base_revision: z.number().int().optional().describe('The revision you read (read_canon returns it)'),
      }),
      execute: async ({ key: asked, section, op, text, reason, sources: rawSources, removes, base_revision }) => {
        const key = normalizeCanonKey(asked)
        if (!key) return { success: false, error: `"${asked}" is not a canon key.` }
        if (op !== 'remove' && !(text ?? '').trim()) return { success: false, error: `Pass the text to ${op === 'append' ? 'append' : 'put in the section'}.` }
        const found = await resolveCanonDocument(supabase, { workspaceId, userId, key })
        if (!found.ok) {
          if (found.reason === 'error') return { success: false, error: found.error }
          if (found.reason === 'not_member') return { success: false, error: 'Not a workspace member' }
          return notFound(key, await knownKeys())
        }
        const { doc } = found
        const sources = normalizeCanonSources(rawSources)
        const { access } = await loadDocumentAccess(supabase, workspaceId, userId, doc.id)
        const mayEdit = !!access && documentUpdateRefusal(access, { content: '' }) === null
        // Not allowed to edit it (#774): refused, never routed to a card.
        if (!mayEdit) return { success: false, error: canonEditForbidden(key, doc.title) }
        // What the turn READ counts, never only what it cites (canon-sources.ts):
        // an edit resting on outside text applies, labelled so.
        const reads = ctx.readOutside
          ? await ctx.readOutside()
          : await turnOutsideReads(supabase, { workspaceId, attended: ctx.attended, runId: ctx.outsideReadsRunId })
        const trust = await classifyCanonSources(supabase, sources, { workspaceId, userId, attended: ctx.attended, runReadOutsideText: reads.read })
        const outside = canonOutsideLabel(sources, trust, reads)
        const editText = op === 'remove' ? '' : (text ?? '')
        // Budgets and the fixed sections (canon-lint.ts), checked on the
        // document as the edit would leave it. The product doc's graded claims
        // (marketing M0): a line marked [proven] needs the evidence its sources
        // show, counted here, never the model's word
        // (src/lib/marketing/claim-evidence.ts).
        const evidence = key === 'product' && newProvenLine(editText, doc.content ?? '', section)
          ? await evidenceFromSources(supabase, workspaceId, sources, doc.id)
          : null
        const check = canonEditCheck(key, { section, text: editText, removes: removes ?? null }, { evidence })

        const result = await applyCanonSectionEdit(supabase, {
          workspaceId,
          userId,
          documentId: doc.id,
          key,
          section,
          op: op as CanonSectionOp,
          text: editText,
          reason: reason?.trim() || undefined,
          sources,
          baseRevision: base_revision ?? null,
          check,
          outside,
        })
        if (!result.ok) return { success: false, error: result.error, ...(result.reason === 'conflict' ? { conflict: true } : {}) }
        return {
          success: true,
          key,
          document_id: result.documentId,
          section: result.section,
          revision: result.revision,
          ...(result.rebased ? { rebased: true, note: 'The document had changed since you read it; the edit was applied to the newest text.' } : {}),
          ...(outside ? { outside } : {}),
          message:
            `Updated "${result.section}" in ${doc.title ?? key} (revision ${result.revision})${outside ? `, labelled as from ${outside} in the history and the digest` : ''}. ` +
            `To undo just this edit: revert_section_edit with revision ${result.revision}.`,
        }
      },
    }),

    revert_section_edit: tool({
      description:
        'Undo just one edit to a document, at section level: the section it touched goes back to how it was before that edit, and every later edit to other sections stays. ' +
        'Find the edit with list_document_revisions. Only for a person in the conversation who asked for it. Same edit access as update_document.',
      inputSchema: z.object({
        key: z.string().optional().describe('A canon key (or pass document_id)'),
        document_id: z.string().optional().describe('UUID of the document (or pass key)'),
        revision: z.number().int().describe('The revision of the edit to undo (list_document_revisions)'),
      }),
      execute: async ({ key: asked, document_id, revision }) => {
        let documentId: string | null = null
        if (asked) {
          const key = normalizeCanonKey(asked)
          if (!key) return { success: false, error: `"${asked}" is not a canon key.` }
          const found = await resolveCanonDocument(supabase, { workspaceId, userId, key })
          if (!found.ok) return found.reason === 'not_found' ? notFound(key, await knownKeys()) : { success: false, error: found.reason === 'error' ? found.error : 'Not a workspace member' }
          documentId = found.doc.id
        } else if (document_id) {
          const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, true)
          if (!resolved) return { success: false, error: 'Document not found' }
          documentId = document_id
        } else {
          return { success: false, error: 'Pass key or document_id.' }
        }
        const result = await revertSectionEdit(supabase, { workspaceId, userId, documentId, revision })
        if (!result.ok) return { success: false, error: result.error }
        if (result.unchanged) return { success: true, revision: result.revision, section: result.section, message: `"${result.section}" already reads as it did before that edit; nothing changed.` }
        return {
          success: true,
          revision: result.revision,
          section: result.section,
          message:
            `Put "${result.section}" back as it was before revision ${revision} (now revision ${result.revision}); other sections are unchanged.` +
            (result.laterChangesToSection ? ' Later changes to that same section were undone too; they stay in the history.' : ''),
        }
      },
    }),

    create_canon_document: tool({
      description:
        'Create a canon document from its template, with its fixed sections (empty, to fill with propose_section_edit): ' +
        '`product` (what the product is, who it is for, positioning, messaging, voice, open questions; owners and admins only), ' +
        '`team-playbook` (how the team works; owners and admins only), `person:voice` (how the person writes) or `content-brief` with a `channel` (what they post about there). ' +
        'A key that already has its document returns that document; a workspace product doc that exists becomes the `product` canon with its text kept. Draft the content from what you know, then fill the sections.',
      inputSchema: z.object({
        key: z.string().describe('product, team-playbook, person:voice, or content-brief (with channel)'),
        channel: z.string().optional().describe('For a content brief: the channel, e.g. "x" or "linkedin"'),
        title: z.string().optional().describe('A title (default: the template\'s)'),
      }),
      execute: async ({ key: asked, channel, title }) => {
        const key = templateKey(asked, channel)
        if (!key) return { success: false, error: `No template for "${asked}"${channel ? ` (${channel})` : ''}. Templates: ${TEMPLATE_KEYS.map((k) => `\`${k}\``).join(', ')}.` }
        const result = await createCanonDocument(supabase, { workspaceId, userId, key, title })
        if (!result.ok) return { success: false, error: result.error }
        const missing = result.missingSections
        return {
          success: true,
          outcome: result.outcome,
          key,
          document_id: result.document.id,
          title: result.document.title,
          sections: templateForKey(key)!.sections.map((s) => ({ heading: s.heading, what_belongs_here: s.hint })),
          ...(missing.length ? { missing_sections: missing } : {}),
          message:
            result.outcome === 'created'
              ? `Created \`${key}\` with its sections. Fill each with propose_section_edit.`
              : result.outcome === 'adopted'
                ? `The workspace product doc is now the \`${key}\` canon, its text kept.${missing.length ? ` Add the missing sections (${missing.join(', ')}) with insert_section_after.` : ''}`
                : `\`${key}\` already exists: read it with read_canon.`,
        }
      },
    }),

    read_canon: tool({
      description:
        'Read one canon document (the workspace\'s ground truth, listed under "Canon documents" in your instructions) by its key, or one named section of it. ' +
        'No search and no time window: the key always finds it. Read a canon document before you state, draft or decide anything it covers (product facts, positioning, how the team works, how the person writes). ' +
        `Keys: product, team-playbook, person:voice, content-brief:<channel>, or any key the registry lists. Returns \`revision\`: name it as base_revision when you edit.`,
      inputSchema: z.object({
        key: z.string().describe('The canon key, e.g. "product" or "content-brief:x"'),
        section: z.string().optional().describe('One section to read: its heading, or a "Parent > Heading" path. Omit for the whole document (a long one comes back as its outline).'),
      }),
      execute: async ({ key: asked, section }) => {
        const key = normalizeCanonKey(asked)
        if (!key) return { success: false, error: `"${asked}" is not a canon key. Keys look like ${TEMPLATE_KEYS.map((k) => `\`${k}\``).join(', ')}.` }
        const found = await resolveCanonDocument(supabase, { workspaceId, userId, key })
        if (!found.ok) {
          if (found.reason === 'error') return { success: false, error: found.error }
          if (found.reason === 'not_member') return { success: false, error: 'Not a workspace member' }
          return notFound(key, await knownKeys())
        }
        const { doc, memberId } = found
        const content = doc.content ?? ''
        const base = {
          ...header(key, doc, memberId),
          ...(isPersonalCanonKey(key) ? { personal: true } : {}),
          // Its size against its budget, and its sections against the template (canon-lint.ts).
          lint: lintCanonDocument(key, content),
        }

        if (section && section.trim()) {
          const lookup = findSection(parseOutline(content), section)
          if (!lookup.ok) {
            const outline = parseOutline(content)
            return {
              success: false,
              error:
                lookup.reason === 'ambiguous'
                  ? `More than one heading matches "${section}": ${describeCandidates(lookup.matches)}. Name the path ("Parent > Heading").`
                  : `No section "${section}" in \`${key}\`.${outline.length ? ` Sections: ${describeCandidates(outline.slice(0, 40))}.` : ' It has no sections.'}`,
            }
          }
          return {
            ...base,
            section: lookup.entry.path.join(' > '),
            content: documentContentForModel(sectionText(content, lookup.entry), doc.frontmatter),
          }
        }

        const shape = canonOutline(key, content)
        if (content.length > LONG_DOCUMENT_CHARS) {
          return {
            ...base,
            ...shape,
            chars: content.length,
            note: `Long document (${content.length} characters): read the section you need with \`section\`.`,
          }
        }
        return { ...base, ...shape, content: documentContentForModel(content, doc.frontmatter) }
      },
    }),
  }
}
