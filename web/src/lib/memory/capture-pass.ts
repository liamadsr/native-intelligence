/**
 * The capture pass (always-on plan §3b, slice A2c; decisions 2, 3 and 8).
 *
 * At compaction (the chat agent's profile slot) and in the nightly catch-up, a
 * chat's text since its last capture is read on the utility agent (kind
 * `memory_capture`) into what is worth remembering about the person:
 *   - facts they STATED outright, each with `evidence` (their exact words):
 *     saved at once, `told` (decision 3), only when the evidence is found in
 *     one of THEIR messages in the slice (src/lib/memory/evidence.ts);
 *     otherwise a proposal;
 *   - facts it INFERRED from how they behaved: `learned`, and live at once
 *     when they are the person's own (a profile fact, a personal line), marked
 *     "Dial8 noticed this" in What Dial8 has learned with a one-tap remove
 *     (Liam, 2026-10-17: learning on by default);
 *   - replacements and removals, only of facts it was SHOWN (short keys p1…,
 *     a1…, mapped back here: an id it was not shown can't be touched), each
 *     with evidence: unverified, a replacement becomes a proposal (it would
 *     contradict a live fact; a note's is skipped) and a removal is skipped; a verified removal soft-retires a
 *     profile fact, and the pass never deletes a note.
 * Where each goes is decision 2's rule: how they work → `profile_fact`
 * (follows them); what they work on → a personal `area_memory` line in this
 * workspace; a team fact → a workspace line, always a proposal for an owner or
 * admin, never written active. The walls are held in code too: a profile item
 * naming one of this workspace's contacts, companies or projects becomes a
 * personal line here (src/lib/memory/workspace-mentions.ts).
 *
 * The conversation is untrusted (wrapUntrusted) and structured (JSON with
 * roles, so a text can't pass itself off as the person); every saved text goes through
 * the writers' filters (secrets, contact details, length) and caps. One
 * `chat_checkpoint` log line per pass, deduped on the operation. The model
 * call runs on eve (runUtilityTask); usage is logged by the job (decision 8).
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { appendLogLine, logLineFor } from '@/lib/log/agent-log'
import { fenceSafeLine } from '@/lib/packs/memory'
import { AREA_KEYS, isAreaKey, type AreaKey } from '@/lib/packs/registry'
import { hasContactDetails, memoryTextProblem, normalizeMemoryText } from '@/lib/packs/memory-types'
import { learnMemoryLine, saveMemoryLine } from '@/lib/packs/memory-write'
import {
  profileFactProblem,
  retireProfileFact,
  reviseProposedFact,
  saveProfileFact,
  supersedeProfileFact,
  type ProfileFactStatus,
} from './profile-facts'
import { sliceHasPersonText, validateSlice, type SliceMessage } from './capture-slice'
import { REMOVAL_RELEVANCE, evidenceVerified } from './evidence'
import { mentionsWorkspaceEntities } from './workspace-mentions'

/** The Inngest event the memory route and the nightly catch-up send. */
export const MEMORY_CAPTURE_EVENT = 'chat/memory.capture'

/** What one pass may write at most, whatever the model answered. */
export const CAPTURE_MAX_STATED = 8
export const CAPTURE_MAX_INFERRED = 4
export const CAPTURE_MAX_REPLACEMENTS = 8
export const CAPTURE_MAX_REMOVALS = 8
/** Facts and notes the model is shown (the newest), so the message stays bounded. */
const SHOWN_PROFILE_MAX = 120
const SHOWN_NOTES_MAX = 150

export const CAPTURE_TARGETS = ['profile', 'area', 'workspace'] as const
const captureTarget = {
  text: z.string(),
  target: z.enum(CAPTURE_TARGETS),
  /** Required for `area` and `workspace`; null for `profile`. */
  area: z.enum(AREA_KEYS).nullable(),
}
/** A stated item carries `evidence`: the person's exact words saying it. */
const StatedSchema = z.object({ ...captureTarget, evidence: z.string() }).strict()
const InferredSchema = z.object(captureTarget).strict()

