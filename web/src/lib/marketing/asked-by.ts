/**
 * "You asked, we shipped" (marketing M2, P9; marketing-skill-set.md §4.3,
 * eve-alignment.md §6 decision 7): when work customers asked for ships, who
 * asked for it. Read by the SERVER before the shipped-note run, in a few
 * bounded queries and no model call, and put in the run's message:
 *
 *   what shipped   the action, project or milestone that reached done (a
 *                  merged pull request's linked action), and for a project or
 *                  milestone the actions in it;
 *   who asked      the outside people behind it, found three ways:
 *                    - on a call the work came from (an action's
 *                      source_capture_id) or that is linked to it;
 *                    - in a claim about the work (entity links), through the
 *                      calls the claim rests on (claim_source);
 *                    - a CRM contact linked to the work directly.
 *                  Only people with an address, never a workspace member, and
 *                  never from someone else's private call.
 *
 * The run drafts one short email per person (deliver_to email_drafts). The
 * server then keeps only drafts to exactly these people (run-skill.ts), and
 * P6's recipient check still applies on top: a contact that existed before
 * the run, or someone the person has written to. Nothing is ever sent: each
 * draft waits in their mail for their click.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { findMembersByEmail } from '@/lib/workspace-member-emails'
import { blockedPhrases, namedPhrase } from '@/lib/content/public-safe'
import { resolveVisibilityFence, type VisibilityFence } from '@/lib/views/visibility-fence'

/** The most people one run writes to. */
export const MAX_ASKERS = 10
const MAX_ACTIONS = 50
const MAX_CAPTURES = 20

/** The shipped thing, as the flow's entity carries it. */
export interface ShippedEntity {
  kind: 'action' | 'project' | 'milestone' | 'initiative'
  id: string
  title: string
  identifier?: string | null
  description?: string | null
}

export interface Asker {
  name: string | null
  email: string
  company: string | null
  /** How we know they asked, in a few words: 'on "Acme sync" (Oct 2)', 'linked to the work'. */
  via: string
  /** What they asked about, when a claim says it. */
  about: string | null
}

export interface AskedByMaterial {
  shipped: ShippedEntity
  /** For a project or milestone: the work in it, by title. */
  parts: string[]
  askers: Asker[]
}

