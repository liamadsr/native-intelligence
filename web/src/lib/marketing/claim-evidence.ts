/**
 * Count what an edit's sources show, for gradeClaim (./grade.ts): the
 * distinct outside companies on the calls it cites, and the documents a
 * person wrote that it cites. A cited claim counts through its own sources
 * (claim_source rows of type capture or document, migration 109).
 *
 * What the model cites proves nothing on its own (canon-sources.ts), so:
 *   - only rows in the session workspace count, never an eval capture;
 *   - a document counts only when a person wrote it
 *     (src/lib/documents/human-authored.ts, P8 review B1): an agent can
 *     create a shared doc in one call, and an outside-derived one is outside
 *     text. The edited document is never its own proof;
 *   - a company is a participant's company, their CRM contact's company, or,
 *     failing both, their email's domain; each folded the way the public-safe
 *     screen folds a company ("The Acme Corp." = "acme", foldCompanyName), so
 *     one company is never counted twice (review S2). Members, the recorder
 *     and the workspace's own company (is_workspace_company, migration 248,
 *     by name and domain) are never one.
 * Bounded: at most MAX_COUNTED sources of each kind are read. A failed read
 * counts nothing, which only ever lowers a grade.
 *
 * The count is per edit, not per line: every [proven] line in one edit is
 * held to what the edit's sources show together. A line-by-line count would
 * need the agent to attach sources to each line; noted for the morning.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CanonSource } from '@/lib/documents/canon-sources'
import { documentFacts } from '@/lib/documents/human-authored'
import { foldCompanyName, foldText } from '@/lib/content/public-safe'
import type { ClaimEvidence } from './grade'

/** Sources of each kind read per count. */
export const MAX_COUNTED = 10

const NONE: ClaimEvidence = { companies: 0, documents: 0, metrics: 0 }

/** Mail hosts that name nobody's company. */
const FREE_MAIL = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'yahoo', 'icloud', 'me', 'aol', 'proton', 'protonmail', 'gmx', 'fastmail', 'hey'])

/** An address's company key: the domain's name before its suffix ("sam@mail.acme.co.uk" → "acme"), or '' for free mail. Pure. */
export function emailCompanyKey(email: string | null | undefined): string {
  const domain = (email ?? '').split('@')[1]?.toLowerCase().trim() ?? ''
  const labels = domain.split('.').filter(Boolean)
  if (labels.length < 2) return ''
  // The registrable name: the label before a 2-letter country suffix pair (co.uk, com.au) or before the TLD.
  const name = labels.length >= 3 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? labels[labels.length - 3] : labels[labels.length - 2]
  return FREE_MAIL.has(name) ? '' : foldCompanyName(name)
}

/** One person on a call: their CRM contact, else their folded name, else their address's local part. Pure. */
export function personKey(p: { contact_id?: string | null; external_name?: string | null; external_email?: string | null }): string | null {
  if (p.contact_id) return `c:${p.contact_id}`
  const name = foldText(p.external_name ?? '')
  if (name) return `n:${name}`
  const local = (p.external_email ?? '').trim().toLowerCase().split('@')[0]
  return local ? `e:${local}` : null
}