/** The model's answer, validated by runUtilityTask against this schema. */
export const MemoryCaptureSchema = z
  .object({
    stated: z.array(StatedSchema),
    inferred: z.array(InferredSchema),
    replacements: z.array(z.object({ id: z.string(), text: z.string(), evidence: z.string() }).strict()),
    removals: z.array(z.object({ id: z.string(), evidence: z.string() }).strict()),
  })
  .strict()
export type MemoryCaptureAnswer = z.infer<typeof MemoryCaptureSchema>

/** The ids a capture job carries (the event's data, minus the slice). */
export interface CaptureJobRef {
  operationId: string
  sessionId: string
  userId: string
  workspaceId: string
  conversationId: string | null
}

/** A fact or note the model is shown, under its short key. */
export interface ShownFact {
  key: string
  id: string
  status: ProfileFactStatus
  text: string
}
export interface ShownNote extends ShownFact {
  area: AreaKey
}

export interface CaptureInput extends CaptureJobRef {
  slice: SliceMessage[]
  facts: ShownFact[]
  notes: ShownNote[]
}

/**
 * What the model is shown besides the slice: the person's live profile facts
 * (active, then proposals) and their own notes in this workspace (personal
 * area lines), newest first, each under a short key.
 */
export async function loadCaptureContext(
  supabase: SupabaseClient,
  ref: Pick<CaptureJobRef, 'userId' | 'workspaceId'>,
): Promise<{ facts: ShownFact[]; notes: ShownNote[] }> {
  const [factRead, noteRead] = await Promise.all([
    supabase
      .from('profile_fact')
      .select('id, text, status, updated_at')
      .eq('user_id', ref.userId)
      .is('retired_at', null)
      .order('updated_at', { ascending: false })
      .limit(SHOWN_PROFILE_MAX),
    supabase
      .from('area_memory')
      .select('id, area, text, status, updated_at')
      .eq('workspace_id', ref.workspaceId)
      .eq('scope', 'personal')
      .eq('user_id', ref.userId)
      .order('updated_at', { ascending: false })
      .limit(SHOWN_NOTES_MAX),
  ])
  if (factRead.error) throw new Error(`profile facts read: ${factRead.error.message}`)
  if (noteRead.error) throw new Error(`notes read: ${noteRead.error.message}`)
  const facts = ((factRead.data ?? []) as Array<{ id: string; text: string; status: string }>)
    .filter((r) => typeof r.id === 'string' && typeof r.text === 'string')
    .map((r, i) => ({ key: `p${i + 1}`, id: r.id, text: r.text, status: (r.status === 'proposed' ? 'proposed' : 'active') as ProfileFactStatus }))
  const notes = ((noteRead.data ?? []) as Array<{ id: string; area: unknown; text: string; status: string }>)
    .filter((r): r is { id: string; area: AreaKey; text: string; status: string } => typeof r.id === 'string' && typeof r.text === 'string' && isAreaKey(r.area))
    .map((r, i) => ({ key: `a${i + 1}`, id: r.id, area: r.area, text: r.text, status: (r.status === 'proposed' ? 'proposed' : 'active') as ProfileFactStatus }))
  return { facts, notes }
}

/**
 * The utility task's message: the conversation as STRUCTURED data (a JSON list
 * of { role: person | assistant, text }, so no text can forge who said what)
 * inside an untrusted-content marker, then what is already kept. Pure.
 */
export function buildCaptureMessage(input: Pick<CaptureInput, 'slice' | 'facts' | 'notes'>): string {
  const conversation = JSON.stringify(input.slice.map((m) => ({ role: m.role === 'user' ? 'person' : 'assistant', text: m.text })), null, 1)
  const parts = [
    '## The conversation since the last capture (oldest first, as JSON: role is person or assistant)',
    wrapUntrusted(conversation, 'WORKSPACE') ?? '(empty)',
    '## Facts already kept about the person (every workspace)',
    ...(input.facts.length > 0 ? input.facts.map((f) => `- ${f.key} (${f.status}): ${fenceSafeLine(f.text)}`) : ['(none)']),
    '## Their own notes in this workspace',
    ...(input.notes.length > 0 ? input.notes.map((n) => `- ${n.key} [${n.area}] (${n.status}): ${fenceSafeLine(n.text)}`) : ['(none)']),
    '## The rule',
    'How they work goes to target "profile". What they work on goes to target "area" with its area. A team fact goes to target "workspace" with its area (a proposal for an admin). Stated means the person said it outright: give their exact words as evidence, copied from a "person" entry. Inferred means you noticed it. Replacements and removals use only the keys listed above, each with the person\'s exact words as evidence. Never propose anything already listed above, active or proposed.',
  ]
  return parts.join('\n\n')
}

