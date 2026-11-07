/**
 * One-off backfill: rewrite existing knowledge claims whose subject is a raw
 * diarization label ("remote_2 committed to …", "Colleague committed to …")
 * using the capture's voice-ID speaker assignments (capture_participant).
 *
 * The forward fix lives in src/lib/live-agent/speaker-resolution.ts — new
 * claims resolve labels before writing. This script repairs what's already in
 * the graph:
 *   - claim.text: label replaced with the resolved person's name
 *   - claim.subject_member_id + scope='personal' when the person is a member
 *   - entity_link committed_to/about edge added (idempotent upsert)
 *   - claim_chunks chunk_text updated + re-embedded so search/dedup see the
 *     corrected wording
 *
 * Claims whose label has no voice-ID assignment are left untouched and listed
 * for manual review (there is nothing to resolve them to).
 *
 * DRY-RUN by default — pass --apply to write.
 *
 * Usage:
 *   node --env-file=/tmp/dev.env scripts/backfill-claim-speaker-subjects.mjs [--apply] [--workspace <id>]
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and (with
 * --apply) AI_GATEWAY_API_KEY for re-embedding.
 */
import { createClient } from '@supabase/supabase-js'
import { embed as aiEmbed } from 'ai'

const APPLY = process.argv.includes('--apply')
const wsFlag = process.argv.indexOf('--workspace')
const WORKSPACE_FILTER = wsFlag >= 0 ? process.argv[wsFlag + 1] : null

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPA_KEY) {
  // Without a service-role key the anon client silently writes 0 rows under RLS.
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY — set it in your env file before running.')
}
const supabase = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

console.log(`Target: ${SUPA_URL}`)
console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run (pass --apply to write)'}`)
if (WORKSPACE_FILTER) console.log(`Workspace filter: ${WORKSPACE_FILTER}`)

// Mirrors src/lib/live-agent/speaker-resolution.ts.
const DIARIZATION_AT_START = /^((?:system|remote|local|speaker|spk|voice)[\s_-]?\d+)\b/i
// Placeholders only rewritten in the unambiguous "<placeholder> committed to"
// shape record_commitment produced — a claim like "Unknown constraints block X"
// must not be touched.
const PLACEHOLDER_COMMITMENT =
  /^(colleague|co-?worker|friend|participant|attendee|guest|caller|unknown speaker|unidentified speaker|someone)\s+(committed to\b)/i

const normalizeLabel = (s) => s.trim().toLowerCase().replace(/[\s_-]+/g, '_')

/** Extract the label-ish subject a claim starts with, or null. */
function labelAtStart(text) {
  const dia = text.match(DIARIZATION_AT_START)
  if (dia) return dia[1]
  const ph = text.match(PLACEHOLDER_COMMITMENT)
  if (ph) return ph[1]
  return null
}

// ---------------------------------------------------------------------------
// 1. Collect candidate claims (paged — the label check runs client-side)
// ---------------------------------------------------------------------------
const candidates = []
const PAGE = 1000
for (let offset = 0; ; offset += PAGE) {
  let q = supabase
    .from('claim')
    .select('id, workspace_id, text, type, confirmation, subject_member_id, scope')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }) // tiebreak: rows from one batch share created_at
    .range(offset, offset + PAGE - 1)
  if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
  const { data, error } = await q
  if (error) throw new Error(`claim page: ${error.message}`)
  for (const c of data ?? []) {
    if (c.text && labelAtStart(c.text)) candidates.push(c)
  }
  if ((data ?? []).length < PAGE) break
}
console.log(`\nFound ${candidates.length} claim(s) starting with a speaker label/placeholder.`)

// ---------------------------------------------------------------------------
// 2. Resolve each through its capture's speaker map
// ---------------------------------------------------------------------------
const participantCache = new Map() // captureId → rows
async function participantsFor(captureId) {
  if (participantCache.has(captureId)) return participantCache.get(captureId)
  const { data, error } = await supabase
    .from('capture_participant')
    .select(
      `speaker_label, member_id, contact_id, external_name,
       member:member!member_id(id, display_name),
       contact:contact!contact_id(id, full_name)`,
    )
    .eq('capture_id', captureId)
  if (error) throw new Error(`capture_participant ${captureId}: ${error.message}`)
  participantCache.set(captureId, data ?? [])
  return data ?? []
}