export async function evidenceFromSources(
  supabase: SupabaseClient,
  workspaceId: string,
  sources: readonly CanonSource[],
  /** The document being edited: never its own proof. */
  excludeDocumentId?: string | null,
): Promise<ClaimEvidence> {
  const ids = (kind: CanonSource['kind']) => [...new Set(sources.filter((s) => s.kind === kind && s.id).map((s) => s.id as string))].slice(0, MAX_COUNTED)
  const captureIds = new Set(ids('capture'))
  const documentIds = new Set(ids('document'))
  const claimIds = ids('claim')
  try {
    if (claimIds.length) {
      // Only this workspace's claims, then what they rest on.
      const { data: claims } = await supabase.from('claim').select('id').eq('workspace_id', workspaceId).in('id', claimIds)
      const kept = ((claims ?? []) as Array<{ id: string }>).map((c) => c.id)
      if (kept.length) {
        const { data } = await supabase.from('claim_source').select('source_type, source_id').in('claim_id', kept).limit(100)
        for (const r of (data ?? []) as Array<{ source_type: string; source_id: string | null }>) {
          if (!r.source_id) continue
          if (r.source_type === 'capture') captureIds.add(r.source_id)
          if (r.source_type === 'document') documentIds.add(r.source_id)
        }
      }
    }

    // One company per PERSON (P9 review S8): the same person twice, or one person
    // whose company is spelled two ways, never counts as two companies.
    const byPerson = new Map<string, string>()
    const captures = [...captureIds].slice(0, MAX_COUNTED * 2)
    if (captures.length) {
      const { data: own } = await supabase.from('captures').select('id').eq('workspace_id', workspaceId).neq('is_eval', true).in('id', captures)
      const kept = ((own ?? []) as Array<{ id: string }>).map((r) => r.id)
      if (kept.length) {
        const { data: parts } = await supabase.from('capture_participant').select('member_id, is_self, company, contact_id, external_email, external_name').in('capture_id', kept).limit(400)
        const rows = ((parts ?? []) as Array<{ member_id: string | null; is_self: boolean | null; company: string | null; contact_id: string | null; external_email: string | null; external_name?: string | null }>).filter(
          (p) => !p.member_id && !p.is_self,
        )
        const contactIds = [...new Set(rows.map((p) => p.contact_id).filter((id): id is string => !!id))].slice(0, 100)
        const contactCompany = new Map<string, string>()
        if (contactIds.length) {
          const { data: contacts } = await supabase.from('contact').select('id, company_id').eq('workspace_id', workspaceId).in('id', contactIds)
          const byContact = ((contacts ?? []) as Array<{ id: string; company_id: string | null }>).filter((c) => c.company_id)
          const companyIds = [...new Set(byContact.map((c) => c.company_id as string))]
          if (companyIds.length) {
            const { data: companies } = await supabase.from('company').select('id, name').eq('workspace_id', workspaceId).in('id', companyIds)
            const nameOf = new Map(((companies ?? []) as Array<{ id: string; name: string | null }>).map((c) => [c.id, c.name ?? '']))
            for (const c of byContact) contactCompany.set(c.id, nameOf.get(c.company_id as string) ?? '')
          }
        }
        for (const p of rows) {
          // The person: their CRM contact, else their name, else their address's local part.
          const person = personKey(p)
          if (!person || byPerson.has(person)) continue
          // Their company: their CRM company, else the company they gave, else their mail domain.
          const key = foldCompanyName(p.contact_id ? contactCompany.get(p.contact_id) || p.company : p.company) || emailCompanyKey(p.external_email)
          if (key) byPerson.set(person, key)
        }
        // Never our own company.
        const { data: ours } = await supabase.from('company').select('name, domain').eq('workspace_id', workspaceId).eq('is_workspace_company', true).limit(1)
        const own = new Set<string>()
        for (const o of (ours ?? []) as Array<{ name: string | null; domain: string | null }>) {
          own.add(foldCompanyName(o.name))
          own.add(emailCompanyKey(o.domain ? `x@${o.domain.replace(/^https?:\/\//, '').replace(/^www\./, '')}` : ''))
        }
        for (const [person, company] of byPerson) if (!company || own.has(company)) byPerson.delete(person)
      }
    }

    const docs = [...documentIds].filter((id) => id !== excludeDocumentId).slice(0, MAX_COUNTED * 2)
    const facts = await documentFacts(supabase, workspaceId, docs)
    const documents = [...facts.values()].filter((d) => d.humanAuthored).length
    return { companies: new Set(byPerson.values()).size, people: byPerson.size, documents, metrics: 0 }
  } catch {
    return NONE
  }
}