export interface CaptureOutcome {
  saved: number
  proposed: number
  replaced: number
  retired: number
  skipped: number
}

/** Whether a text may be saved at all (the writers check again). */
function textProblem(text: string): string | null {
  const t = normalizeMemoryText(text)
  return memoryTextProblem(t) ?? (hasContactDetails(t) ? 'contact details' : null)
}

/** The area a profile item that names this workspace's things falls back to. */
const FALLBACK_AREA: AreaKey = 'knowledge'

type CaptureItem = { text: string; target: (typeof CAPTURE_TARGETS)[number]; area: AreaKey | null }

/**
 * Write the model's answer under the evidence rule. Never throws for one bad
 * item: an item a writer refuses (a filter, a cap, an unknown key, an
 * unverified removal) is skipped and counted.
 *
 *   stated + verified evidence   saved active (told);
 *   stated unverified, inferred  learned: active at once when it is the
 *                                person's own (profile, personal line);
 *   a profile item naming one of this workspace's contacts, companies or
 *     projects                   a personal area line instead (its area, else
 *                                knowledge), under the same rule;
 *   a workspace line             always a proposal;
 *   replacement of an active fact   applied only when verified, else the new
 *                                text becomes a proposal (never a second
 *                                live fact contradicting the first);
 *   replacement of a proposal    revised in place (still a proposal);
 *   replacement of a note        in place only when verified, else skipped;
 *   removal                      only of a profile fact, only when verified
 *                                (half its content words): soft-retired. A
 *                                note is never removed: skipped and counted.
 * "Verified" is the evidence rule: the quote is in one of the person's
 * messages AND states the item (evidence.ts: 3+ words, 60% of its content
 * words).
 */