function day(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** The block the run reads: data, quoted, never instructions. Pure. */
export function renderAskedByBlock(m: AskedByMaterial): string {
  const what = `${m.shipped.identifier ? `${m.shipped.identifier} ` : ''}${m.shipped.title}`.trim()
  const lines = ['## What shipped', `- ${m.shipped.kind}: ${what}`]
  if (m.shipped.description?.trim()) lines.push(`  ${m.shipped.description.trim().replace(/\s+/g, ' ').slice(0, 400)}`)
  for (const p of m.parts.slice(0, 15)) lines.push(`  - ${p}`)
  lines.push('', '## Who asked for it')
  if (m.askers.length === 0) {
    lines.push('Nobody: no customer asked for this on a call, in a claim or linked to the work. Return an empty list of drafts.')
  } else {
    for (const a of m.askers) lines.push(`- ${a.name ?? a.email} <${a.email}>${a.company ? `, ${a.company}` : ''}: ${a.via}${a.about ? `; they asked about: ${a.about.slice(0, 200)}` : ''}`)
    lines.push(
      '',
      'Write ONE short email to each person above, only them, each draft to that one address: what they asked for, that it shipped, and one line on how to use it, in the person\'s voice. Never mention another customer. Nothing is sent: each waits in their mail.',
    )
  }
  return lines.join('\n')
}

/** The launch kit's block (M2): what shipped, and nothing about who asked. Pure. */
export function renderShippedBlock(shipped: ShippedEntity): string {
  const what = `${shipped.identifier ? `${shipped.identifier} ` : ''}${shipped.title}`.trim()
  return [
    '## What shipped',
    `- ${shipped.kind}: ${what}`,
    ...(shipped.description?.trim() ? [`  ${shipped.description.trim().replace(/\s+/g, ' ').slice(0, 400)}`] : []),
    '',
    'Write the launch kit from this shipped work only: one changelog line, and one post draft for the person to post themselves. Never a customer, a company, a name or a deal: public-safe, always.',
  ].join('\n')
}

/** Who asked, as the server keeps them for the delivery: the address, and the name and company no other customer's note may carry. */
export type AskerRef = Pick<Asker, 'email' | 'name' | 'company'>

/**
 * The drafts addressed only to people who asked, and naming no OTHER customer
 * (P9 review S6): a note to Dana never names Priya or Globex. Each draft is
 * screened, subject and body, against the names and companies of the askers
 * it isn't addressed to (public-safe.ts blockedPhrases / namedPhrase), less
 * its own recipients' (two people from one company can each hear it named).
 * The rest are refused with the reason. Pure.
 */
export function onlyToAskers<T extends { to: readonly string[]; cc: readonly string[]; subject?: string; body?: string }>(
  drafts: readonly T[],
  askers: readonly AskerRef[] | readonly string[],
): { items: T[]; refused: string[] } {
  const refs: AskerRef[] = (askers as ReadonlyArray<AskerRef | string>).map((a) => (typeof a === 'string' ? { email: a, name: null, company: null } : a))
  const allowed = new Set(refs.map((a) => a.email.toLowerCase()))
  const phrasesOf = (list: readonly AskerRef[]) => blockedPhrases({ people: list.map((a) => ({ full: a.name })), companies: list.map((a) => a.company) })
  const items: T[] = []
  const refused: string[] = []
  for (const d of drafts) {
    const to = [...d.to, ...d.cc].map((a) => a.toLowerCase())
    const stranger = to.find((a) => !allowed.has(a))
    if (stranger) {
      refused.push(`the draft to ${stranger}: not someone who asked for this`)
      continue
    }
    const own = new Set(phrasesOf(refs.filter((a) => to.includes(a.email.toLowerCase()))))
    const others = phrasesOf(refs.filter((a) => !to.includes(a.email.toLowerCase()))).filter((p) => !own.has(p))
    if (others.length && namedPhrase(`${d.subject ?? ''}\n${d.body ?? ''}`, others)) {
      refused.push(`the draft to ${to[0]}: it names another customer`)
      continue
    }
    items.push(d)
  }
  return { items, refused }
}

/** The addresses the server lets a shipped-note run draft to. Pure. */
export function askerAddresses(m: Pick<AskedByMaterial, 'askers'>): string[] {
  return m.askers.map((a) => a.email.toLowerCase())
}

type Link = { source_type: string; source_id: string; target_type: string; target_id: string }

/** Who asked for the shipped work (see the header). Never throws: a failed read finds nobody there. */
export async function loadAskedBy(
  supabase: SupabaseClient,
  args: { workspaceId: string; runAsUserId: string; entity: ShippedEntity; memberEmails?: (workspaceId: string, emails: string[]) => Promise<ReadonlyMap<string, unknown>> },
): Promise<AskedByMaterial> {
  const { workspaceId, entity } = args
  const out: AskedByMaterial = { shipped: entity, parts: [], askers: [] }
  try {
    // What the run's owner may see (fails closed: no fence, nobody found).
    const fence = await resolveVisibilityFence(supabase, workspaceId, args.runAsUserId)
    if (!fence.memberId) return out
    // The work: the entity, and for a project or milestone the actions in it.
    const actionRows: Array<{ id: string; title: string | null; source_capture_id: string | null }> = []
    if (entity.kind === 'action') {
      const { data } = await supabase.from('actions').select('id, title, source_capture_id').eq('workspace_id', workspaceId).eq('id', entity.id).limit(1)
      actionRows.push(...((data ?? []) as typeof actionRows))
    } else if (entity.kind === 'project' || entity.kind === 'milestone') {
      const { data } = await supabase
        .from('actions')
        .select('id, title, source_capture_id')
        .eq('workspace_id', workspaceId)
        .eq(entity.kind === 'project' ? 'project_id' : 'milestone_id', entity.id)
        // Only the work its owner may see: a private team's actions stay out.
        .in('team_id', fence.visibleTeamIds)
        .limit(MAX_ACTIONS)
      actionRows.push(...((data ?? []) as typeof actionRows))
      out.parts = actionRows.map((a) => a.title?.trim()).filter((t): t is string => !!t)
    }
    const ids = [entity.id, ...actionRows.map((a) => a.id)]

    // Edges to and from the work.
    const [from, to] = await Promise.all([
      supabase.from('entity_link').select('source_type, source_id, target_type, target_id').eq('workspace_id', workspaceId).in('source_id', ids).limit(300),
      supabase.from('entity_link').select('source_type, source_id, target_type, target_id').eq('workspace_id', workspaceId).in('target_id', ids).limit(300),
    ])
    const captureVia = new Map<string, string | null>()
    const contactIds = new Set<string>()
    const claimIds = new Set<string>()
    for (const a of actionRows) if (a.source_capture_id) captureVia.set(a.source_capture_id, null)
    const other = (l: Link) => (ids.includes(l.source_id) ? { type: l.target_type, id: l.target_id } : { type: l.source_type, id: l.source_id })
    for (const l of [...((from.data ?? []) as Link[]), ...((to.data ?? []) as Link[])]) {
      const o = other(l)
      if (o.type === 'capture') captureVia.set(o.id, captureVia.get(o.id) ?? null)
      if (o.type === 'contact') contactIds.add(o.id)
      if (o.type === 'claim') claimIds.add(o.id)
    }
    // Claims about the work: through the calls they rest on, with what they say.
    if (claimIds.size) {
      const [{ data: claims }, { data: sources }] = await Promise.all([
        supabase.from('claim').select('id, text').eq('workspace_id', workspaceId).in('id', [...claimIds].slice(0, 50)),
        supabase.from('claim_source').select('claim_id, source_type, source_id').in('claim_id', [...claimIds].slice(0, 50)).eq('source_type', 'capture').limit(200),
      ])
      const text = new Map(((claims ?? []) as Array<{ id: string; text: string | null }>).map((c) => [c.id, c.text]))
      for (const s of (sources ?? []) as Array<{ claim_id: string; source_id: string | null }>) {
        if (!s.source_id || !text.has(s.claim_id)) continue
        captureVia.set(s.source_id, captureVia.get(s.source_id) ?? text.get(s.claim_id) ?? null)
      }
    }

    // The calls: this workspace's, never someone else's private one.
    const captureIds = [...captureVia.keys()].slice(0, MAX_CAPTURES)
    const byEmail = new Map<string, Asker>()
    const add = (a: Asker) => {
      const key = a.email.toLowerCase()
      if (!byEmail.has(key) && byEmail.size < MAX_ASKERS) byEmail.set(key, { ...a, email: key })
    }
    if (captureIds.length) {
      const { data: caps } = await supabase.from('captures').select('id, title, created_at, visibility, user_id').eq('workspace_id', workspaceId).neq('is_eval', true).in('id', captureIds)
      const calls = ((caps ?? []) as Array<{ id: string; title: string | null; created_at: string | null; visibility: string | null; user_id: string | null }>).filter(
        (c) => c.visibility !== 'private' || c.user_id === args.runAsUserId,
      )
      if (calls.length) {
        const { data: parts } = await supabase
          .from('capture_participant')
          .select('capture_id, member_id, is_self, external_name, external_email, contact_id, company')
          .in('capture_id', calls.map((c) => c.id))
          .limit(400)
        const rows = ((parts ?? []) as Array<{ capture_id: string; member_id: string | null; is_self: boolean | null; external_name: string | null; external_email: string | null; contact_id: string | null; company: string | null }>).filter(
          (p) => !p.member_id && !p.is_self,
        )
        const viaContact = [...new Set(rows.map((p) => p.contact_id).filter((id): id is string => !!id))]
        const contacts = await readContacts(supabase, workspaceId, viaContact, fence)
        for (const p of rows) {
          const call = calls.find((c) => c.id === p.capture_id)
          const c = p.contact_id ? contacts.get(p.contact_id) : undefined
          const email = (c?.email ?? p.external_email ?? '').trim()
          if (!email.includes('@')) continue
          add({
            name: c?.name ?? p.external_name ?? null,
            email,
            company: c?.company ?? p.company ?? null,
            via: `on the call "${(call?.title ?? 'a call').slice(0, 80)}"${call?.created_at ? ` (${day(call.created_at)})` : ''}`,
            about: captureVia.get(p.capture_id) ?? null,
          })
        }
      }
    }
    // Contacts linked to the work itself.
    if (contactIds.size) {
      for (const c of (await readContacts(supabase, workspaceId, [...contactIds].slice(0, 30), fence)).values()) {
        if (c.email?.includes('@')) add({ name: c.name, email: c.email, company: c.company, via: 'linked to the work', about: null })
      }
    }
    // Never a workspace member (their addresses live on auth.users: workspace-member-emails.ts).
    if (byEmail.size) {
      const members = await (args.memberEmails ?? findMembersByEmail)(workspaceId, [...byEmail.keys()])
      for (const email of members.keys()) byEmail.delete(email.toLowerCase())
    }
    out.askers = [...byEmail.values()]
  } catch {
    /* what was read so far */
  }
  return out
}

/** The contacts among `ids` the run's owner may see (P9 review S5: the CRM's own fence, contactOr). */
async function readContacts(
  supabase: SupabaseClient,
  workspaceId: string,
  ids: string[],
  fence: VisibilityFence,
): Promise<Map<string, { name: string | null; email: string | null; company: string | null }>> {
  const out = new Map<string, { name: string | null; email: string | null; company: string | null }>()
  if (!ids.length || !fence.memberId) return out
  const q = supabase.from('contact').select('id, full_name, email, company_id').eq('workspace_id', workspaceId).in('id', ids.slice(0, 100))
  const { data } = await (fence.contactOr ? q.or(fence.contactOr) : q)
  const rows = (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null; company_id: string | null }>
  const companyIds = [...new Set(rows.map((r) => r.company_id).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (companyIds.length) {
    const { data: cos } = await supabase.from('company').select('id, name').eq('workspace_id', workspaceId).in('id', companyIds)
    for (const c of (cos ?? []) as Array<{ id: string; name: string | null }>) if (c.name) names.set(c.id, c.name)
  }
  for (const r of rows) out.set(r.id, { name: r.full_name, email: r.email, company: r.company_id ? (names.get(r.company_id) ?? null) : null })
  return out
}