let rewritten = 0
let unresolvable = 0
let noCapture = 0

for (const claim of candidates) {
  const label = labelAtStart(claim.text)

  // Which capture did this claim come from?
  const { data: sources } = await supabase
    .from('claim_source')
    .select('source_id')
    .eq('claim_id', claim.id)
    .eq('source_type', 'capture')
    .not('source_id', 'is', null)
    .limit(1)
  const captureId = sources?.[0]?.source_id
  if (!captureId) {
    noCapture++
    console.log(`  ~ no capture source, skipped: [${claim.id}] "${claim.text.slice(0, 90)}"`)
    continue
  }

  const rows = await participantsFor(captureId)
  const mapped = rows.find(
    (p) => p.speaker_label && normalizeLabel(p.speaker_label) === normalizeLabel(label),
  )
  const realName =
    mapped?.member?.display_name || mapped?.contact?.full_name || mapped?.external_name || null

  if (!realName) {
    unresolvable++
    console.log(`  ✗ unresolvable "${label}": [${claim.id}] "${claim.text.slice(0, 90)}"`)
    continue
  }

  const newText = claim.text.replace(label, realName)
  const memberId = mapped.member_id ?? null
  const contactId = memberId ? null : mapped.contact_id ?? null
  const isCommitment = / committed to /i.test(newText)

  console.log(`  ✓ [${claim.id}] "${claim.text.slice(0, 70)}"`)
  console.log(`      → "${newText.slice(0, 70)}" (member=${memberId ?? '—'} contact=${contactId ?? '—'})`)
  if (!APPLY) {
    rewritten++
    continue
  }

  const claimPatch = { text: newText }
  if (memberId && !claim.subject_member_id) {
    claimPatch.subject_member_id = memberId
    claimPatch.scope = 'personal'
  }
  const { error: updErr } = await supabase.from('claim').update(claimPatch).eq('id', claim.id)
  if (updErr) throw new Error(`claim update ${claim.id}: ${updErr.message}`)

  // Graph edge to the person (idempotent — same conflict spec as
  // attachClaimProvenance in src/lib/ai/claim-provenance.ts).
  const link = memberId
    ? { target_type: 'member', target_id: memberId, relation: isCommitment ? 'committed_to' : 'about' }
    : contactId
      ? { target_type: 'contact', target_id: contactId, relation: 'about' }
      : null
  if (link) {
    const { error: linkErr } = await supabase.from('entity_link').upsert(
      {
        workspace_id: claim.workspace_id,
        source_type: 'claim',
        source_id: claim.id,
        ...link,
        created_by: null,
      },
      { onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation', ignoreDuplicates: true },
    )
    if (linkErr) console.log(`      ! entity_link failed (non-fatal): ${linkErr.message}`)
  }

  // Re-embed so semantic search/dedup index the corrected wording. Routed
  // through the AI Gateway like src/lib/ai/embeddings.ts (AI_GATEWAY_API_KEY).
  try {
    const { embedding } = await aiEmbed({ model: 'openai/text-embedding-3-small', value: newText })
    const { error: chunkErr } = await supabase
      .from('claim_chunks')
      .update({ chunk_text: newText, embedding: `[${embedding.join(',')}]` })
      .eq('claim_id', claim.id)
      .eq('chunk_index', 0)
    if (chunkErr) console.log(`      ! claim_chunks failed (non-fatal): ${chunkErr.message}`)
  } catch (e) {
    console.log(`      ! re-embed failed (non-fatal): ${e.message}`)
  }

  rewritten++
}

console.log(`\nDone. ${APPLY ? 'Rewrote' : 'Would rewrite'} ${rewritten}, unresolvable ${unresolvable}, no capture source ${noCapture}.`)
if (!APPLY && rewritten > 0) console.log('Re-run with --apply to write these changes.')
