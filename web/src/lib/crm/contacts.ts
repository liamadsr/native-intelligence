import { getServiceClient } from '@/lib/admin'
import { findMemberByEmail } from '@/lib/workspace-member-emails'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { getWorkspaceEmailAccountIds } from '@/lib/email/account-scope'
import {
  shouldAutoCreateContact,
  hasHumanNameSignal,
  placeholderNameFromEmail,
} from '@/lib/crm/contact-noise-filter'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderContact {
  provider: 'google' | 'microsoft'
  providerId: string
  email: string
  fullName: string
  firstName?: string
  lastName?: string
  companyName?: string
  jobTitle?: string
  phone?: string
  avatarUrl?: string
}

/** Characters no email address carries but a display label does, and that
 *  would rewrite a PostgREST `.or()` filter the address is spliced into. */
const NON_ADDRESS_CHARS = /[,()"\\\s<>]/

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'live.com', 'me.com', 'mail.com',
  'ymail.com', 'msn.com', 'zoho.com', 'fastmail.com',
])

// ---------------------------------------------------------------------------
// Contact Sync from Email Provider
// ---------------------------------------------------------------------------

export async function syncContactsFromProvider(
  userId: string,
  workspaceId: string,
  fullSync = false,
): Promise<{ synced: number; companies_created: number }> {
  const supabaseAdmin = getServiceClient()

  // Scope the pull to the email accounts actually linked to THIS workspace, not
  // the user's whole OAuth set. Deriving contacts from every mailbox the user
  // has ever connected is how a second workspace silently re-ingested another
  // workspace's contact graph — the leak this fixes. getWorkspaceEmailAccountIds
  // takes a user (RLS) client for the read; the service client is fine here since
  // this runs server-side outside a request.
  const accountIds = await getWorkspaceEmailAccountIds(supabaseAdmin, userId, workspaceId)
  if (accountIds.length === 0) {
    return { synced: 0, companies_created: 0 }
  }

  // Resolve each linked account's provider so we only hit the APIs backing the
  // accounts scoped to this workspace.
  const { data: linkedAccounts } = await supabaseAdmin
    .from('connected_account')
    .select('id, provider')
    .in('id', accountIds)

  if (!linkedAccounts || linkedAccounts.length === 0) {
    return { synced: 0, companies_created: 0 }
  }

  // Resolve member_id for ownership
  const { data: member } = await supabaseAdmin
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .single()
  const memberIdForSync = member?.id || null

  let allProviderContacts: ProviderContact[] = []

  // Pull per linked account (per-account tokens keep the mailbox scoping tight)
  // — an account linked to a different workspace never contributes its contacts.
  for (const account of linkedAccounts) {
    const token = await getValidTokenForAccount(account.id)
    if (!token) continue

    if (account.provider === 'google') {
      const contacts = await fetchGoogleContacts(token.token)
      allProviderContacts.push(...contacts)
    } else if (account.provider === 'microsoft') {
      const contacts = await fetchMicrosoftContacts(token.token)
      allProviderContacts.push(...contacts)
    }
  }

  if (allProviderContacts.length === 0) {
    return { synced: 0, companies_created: 0 }
  }

  let syncedCount = 0
  let companiesCreated = 0

  for (const pc of allProviderContacts) {
    if (!pc.email) continue

    const email = pc.email.toLowerCase()
    const domain = email.split('@')[1]

    // CRM noise filter (GEN-139): don't auto-create a contact for a
    // role/transactional/bot sender or one with no human-name signal. Skipped
    // before the company insert so we don't spawn a phantom company for
    // noreply@… either. Existing contacts are never touched.
    const verdict = shouldAutoCreateContact({ email, fullName: pc.fullName, source: 'email_sync' })
    if (!verdict.create) continue

    // Find or create company
    let companyId: string | null = null
    if (domain && !PERSONAL_DOMAINS.has(domain)) {
      const { data: existingCompany } = await supabaseAdmin
        .from('company')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('domain', domain)
        .maybeSingle()

      if (existingCompany) {
        companyId = existingCompany.id
      } else {
        const companyName = pc.companyName || formatDomainAsCompanyName(domain)
        const { data: newCompany } = await supabaseAdmin
          .from('company')
          .insert({
            workspace_id: workspaceId,
            name: companyName,
            domain,
          })
          .select('id')
          .single()
        companyId = newCompany?.id || null
        if (newCompany) companiesCreated++
      }
    }

    // Upsert contact
    const { data: existing } = await supabaseAdmin
      .from('contact')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('email', email)
      .maybeSingle()

    if (existing) {
      await supabaseAdmin
        .from('contact')
        .update({
          full_name: pc.fullName || undefined,
          first_name: pc.firstName || undefined,
          last_name: pc.lastName || undefined,
          job_title: pc.jobTitle || undefined,
          phone: pc.phone || undefined,
          avatar_url: pc.avatarUrl || undefined,
          company_id: companyId || undefined,
          provider_contact_id: pc.providerId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    } else {
      await supabaseAdmin
        .from('contact')
        .insert({
          workspace_id: workspaceId,
          created_by_member_id: memberIdForSync,
          visibility: 'private',
          email,
          full_name: pc.fullName || email,
          first_name: pc.firstName || null,
          last_name: pc.lastName || null,
          job_title: pc.jobTitle || null,
          phone: pc.phone || null,
          avatar_url: pc.avatarUrl || null,
          company_id: companyId,
          source: 'email_sync',
          source_provider: pc.provider,
          provider_contact_id: pc.providerId,
          relationship_type: 'contact',
        })
    }

    syncedCount++
  }

  return { synced: syncedCount, companies_created: companiesCreated }
}

// ---------------------------------------------------------------------------
// Sync contacts from capture participants
// ---------------------------------------------------------------------------

export async function syncContactsFromParticipants(
  workspaceId: string,
): Promise<{ synced: number }> {
  const supabaseAdmin = getServiceClient()

  // This workspace's participants without a contact_id that have an email.
  // Scoped IN the query (inner join on the capture) and paged: an unscoped read
  // returned the platform's first 1000 orphans, so this workspace's could be
  // missed, and its follow-up `.in()` of capture ids outgrew the URL.
  const PAGE = 1000
  const workspaceOrphans: Array<{
    id: string
    external_name: string | null
    external_email: string | null
    company: string | null
    job_title: string | null
  }> = []
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await supabaseAdmin
      .from('capture_participant')
      .select('id, external_name, external_email, company, job_title, capture:captures!capture_id!inner(workspace_id)')
      .is('contact_id', null)
      .not('external_email', 'is', null)
      .eq('capture.workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[syncContactsFromParticipants] orphan read failed:', error.message)
      break
    }
    workspaceOrphans.push(...((page ?? []) as unknown as typeof workspaceOrphans))
    if (!page || page.length < PAGE) break
  }

  if (!workspaceOrphans.length) return { synced: 0 }

  let syncedCount = 0

  for (const participant of workspaceOrphans) {
    if (!participant.external_email) continue

    const email = participant.external_email.toLowerCase()
    // Orphaned rows written before display names were preserved have
    // external_name == external_email. Passing that through would re-store the
    // ADDRESS as the contact's name; hand over an empty name instead and let
    // findOrCreateContact derive a placeholder the enricher can later replace.
    const participantName =
      participant.external_name && participant.external_name.toLowerCase() !== email
        ? participant.external_name
        : ''
    const contact = await findOrCreateContact(workspaceId, {
      email,
      fullName: participantName,
      jobTitle: participant.job_title || undefined,
      companyName: participant.company || undefined,
      source: 'capture_participant',
    })

    if (contact) {
      await supabaseAdmin
        .from('capture_participant')
        .update({ contact_id: contact.id })
        .eq('id', participant.id)
      syncedCount++
    }
  }

  return { synced: syncedCount }
}