export async function applyCapture(supabase: SupabaseClient, input: CaptureInput, answer: MemoryCaptureAnswer): Promise<CaptureOutcome> {
  const out: CaptureOutcome = { saved: 0, proposed: 0, replaced: 0, retired: 0, skipped: 0 }
  const { userId, workspaceId } = input
  const personTexts = input.slice.filter((m) => m.role === 'user').map((m) => m.text)
  // Found in one of the person's messages AND stating `text` (src/lib/memory/evidence.ts).
  const verified = (evidence: string, text: string, share?: number) => evidenceVerified(evidence, text, personTexts, share)
  const factsByKey = new Map(input.facts.map((f) => [f.key, f]))
  const notesByKey = new Map(input.notes.map((n) => [n.key, n]))
  const touched = new Set<string>()

  /** A profile item that names this workspace's things: a personal line here (null when the check fails). */
  const routedTarget = async (item: CaptureItem): Promise<CaptureItem | null> => {
    if (item.target !== 'profile') return item
    let mentioned: string | null
    try {
      mentioned = await mentionsWorkspaceEntities(supabase, item.text, workspaceId)
    } catch (err) {
      console.error(`[capture-pass] mention check failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    return mentioned ? { ...item, target: 'area', area: item.area ?? FALLBACK_AREA } : item
  }

  const save = async (raw: CaptureItem, told: boolean) => {
    if (textProblem(raw.text)) return void (out.skipped += 1)
    const item = await routedTarget(raw)
    if (!item) return void (out.skipped += 1)
    if (item.target === 'profile') {
      const r = await saveProfileFact(supabase, { userId, text: item.text, source: told ? 'told' : 'learned', sourceWorkspaceId: workspaceId })
      if (!r.ok || r.already) return void (out.skipped += 1)
      if (r.fact.status === 'active') out.saved += 1
      else out.proposed += 1
      return
    }
    if (!item.area) return void (out.skipped += 1)
    if (item.target === 'area' && told) {
      const r = await saveMemoryLine(supabase, { workspaceId, userId, area: item.area, scope: 'personal', text: item.text, source: 'told' })
      if (!r.ok || r.already) return void (out.skipped += 1)
      if (r.line.status === 'active') out.saved += 1
      else out.proposed += 1
      return
    }
    // Unverified or inferred personal lines (live, learned), and every
    // workspace line (a proposal for an owner or admin).
    const r = await learnMemoryLine(supabase, {
      workspaceId,
      userId,
      area: item.area,
      scope: item.target === 'workspace' ? 'workspace' : 'personal',
      text: item.text,
      source: told ? 'told' : 'learned',
    })
    if (!r.ok || r.already || !r.line) return void (out.skipped += 1)
    if (r.line.status === 'active') out.saved += 1
    else out.proposed += 1
  }

  for (const item of answer.stated.slice(0, CAPTURE_MAX_STATED)) await save(item, verified(item.evidence, item.text))
  for (const item of answer.inferred.slice(0, CAPTURE_MAX_INFERRED)) await save(item, false)

  for (const r of answer.replacements.slice(0, CAPTURE_MAX_REPLACEMENTS)) {
    const key = r.id.trim()
    if (touched.has(key)) continue
    touched.add(key)
    const ok = verified(r.evidence, r.text)
    const fact = factsByKey.get(key)
    if (fact) {
      if (profileFactProblem(normalizeMemoryText(r.text))) {
        out.skipped += 1
        continue
      }
      const routed = await routedTarget({ text: r.text, target: 'profile', area: null })
      if (!routed || routed.target !== 'profile') {
        // The new text names this workspace's things: not a profile fact.
        out.skipped += 1
        continue
      }
      if (fact.status === 'proposed') {
        const result = await reviseProposedFact(supabase, { userId, id: fact.id, text: r.text })
        if (result.ok && !result.already) out.replaced += 1
        else out.skipped += 1
      } else if (ok) {
        const result = await supersedeProfileFact(supabase, { userId, id: fact.id, text: r.text, source: 'told', sourceWorkspaceId: workspaceId })
        if (result.ok && !result.already) out.replaced += 1
        else out.skipped += 1
      } else {
        // Not the person's words: the new text waits as a proposal. Learned
        // facts go live (2026-10-17), but this one would sit live beside the
        // fact it contradicts, so the person settles it.
        const result = await saveProfileFact(supabase, { userId, text: r.text, source: 'learned', sourceWorkspaceId: workspaceId, proposeOnly: true })
        if (result.ok && !result.already) out.proposed += 1
        else out.skipped += 1
      }
      continue
    }
    const note = notesByKey.get(key)
    if (note) {
      const text = normalizeMemoryText(r.text)
      if (textProblem(text)) {
        out.skipped += 1
        continue
      }
      // In place only on the person's own, relevant words; otherwise left alone.
      if (!ok) {
        out.skipped += 1
        continue
      }
      // area_memory keeps no history: a note line is changed in place, only
      // the person's own personal line in this workspace.
      const { data, error } = await supabase
        .from('area_memory')
        .update(note.status === 'active' ? { text, source: 'told', updated_by: userId } : { text })
        .eq('id', note.id)
        .eq('workspace_id', workspaceId)
        .eq('scope', 'personal')
        .eq('user_id', userId)
        .select('id')
      if (!error && (data ?? []).length > 0) out.replaced += 1
      else out.skipped += 1
      continue
    }
    out.skipped += 1
  }

  for (const r of answer.removals.slice(0, CAPTURE_MAX_REMOVALS)) {
    const key = r.id.trim()
    if (touched.has(key)) continue
    touched.add(key)
    const fact = factsByKey.get(key)
    // Never a note: area_memory has no retired_at, and the pass never deletes
    // what the person keeps in a workspace. Only a profile fact, soft-retired,
    // on the person's own words naming at least half of it.
    if (!fact || !verified(r.evidence, fact.text, REMOVAL_RELEVANCE)) {
      out.skipped += 1
      continue
    }
    const result = await retireProfileFact(supabase, { userId, id: fact.id })
    if (result.ok) out.retired += 1
    else out.skipped += 1
  }
  return out
}

/** Why a queued capture is not run. */
export type CaptureSkip = 'unknown_operation' | 'already_applied' | 'empty' | 'not_member'

/**
 * The job's input: the operation's row (it must be this person's capture,
 * not yet applied), the slice (off the event, else off the row), and what
 * the model is shown. A person no longer in the workspace is skipped: their
 * notes there are not theirs to add to any more.
 */
export async function loadCaptureJob(
  supabase: SupabaseClient,
  data: CaptureJobRef & { slice?: unknown },
): Promise<{ input: CaptureInput } | { skip: CaptureSkip }> {
  const { data: row, error } = await supabase
    .from('chat_memory_op')
    .select('session_id, user_id, op, result')
    .eq('operation_id', data.operationId)
    .maybeSingle<{ session_id: string; user_id: string; op: string; result: unknown }>()
  if (error) throw new Error(`capture read: ${error.message}`)
  if (!row || row.op !== 'capture' || row.session_id !== data.sessionId || row.user_id !== data.userId) return { skip: 'unknown_operation' }
  const result = (row.result ?? {}) as { status?: unknown; slice?: unknown }
  if (result.status === 'applied') return { skip: 'already_applied' }
  const slice = validateSlice(data.slice ?? result.slice)
  if (!sliceHasPersonText(slice)) return { skip: 'empty' }

  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', data.workspaceId)
    .eq('user_id', data.userId)
    .maybeSingle()
  if (memberError) throw new Error(`member read: ${memberError.message}`)
  if (!member) return { skip: 'not_member' }

  const context = await loadCaptureContext(supabase, data)
  return {
    input: {
      operationId: data.operationId,
      sessionId: data.sessionId,
      userId: data.userId,
      workspaceId: data.workspaceId,
      conversationId: data.conversationId ?? null,
      slice,
      ...context,
    },
  }
}

/** Mark the operation applied: a replayed event finds it and writes nothing again. The slice is dropped. */
export async function markCaptureApplied(supabase: SupabaseClient, operationId: string, outcome: CaptureOutcome): Promise<void> {
  const { error } = await supabase
    .from('chat_memory_op')
    .update({ result: { status: 'applied', outcome } })
    .eq('operation_id', operationId)
    .eq('op', 'capture')
  if (error) throw new Error(`capture mark: ${error.message}`)
}

/** The checkpoint line's text: "3 facts saved, 1 proposed", or that nothing was new. Pure. */
export function checkpointText(outcome: CaptureOutcome): string {
  const bits: string[] = []
  if (outcome.saved > 0) bits.push(`${outcome.saved} ${outcome.saved === 1 ? 'fact' : 'facts'} saved`)
  if (outcome.proposed > 0) bits.push(`${outcome.proposed} proposed`)
  if (outcome.replaced > 0) bits.push(`${outcome.replaced} updated`)
  if (outcome.retired > 0) bits.push(`${outcome.retired} retired`)
  return bits.length > 0 ? bits.join(', ') : 'nothing new to remember'
}

/** The checkpoint's dedupe key: one line per operation, whatever its length. */
export function checkpointDedupeKey(operationId: string): string {
  return `chat-checkpoint:${createHash('sha256').update(operationId).digest('hex').slice(0, 40)}`
}

/** One `chat_checkpoint` log line for this pass (never throws; a lost line is a gap). */
export async function logCheckpoint(supabase: SupabaseClient, ref: CaptureJobRef, outcome: CaptureOutcome): Promise<boolean> {
  const line = logLineFor({ type: 'chat_checkpoint', text: checkpointText(outcome) })
  if (!line) return false
  return appendLogLine(
    {
      workspaceId: ref.workspaceId,
      userId: ref.userId,
      kind: line.kind,
      line: line.line,
      refType: ref.conversationId ? 'chat_conversation' : null,
      refId: ref.conversationId,
      dedupeKey: checkpointDedupeKey(ref.operationId),
    },
    supabase,
  )
}