// ---------------------------------------------------------------------------
// Find or create contact
// ---------------------------------------------------------------------------

export async function findOrCreateContact(
  workspaceId: string,
  data: {
    email: string
    fullName: string
    jobTitle?: string
    companyName?: string
    source?: string
    created_by_member_id?: string | null
    visibility?: 'private' | 'team' | 'workspace'
  },
): Promise<{ id: string } | null> {
  const supabaseAdmin = getServiceClient()
  const email = data.email.trim().toLowerCase()

  // Never create a contact from a non-address. Calendar/participant sync paths
  // can pass a display label (e.g. "Sarah Hale (ext)") when an attendee has no
  // email; without this guard those labels land in contact.email and corrupt the
  // CRM. A bare '@' check is enough — real validation happens upstream.
  // A label carrying an address ("smith, john <john@x.com>") passes the '@'
  // check but is not an address either, and its commas/quotes would rewrite
  // the `.or()` lookup below (a broken filter reads as "no match" → a junk
  // duplicate on every sync; `a@b.co,id.neq.x` matches an arbitrary contact).
  if (!email.includes('@') || NON_ADDRESS_CHARS.test(email)) {
    console.warn('[findOrCreateContact] refusing non-email value:', data.email)
    return null
  }

  // Match the email as either a primary OR secondary address, and never resolve
  // to a merged-away tombstone — so a meeting joined from an address that was
  // folded into another contact attaches to the survivor, not a new duplicate.
  const { data: existing } = await supabaseAdmin
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .or(`email.eq.${email},secondary_emails.cs.{"${email}"}`)
    .limit(1)
    .maybeSingle()

  if (existing) return existing

  // CRM noise filter (GEN-139): for AUTO sources (calendar / capture-participant
  // / email sync), refuse to create a contact for a role/bot address or one with
  // no human-name signal. Manual and member sources always pass. Runs only on
  // the CREATE path — an existing contact was already returned above.
  const verdict = shouldAutoCreateContact({
    email,
    fullName: data.fullName,
    source: data.source,
  })
  if (!verdict.create) {
    return null
  }

  // Create company if needed
  const domain = email.split('@')[1]
  let companyId: string | null = null

  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    const { data: company } = await supabaseAdmin
      .from('company')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('domain', domain)
      .maybeSingle()

    if (company) {
      companyId = company.id
    } else {
      const companyName = data.companyName || formatDomainAsCompanyName(domain)
      const { data: newCompany } = await supabaseAdmin
        .from('company')
        .insert({ workspace_id: workspaceId, name: companyName, domain })
        .select('id')
        .single()
      companyId = newCompany?.id || null
    }
  }

  // Resolve workspace member by email (via auth.users) so we can link contact →
  // member. auth.users can't be embedded in a member query (the auth schema
  // isn't exposed), so the address is resolved through the admin API.
  const matchedMember = await findMemberByEmail(workspaceId, email)

  // The verdict can be "create" with no usable name — a meeting attendee whose
  // provider sent no displayName, or sent the address back as the name. Storing
  // the ADDRESS in full_name is the exact CRM pollution GEN-139 was written to
  // stop, so derive a name from the local-part instead. When that derivation
  // isn't confident it returns the bare local-part, which enrichment's
  // isPlaceholderName recognizes and later overwrites with the real name.
  const resolvedFullName = hasHumanNameSignal(data.fullName, email)
    ? data.fullName
    : placeholderNameFromEmail(email)

  const nameParts = resolvedFullName.split(' ')
  const { data: newContact, error: insertError } = await supabaseAdmin
    .from('contact')
    .insert({
      workspace_id: workspaceId,
      created_by_member_id: data.created_by_member_id || null,
      member_id: matchedMember?.id || null,
      visibility: data.visibility || 'workspace',
      email,
      full_name: resolvedFullName,
      first_name: nameParts[0] || null,
      last_name: nameParts.slice(1).join(' ') || null,
      job_title: data.jobTitle || null,
      company_id: companyId,
      source: data.source || 'manual',
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('[findOrCreateContact] insert failed for', email, insertError)
  }

  return newContact || null
}

// ---------------------------------------------------------------------------
// Ensure workspace member has a CRM contact record
// ---------------------------------------------------------------------------

/**
 * Creates (or links) a CRM contact for a workspace member.
 * Called when a member is created (workspace creation, invite acceptance).
 */
export async function ensureMemberContact(
  workspaceId: string,
  memberId: string,
  user: { id: string; email?: string; user_metadata?: { full_name?: string; name?: string; avatar_url?: string } },
): Promise<void> {
  const supabaseAdmin = getServiceClient()
  const email = user.email?.toLowerCase()
  if (!email) return

  // Check if a contact already exists for this email
  const { data: existing } = await supabaseAdmin
    .from('contact')
    .select('id, member_id')
    .eq('workspace_id', workspaceId)
    .eq('email', email)
    .maybeSingle()

  if (existing) {
    // Link existing contact to this member if not already linked
    if (!existing.member_id) {
      await supabaseAdmin
        .from('contact')
        .update({ member_id: memberId, relationship_type: 'internal', updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return
  }

  // Create new contact for this member
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name || email.split('@')[0]
  const nameParts = fullName.split(' ')

  await supabaseAdmin.from('contact').insert({
    workspace_id: workspaceId,
    member_id: memberId,
    email,
    full_name: fullName,
    first_name: nameParts[0] || null,
    last_name: nameParts.slice(1).join(' ') || null,
    avatar_url: user.user_metadata?.avatar_url || null,
    relationship_type: 'internal',
    relationship_strength: 'strong',
    visibility: 'workspace',
    source: 'member',
  })
}

// ---------------------------------------------------------------------------
// Capture self-participant — the signed-in user's identity anchor
// ---------------------------------------------------------------------------

/**
 * Seed the capture owner's SELF participant row: member + self-contact,
 * is_self = true, NO speaker_label. Identity is a fact we can assert at
 * create time; which transcript VOICE is theirs is not — the label is bound
 * later with evidence (position / explicit confirmation / voiceprint, see
 * src/lib/live-agent/self-binding.ts). Idempotent: the partial unique index
 * capture_participant_one_self absorbs concurrent seeds.
 *
 * Called from POST /api/account/captures (create) and lazily from the
 * extraction routes so pre-existing captures self-heal on Reprocess.
 */
export async function seedSelfParticipant(
  workspaceId: string,
  captureId: string,
  user: { id: string; email?: string; user_metadata?: { full_name?: string; name?: string; avatar_url?: string } },
): Promise<void> {
  const supabaseAdmin = getServiceClient()

  const { data: member } = await supabaseAdmin
    .from('member')
    .select('id, display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()
  if (!member) return

  // Already seeded — the common case for every request after capture create.
  const { data: existingSelf } = await supabaseAdmin
    .from('capture_participant')
    .select('id')
    .eq('capture_id', captureId)
    .eq('is_self', true)
    .limit(1)
    .maybeSingle()
  if (existingSelf) return

  // The member-linked self-contact (created by ensureMemberContact at
  // workspace-create / invite-accept). Best-effort: create it when missing and
  // we have an email; a null contact_id still anchors identity via member_id.
  let { data: selfContact } = await supabaseAdmin
    .from('contact')
    .select('id, full_name')
    .eq('workspace_id', workspaceId)
    .eq('member_id', member.id)
    .limit(1)
    .maybeSingle()
  if (!selfContact && user.email) {
    await ensureMemberContact(workspaceId, member.id, user)
    const { data: retry } = await supabaseAdmin
      .from('contact')
      .select('id, full_name')
      .eq('workspace_id', workspaceId)
      .eq('member_id', member.id)
      .limit(1)
      .maybeSingle()
    selfContact = retry
  }

  const displayName =
    (member.display_name as string | null) ||
    (selfContact?.full_name as string | null) ||
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email?.split('@')[0] ||
    null

  // A calendar-seeded row may already represent the owner — promote it
  // instead of inserting a duplicate participant. Match by member_id AND by
  // the self-contact: attendee rows never carry member_id today (the member
  // email match in seedCaptureParticipants is dead — member has no email
  // column), but when the owner's calendar email is their sign-in email the
  // attendee row points at the self-CONTACT.
  let existingRow: { id: string } | null = null
  const { data: memberRow } = await supabaseAdmin
    .from('capture_participant')
    .select('id')
    .eq('capture_id', captureId)
    .eq('member_id', member.id)
    .limit(1)
    .maybeSingle()
  existingRow = memberRow
  if (!existingRow && selfContact?.id) {
    const { data: contactRow } = await supabaseAdmin
      .from('capture_participant')
      .select('id')
      .eq('capture_id', captureId)
      .eq('contact_id', selfContact.id)
      .limit(1)
      .maybeSingle()
    existingRow = contactRow
  }

  if (existingRow) {
    await supabaseAdmin
      .from('capture_participant')
      .update({ is_self: true, member_id: member.id, contact_id: selfContact?.id ?? null })
      .eq('id', existingRow.id)
    return
  }

  const { error } = await supabaseAdmin.from('capture_participant').insert({
    capture_id: captureId,
    member_id: member.id,
    contact_id: selfContact?.id ?? null,
    external_name: displayName,
    role: 'organizer',
    is_self: true,
    self_binding: 'none',
  })
  // 23505 = a concurrent seed won the partial-unique-index race. Fine.
  if (error && error.code !== '23505') {
    console.warn('[seedSelfParticipant] insert failed:', error.message)
  }
}

// ---------------------------------------------------------------------------
// Relationship strength decay
// ---------------------------------------------------------------------------

export async function decayRelationshipStrength(): Promise<void> {
  const supabaseAdmin = getServiceClient()
  const now = new Date()

  // 90+ days → stale
  await supabaseAdmin
    .from('contact')
    .update({ relationship_strength: 'stale', updated_at: now.toISOString() })
    .lt('last_interaction_at', new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .not('relationship_strength', 'eq', 'stale')
    .not('relationship_type', 'eq', 'internal')

  // 30-90 days → cold
  await supabaseAdmin
    .from('contact')
    .update({ relationship_strength: 'cold', updated_at: now.toISOString() })
    .lt('last_interaction_at', new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .gte('last_interaction_at', new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .not('relationship_strength', 'in', '(cold,stale)')
    .not('relationship_type', 'eq', 'internal')
}

// ---------------------------------------------------------------------------
// Provider API calls
// Extracts contacts from email message participants (From/To/Cc headers).
// We use Gmail/Outlook mail scopes (already authorized) instead of the
// People/Contacts API which requires additional OAuth scopes.
// ---------------------------------------------------------------------------

async function fetchGoogleContacts(accessToken: string): Promise<ProviderContact[]> {
  try {
    // Fetch recent message metadata (last 90 days, skip promotions/social)
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=200&q=newer_than:90d -category:promotions -category:social -category:updates',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!listRes.ok) return []
    const listData = await listRes.json()
    const messageIds: string[] = (listData.messages || []).map((m: { id: string }) => m.id)

    if (messageIds.length === 0) return []

    // Fetch metadata headers for each message (batch to avoid timeout)
    const seen = new Map<string, ProviderContact>()

    // Process in batches of 50
    for (let i = 0; i < Math.min(messageIds.length, 200); i += 50) {
      const batch = messageIds.slice(i, i + 50)
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const res = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            )
            if (!res.ok) return null
            return res.json()
          } catch {
            return null
          }
        }),
      )

      for (const msg of results) {
        if (!msg) continue
        const headers = msg.payload?.headers || []
        for (const header of headers) {
          if (!['from', 'to', 'cc'].includes(header.name.toLowerCase())) continue
          const parsed = parseEmailAddresses(header.value || '')
          for (const { email, name } of parsed) {
            const lower = email.toLowerCase()
            if (seen.has(lower)) continue
            seen.set(lower, {
              provider: 'google',
              providerId: '',
              email: lower,
              fullName: name || lower,
              firstName: name ? name.split(' ')[0] : undefined,
              lastName: name ? name.split(' ').slice(1).join(' ') || undefined : undefined,
            })
          }
        }
      }
    }

    return Array.from(seen.values())
  } catch {
    return []
  }
}

async function fetchMicrosoftContacts(accessToken: string): Promise<ProviderContact[]> {
  try {
    // Fetch recent messages with sender/recipient info
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me/messages?$top=200&$orderby=receivedDateTime desc&$select=from,toRecipients,ccRecipients',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return []

    const data = await res.json()
    const seen = new Map<string, ProviderContact>()

    for (const msg of data.value || []) {
      // From
      const fromAddr = msg.from?.emailAddress
      if (fromAddr?.address) {
        const lower = fromAddr.address.toLowerCase()
        if (!seen.has(lower)) {
          seen.set(lower, {
            provider: 'microsoft',
            providerId: '',
            email: lower,
            fullName: fromAddr.name || lower,
            firstName: fromAddr.name ? fromAddr.name.split(' ')[0] : undefined,
            lastName: fromAddr.name ? fromAddr.name.split(' ').slice(1).join(' ') || undefined : undefined,
          })
        }
      }

      // To + Cc
      for (const list of [msg.toRecipients || [], msg.ccRecipients || []]) {
        for (const r of list) {
          const addr = r.emailAddress
          if (!addr?.address) continue
          const lower = addr.address.toLowerCase()
          if (seen.has(lower)) continue
          seen.set(lower, {
            provider: 'microsoft',
            providerId: '',
            email: lower,
            fullName: addr.name || lower,
            firstName: addr.name ? addr.name.split(' ')[0] : undefined,
            lastName: addr.name ? addr.name.split(' ').slice(1).join(' ') || undefined : undefined,
          })
        }
      }
    }

    return Array.from(seen.values())
  } catch {
    return []
  }
}

/**
 * Parse email header values like:
 *   "John Doe" <john@example.com>, jane@example.com, "Bob" <bob@co.com>
 */
function parseEmailAddresses(header: string): Array<{ email: string; name: string | null }> {
  const results: Array<{ email: string; name: string | null }> = []
  // Match patterns: "Name" <email> or bare email
  const regex = /(?:"?([^"<]*?)"?\s*<([^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/g
  let match
  while ((match = regex.exec(header)) !== null) {
    const name = match[1]?.trim() || null
    const email = (match[2] || match[3] || '').trim()
    if (email && email.includes('@')) {
      results.push({ email, name })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Seed capture participants from event attendees
// ---------------------------------------------------------------------------

export interface EventAttendee {
  email: string
  name?: string
  isOrganizer?: boolean
}

/**
 * Seeds capture_participant rows from calendar event attendees.
 * For each attendee:
 *   - Matches against workspace members
 *   - Finds or creates a CRM contact (so voice ID and deep-links work)
 *   - Inserts a capture_participant record with all resolved IDs
 */
export async function seedCaptureParticipants(
  captureId: string,
  workspaceId: string,
  attendees: EventAttendee[] | string[],
  organizer?: string,
): Promise<void> {
  const supabaseAdmin = getServiceClient()

  console.log('[seedCaptureParticipants] called with', { captureId, workspaceId, attendeeCount: attendees.length, attendees })

  const normalized: EventAttendee[] = attendees.map((a) =>
    typeof a === 'string' ? { email: a } : a,
  )

  for (const attendee of normalized) {
    const email = attendee.email?.trim().toLowerCase()
    // Skip attendees with no real address — a display label (e.g. from a
    // calendar sync where the attendee had no email) must never become a
    // contact email or a capture_participant.external_email.
    if (!email || !email.includes('@') || NON_ADDRESS_CHARS.test(email)) continue
    console.log('[seedCaptureParticipants] processing attendee:', email)

    const isOrganizer = attendee.isOrganizer || (organizer && email === organizer.toLowerCase())
    const role = isOrganizer ? 'organizer' : 'attendee'

    // Match workspace member. There is no member.email column; the sign-in
    // address is resolved through the admin API (workspace-member-emails.ts).
    const member = await findMemberByEmail(workspaceId, email)

    // Match or create CRM contact
    let contact = await supabaseAdmin
      .from('contact')
      .select('id, first_name, last_name, job_title, company_id')
      .eq('workspace_id', workspaceId)
      .or(`email.eq.${email},secondary_emails.cs.{"${email}"}`)
      .limit(1)
      .maybeSingle()
      .then((r) => r.data)

    // Create CRM contact if one doesn't exist yet
    if (!contact) {
      console.log('[seedCaptureParticipants] no existing contact for', email, '— creating...')
      const created = await findOrCreateContact(workspaceId, {
        email,
        // Never fall back to the address as a name — findOrCreateContact turns
        // an empty name into an enrichable placeholder instead.
        fullName: attendee.name && attendee.name.toLowerCase() !== email ? attendee.name : '',
        source: 'calendar_sync',
      })
      console.log('[seedCaptureParticipants] findOrCreateContact result:', created)
      if (created) {
        const { data: freshContact } = await supabaseAdmin
          .from('contact')
          .select('id, first_name, last_name, job_title, company_id')
          .eq('id', created.id)
          .single()
        contact = freshContact
      }
    } else {
      console.log('[seedCaptureParticipants] found existing contact for', email, ':', contact.id)
    }

    let companyName: string | null = null
    if (contact?.company_id) {
      const { data: company } = await supabaseAdmin
        .from('company')
        .select('name')
        .eq('id', contact.company_id)
        .single()
      companyName = company?.name || null
    }

    await supabaseAdmin.from('capture_participant').insert({
      capture_id: captureId,
      member_id: member?.id || null,
      contact_id: contact?.id || null,
      external_name:
        attendee.name ||
        (contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : null) ||
        email,
      external_email: email,
      company: companyName || null,
      job_title: contact?.job_title || null,
      role,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDomainAsCompanyName(domain: string): string {
  const name = domain.split('.')[0]
  return name.charAt(0).toUpperCase() + name.slice(1)
}
