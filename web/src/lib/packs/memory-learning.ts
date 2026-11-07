/**
 * The nightly memory pass (one-agent plan Part 3, "Memory"), Mail tone.
 *
 * ON for everyone with a connected mailbox (Liam, 2026-10-17: learning on by
 * default). There is no opt-in: the "Learn from my sent mail overnight"
 * switch (migration 321) is gone, and migration 353 drops its table.
 *
 * Read live, keep nothing. Dial8 keeps no copy of the person's mail
 * (2026-10-15, migrations 341-344), and this pass keeps that promise: it reads
 * their recently SENT messages live from Gmail or Microsoft Graph
 * (readRecentSentMessages in src/lib/email/email-read-service.ts, through the
 * mailbox's own token), holds them in memory for one utility call, and stores
 * only the tone and style lines it learned, in their personal Mail note
 * (area_memory, scope personal). No subject, body or snippet is written to any
 * table or log line; the run log (area_memory_learning_run) holds the date of
 * the newest email read and the lines it learned.
 *
 *   Mail tone   the person's recent sent emails, read on the utility agent
 *               (kind memory_learn_mail_tone, each email wrapped as untrusted
 *               content) into at most three tone or sign-off lines.
 *
 * What it learns goes live at once, `learned` and with no author, so What
 * Dial8 has learned shows it as "Dial8 noticed this" with a one-tap remove
 * (2026-10-17), and the email drafts read it (src/lib/crm/email-drafts.ts).
 *
 * Bounds, so a nightly job can't run away:
 *   - only members of the workspace active in the last ACTIVE_DAYS days (a
 *     chat conversation of theirs changed there);
 *   - only people with a connected mailbox, and only the mailboxes a tool in
 *     that workspace may read (readableWorkspaceEmailAccounts): an account
 *     scoped to another workspace never teaches this one, and someone with
 *     nothing to read takes no place in the cap;
 *   - only when there is new signal since their last pass (MIN_NEW_SENT sent
 *     emails newer than the newest one the last pass read); a look that finds
 *     too little still claims the day, so the next run turns to others;
 *   - at most `maxUsers` people and `maxCalls` utility calls per run, before
 *     a wall-clock deadline, least recently passed first;
 *   - idempotent per day: a (workspace, person, area, day) row is claimed
 *     before the call (area_memory_learning_run's primary key), so a second
 *     run that day skips them;
 *   - the person's AI usage limit is checked before their call;
 *   - at most MEMORY_LEARNED_PER_NOTE lines it learned sit in a note at once,
 *     within MEMORY_NOTE_MAX_LINES active lines.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { resolveWorkspaceEdition } from '@/lib/editions'
import { readableWorkspaceEmailAccounts } from '@/lib/email/account-scope'
import { readRecentSentMessages } from '@/lib/email/email-read-service'
import { ownedMailbox } from '@/lib/email/thread-mailbox'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { enabledAreaGate } from './chat-packs'
import { MEMORY_LEARNED_PER_NOTE, MEMORY_NOTE_MAX_LINES, hasContactDetails, memoryTextProblem, normalizeMemoryText } from './memory-types'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'

/** People active in this many days are considered. */
export const ACTIVE_DAYS = 7
/** New sent emails since the last pass needed before another one runs. */
export const MIN_NEW_SENT = 3
/** How far back the sample of sent mail reaches. */
export const SAMPLE_DAYS = 30
/** Sent emails the model sees at most (read live, per mailbox, then the newest overall). */
export const SAMPLE_SENT = 15
/** Characters of one email body the model sees. */
const BODY_MAX_CHARS = 1_200
/** Lines one pass learns at most. */
export const MAX_PROPOSALS = 3
/** Per-run caps (the cron's). */
export const DEFAULT_MAX_USERS = 20
export const DEFAULT_MAX_CALLS = 20
/** How far back earlier passes' lines are remembered, so a removed line isn't learned again. */
const PROPOSED_MEMORY_DAYS = 90

export const MailToneSchema = z.object({ lines: z.array(z.string()) })
export type MailToneAnswer = z.infer<typeof MailToneSchema>

const DAY_MS = 24 * 60 * 60 * 1000

export interface LearningDeps {
  /** The utility call (runUtilityTask's structured form). */
  runUtility?: (args: {
    workspaceId: string
    userId: string
    message: string
    supabase: SupabaseClient
  }) => Promise<{ object: MailToneAnswer; model: string; usage: { inputTokens: number; outputTokens: number; costUsd: number | null; cacheReadTokens: number; cacheWriteTokens: number; steps: number } }>
  /** Whether the person is within their AI usage limit. Fails open. */
  withinUsage?: (supabase: SupabaseClient, userId: string) => Promise<boolean>
  /** Whether Mail is on in the workspace's edition. */
  mailEnabled?: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
  /** Usage logging; defaults to logUsage. */
  log?: typeof logUsage
  /** The mail accounts a tool in the workspace may read; defaults to readableWorkspaceEmailAccounts. */
  readableAccounts?: (userId: string, workspaceId: string) => Promise<Array<{ id: string; account_email: string | null }>>
  /**
   * One mailbox's recent sent mail, read live (defaults to readSentLive). Held
   * in memory only: never stored, never logged.
   */
  readSent?: (userId: string, accountId: string, opts: { since: string; limit: number }) => Promise<SentEmail[]>
}

export interface PassOptions {
  now?: Date
  maxUsers?: number
  maxCalls?: number
  /** Stop starting new people after this many ms. */
  deadlineMs?: number
}

export type PersonOutcome = 'learned' | 'nothing' | 'failed' | 'no_mailbox' | 'no_signal' | 'already_today' | 'mail_off' | 'over_limit' | 'claimed_elsewhere'

export interface PassSummary {
  candidates: number
  considered: number
  calls: number
  learned: number
  outcomes: Array<{ workspaceId: string; userId: string; outcome: PersonOutcome; learned?: number }>
  stoppedBy: 'done' | 'max_users' | 'max_calls' | 'deadline'
}

const defaultRunUtility: NonNullable<LearningDeps['runUtility']> = async ({ workspaceId, userId, message, supabase }) => {
  const result = await runUtilityTask({
    kind: 'memory_learn_mail_tone',
    supabase,
    workspaceId,
    userId,
    // A free user's pass runs on their own ChatGPT plan (withinUsage below lets them in).
    chatgptPlan: await chatgptPlanFor(userId),
    outputSchema: MailToneSchema,
    message,
  })
  return { object: result.object as MailToneAnswer, model: result.model, usage: result.usage }
}

const defaultWithinUsage: NonNullable<LearningDeps['withinUsage']> = async (supabase, userId) => {
  // Opted in to the ChatGPT free tier: the pass runs a free user on their own plan.
  const { data, error } = await supabase.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
  // Unattended spend: a meter that can't be read blocks, as the auto-attempt
  // gate does. The pass comes back on a later night.
  if (error) return false
  const row = Array.isArray(data) ? data[0] : data
  return !(row && (row as { allowed?: boolean }).allowed === false)
}

const defaultMailEnabled: NonNullable<LearningDeps['mailEnabled']> = async (supabase, workspaceId) =>
  enabledAreaGate(await resolveWorkspaceEdition(supabase, workspaceId))('mail')

/** The UTC day key a run claims. */
export function runDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * The people the pass may look at: every member whose chat conversation in a
 * workspace changed in the last ACTIVE_DAYS days, one entry per (workspace,
 * person), the most recent first, only where they are still a member (a
 * conversation outlives a removal), and only people with a connected, enabled
 * mailbox. No opt-in (2026-10-17): with everyone a candidate, someone with no
 * mail to read must not take a place in the run's cap.
 */
export async function activePeople(supabase: SupabaseClient, now: Date): Promise<Array<{ workspaceId: string; userId: string }>> {
  const since = new Date(now.getTime() - ACTIVE_DAYS * DAY_MS).toISOString()
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('user_id, workspace_id, updated_at')
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(2_000)
  if (error) throw new Error(error.message)
  const seen = new Set<string>()
  const out: Array<{ workspaceId: string; userId: string }> = []
  for (const r of (data ?? []) as Array<{ user_id: string | null; workspace_id: string | null }>) {
    if (!r.user_id || !r.workspace_id) continue
    const key = `${r.workspace_id}:${r.user_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ workspaceId: r.workspace_id, userId: r.user_id })
  }
  if (out.length === 0) return out
  const { data: members, error: memberError } = await supabase
    .from('member')
    .select('workspace_id, user_id')
    .in('user_id', [...new Set(out.map((p) => p.userId))])
  if (memberError) throw new Error(memberError.message)
  const isMember = new Set(((members ?? []) as Array<{ workspace_id: string; user_id: string }>).map((m) => `${m.workspace_id}:${m.user_id}`))
  const stillMembers = out.filter((p) => isMember.has(`${p.workspaceId}:${p.userId}`))
  if (stillMembers.length === 0) return stillMembers
  const { data: accounts, error: accountError } = await supabase
    .from('connected_account')
    .select('user_id')
    .in('user_id', [...new Set(stillMembers.map((p) => p.userId))])
    .eq('capability', 'email')
    .eq('is_enabled', true)
  if (accountError) throw new Error(accountError.message)
  const hasMailbox = new Set(((accounts ?? []) as Array<{ user_id: string }>).map((a) => a.user_id))
  return stillMembers.filter((p) => hasMailbox.has(p.userId))
}

interface LastRuns {
  /** The newest signal any earlier pass read. */
  signalUntil: string | null
  /** The day of the latest pass. */
  lastDate: string | null
  ranToday: boolean
  /** What earlier passes learned (so a line the person removed isn't learned again). */
  proposed: string[]
}

async function lastRuns(supabase: SupabaseClient, workspaceId: string, userId: string, today: string, now: Date): Promise<LastRuns> {
  const { data } = await supabase
    .from('area_memory_learning_run')
    .select('run_date, signal_until, proposed')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .eq('area', 'mail')
    .order('run_date', { ascending: false })
    .limit(60)
  const rows = (data ?? []) as Array<{ run_date: string; signal_until: string | null; proposed: string[] | null }>
  const proposedSince = runDate(new Date(now.getTime() - PROPOSED_MEMORY_DAYS * DAY_MS))
  return {
    signalUntil: rows.map((r) => r.signal_until).filter((s): s is string => !!s).sort().at(-1) ?? null,
    lastDate: rows[0]?.run_date ?? null,
    ranToday: rows.some((r) => r.run_date === today),
    proposed: rows.filter((r) => r.run_date >= proposedSince).flatMap((r) => r.proposed ?? []),
  }
}

/** One sent email, as read live: in memory only, never stored. */
export interface SentEmail {
  subject: string | null
  body: string
  /** When it was sent (ISO). */
  date: string
}

/**
 * One mailbox's sent mail, live: the person's own enabled account's token
 * (ownedMailbox), then Gmail's `in:sent` or Graph's Sent Items
 * (readRecentSentMessages). An account that isn't theirs, or can't be read,
 * gives nothing.
 */
export async function readSentLive(userId: string, accountId: string, opts: { since: string; limit: number }): Promise<SentEmail[]> {
  const mailbox = await ownedMailbox(userId, accountId)
  if (!mailbox) return []
  const messages = await readRecentSentMessages(mailbox, opts)
  return messages
    // An auto-reply or list mail sent from the mailbox says nothing about how they write.
    .filter((m) => !m.automatedBy && m.dateISO)
    .map((m) => ({ subject: m.subject && m.subject !== '(no subject)' ? m.subject : null, body: m.bodyText, date: m.dateISO as string }))
}

/** Every readable mailbox's sent mail since `since`, newest first, at most `limit` overall. */
async function sentAcross(
  read: NonNullable<LearningDeps['readSent']>,
  userId: string,
  accountIds: readonly string[],
  since: string,
  limit: number,
): Promise<SentEmail[]> {
  const perBox = await Promise.all(accountIds.map((id) => read(userId, id, { since, limit }).catch(() => [] as SentEmail[])))
  return perBox
    .flat()
    .filter((e) => e.date >= since)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
}

/** An email's own words: quoted history and signatures' tails cut, whitespace tidied, capped. */
export function ownWords(body: string | null): string {
  if (!body) return ''
  const lines: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue
    // Where the quoted thread begins ("On Tue, … wrote:", "-----Original Message-----", "From: …").
    if (/^\s*On .{4,200}wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^\s*From:\s.+/i.test(line)) break
    lines.push(line)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, BODY_MAX_CHARS)
}

/**
 * The utility task's message: the person's mail as data, then what they
 * already have or were offered. Every email body, subject and draft sits
 * inside an untrusted-content marker (wrapUntrusted): a sent mail quotes what
 * others wrote, and a draft was written from their mail, so none of it may
 * steer the pass. The message is built in memory for the one call and kept
 * nowhere.
 */
export function buildMailToneMessage(input: {
  sent: Array<{ subject: string | null; body: string }>
  edits: Array<{ draft: string; sent: string }>
  existing: string[]
}): string {
  const parts: string[] = ['## Emails they sent recently (their own words, newest first)']
  input.sent.forEach((e, i) =>
    parts.push(`### Email ${i + 1}\n${wrapUntrusted(`${e.subject ? `Subject: ${e.subject.slice(0, 120)}\n\n` : ''}${e.body}`)}`),
  )
  if (input.edits.length > 0) {
    parts.push('## AI drafts they edited before sending')
    input.edits.forEach((e, i) =>
      parts.push(`### Draft ${i + 1}, as the AI wrote it\n${wrapUntrusted(e.draft)}\n### Draft ${i + 1}, as they sent it\n${wrapUntrusted(e.sent)}`),
    )
  }
  parts.push('## Lines they already have or were already offered (do not repeat)', ...(input.existing.length > 0 ? input.existing.map((t) => `- ${t}`) : ['(none)']))
  return parts.join('\n\n')
}

/** The model's lines, cleaned: valid, free of contact details, new, at most MAX_PROPOSALS. Pure. */
export function cleanProposals(lines: readonly unknown[], existing: readonly string[]): string[] {
  const taken = new Set(existing.map((t) => normalizeMemoryText(t).toLowerCase()))
  const out: string[] = []
  for (const raw of lines) {
    if (typeof raw !== 'string') continue
    const text = normalizeMemoryText(raw)
    if (memoryTextProblem(text) || hasContactDetails(text)) continue
    const key = text.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    out.push(text)
    if (out.length >= MAX_PROPOSALS) break
  }
  return out
}

/** One person's Mail tone pass, after the caller's caps allowed it. Returns its outcome and whether it called the model. */
async function learnMailTone(
  supabase: SupabaseClient,
  person: { workspaceId: string; userId: string },
  ctx: { now: Date; today: string; deps: Required<LearningDeps> },
): Promise<{ outcome: PersonOutcome; called: boolean; learned?: number }> {
  const { workspaceId, userId } = person
  const last = await lastRuns(supabase, workspaceId, userId, ctx.today, ctx.now)
  if (last.ranToday) return { outcome: 'already_today', called: false }
  if (!(await ctx.deps.mailEnabled(supabase, workspaceId))) return { outcome: 'mail_off', called: false }

  // Their mailboxes are all scoped to other workspaces: nothing to read here.
  const accountIds = (await ctx.deps.readableAccounts(userId, workspaceId)).map((a) => a.id)
  if (accountIds.length === 0) return { outcome: 'no_mailbox', called: false }
  const sampleSince = new Date(ctx.now.getTime() - SAMPLE_DAYS * DAY_MS).toISOString()
  const signalSince = last.signalUntil && last.signalUntil > sampleSince ? last.signalUntil : sampleSince
  // One live read per mailbox: the sample, and from it whether enough is new.
  const sample = await sentAcross(ctx.deps.readSent, userId, accountIds, sampleSince, SAMPLE_SENT)
  const fresh = sample.filter((e) => e.date > signalSince)
  if (fresh.length < MIN_NEW_SENT) {
    // The day is claimed even so (no signal_until: the next pass still waits
    // for the same new mail), so tomorrow's run turns to the people it hasn't
    // looked at instead of reading this mailbox first again.
    await supabase.from('area_memory_learning_run').insert({ workspace_id: workspaceId, user_id: userId, area: 'mail', run_date: ctx.today, outcome: 'nothing' })
    return { outcome: 'no_signal', called: false }
  }

  if (!(await ctx.deps.withinUsage(supabase, userId))) return { outcome: 'over_limit', called: false }

  // Claim the day before the call: a second run today finds the row and skips.
  const claim = await supabase.from('area_memory_learning_run').insert({ workspace_id: workspaceId, user_id: userId, area: 'mail', run_date: ctx.today })
  if (claim.error) return { outcome: 'claimed_elsewhere', called: false }

  const finish = (patch: Record<string, unknown>) =>
    supabase.from('area_memory_learning_run').update(patch).eq('workspace_id', workspaceId).eq('user_id', userId).eq('area', 'mail').eq('run_date', ctx.today)

  try {
    const sent = sample.map((e) => ({ subject: e.subject, body: ownWords(e.body) })).filter((e) => e.body)
    // No AI drafts beside what was sent: Dial8 keeps no sent drafts to compare
    // (2026-10-15), so the pass reads sent mail alone.
    const edits: Array<{ draft: string; sent: string }> = []
    const { data: noteRows } = await supabase
      .from('area_memory')
      .select('text, status, source, created_by')
      .eq('workspace_id', workspaceId)
      .eq('area', 'mail')
      .eq('scope', 'personal')
      .eq('user_id', userId)
      .limit(1_000)
    const noteLines = (noteRows ?? []) as Array<{ text: string; status: string; source: string; created_by: string | null }>
    const note = noteLines.map((r) => r.text)
    // Room left for what Dial8 learns: its own lines in the note, and the note's active lines.
    const room = Math.min(
      MEMORY_LEARNED_PER_NOTE - noteLines.filter((r) => r.source === 'learned' && r.created_by === null).length,
      MEMORY_NOTE_MAX_LINES - noteLines.filter((r) => r.status === 'active').length,
    )
    const existing = [...note, ...last.proposed]
    // A date only: the newest email read, so the next pass waits for newer mail.
    const signalUntil = fresh[0].date

    // Nothing to read, or no room for another line: no call.
    if (sent.length === 0 || room <= 0) {
      await finish({ outcome: 'nothing', signal_until: signalUntil })
      return { outcome: 'nothing', called: false }
    }

    const result = await ctx.deps.runUtility({ workspaceId, userId, supabase, message: buildMailToneMessage({ sent, edits, existing }) })
    await ctx.deps.log(userId, {
      provider: usageProviderLabel(result.model),
      model: result.model,
      feature: 'memory_learning',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: 0,
      costUsd: result.usage.costUsd ?? undefined,
      idempotencyKey: `memory-learning:mail:${workspaceId}:${userId}:${ctx.today}`,
      metadata: { workspace_id: workspaceId, area: 'mail', ...usageCacheMetadata(result.usage) },
    })

    const lines = cleanProposals(result.object.lines ?? [], existing).slice(0, room)
    if (lines.length > 0) {
      // Live at once, learned, no author: What Dial8 has learned marks them
      // "Dial8 noticed this" with a one-tap remove (2026-10-17).
      const { error } = await supabase.from('area_memory').insert(
        lines.map((text) => ({
          workspace_id: workspaceId,
          area: 'mail',
          scope: 'personal',
          user_id: userId,
          text,
          status: 'active',
          source: 'learned',
          created_by: null,
          updated_by: null,
        })),
      )
      if (error) throw new Error(error.message)
    }
    // The run log's own words (migration 317): `proposed` is what this pass added.
    await finish({ outcome: lines.length > 0 ? 'proposed' : 'nothing', signal_until: signalUntil, proposed: lines })
    return { outcome: lines.length > 0 ? 'learned' : 'nothing', called: true, learned: lines.length }
  } catch (err) {
    // The day stays claimed (no retry storm); signal_until stays empty, so
    // tomorrow tries again. The error's message only: never mail text.
    console.error(`[memory-learning] mail pass failed: ${err instanceof Error ? err.message : String(err)}`)
    await finish({ outcome: 'failed' })
    return { outcome: 'failed', called: true }
  }
}

/**
 * One nightly run: the active people, least recently passed first, each given
 * a Mail tone pass when they have new signal, under the run's caps. Never
 * throws for one person's failure.
 */
export async function runMemoryLearningPass(supabase: SupabaseClient, opts: PassOptions = {}, deps: LearningDeps = {}): Promise<PassSummary> {
  const now = opts.now ?? new Date()
  const today = runDate(now)
  const maxUsers = opts.maxUsers ?? DEFAULT_MAX_USERS
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS
  const started = Date.now()
  const full: Required<LearningDeps> = {
    runUtility: deps.runUtility ?? defaultRunUtility,
    withinUsage: deps.withinUsage ?? defaultWithinUsage,
    mailEnabled: deps.mailEnabled ?? defaultMailEnabled,
    log: deps.log ?? logUsage,
    readableAccounts: deps.readableAccounts ?? readableWorkspaceEmailAccounts,
    readSent: deps.readSent ?? readSentLive,
  }

  const people = await activePeople(supabase, now)
  // Least recently passed first, so a capped run doesn't favour the same people every night.
  const { data: runRows } = people.length
    ? await supabase
        .from('area_memory_learning_run')
        .select('workspace_id, user_id, run_date')
        .eq('area', 'mail')
        .in('user_id', [...new Set(people.map((p) => p.userId))])
        .order('run_date', { ascending: false })
        .limit(5_000)
    : { data: [] }
  const lastByPerson = new Map<string, string>()
  for (const r of (runRows ?? []) as Array<{ workspace_id: string; user_id: string; run_date: string }>) {
    const key = `${r.workspace_id}:${r.user_id}`
    if (!lastByPerson.has(key)) lastByPerson.set(key, r.run_date)
  }
  const ordered = [...people].sort((a, b) => (lastByPerson.get(`${a.workspaceId}:${a.userId}`) ?? '').localeCompare(lastByPerson.get(`${b.workspaceId}:${b.userId}`) ?? ''))

  const summary: PassSummary = { candidates: people.length, considered: 0, calls: 0, learned: 0, outcomes: [], stoppedBy: 'done' }
  for (const person of ordered) {
    if (summary.considered >= maxUsers) {
      summary.stoppedBy = 'max_users'
      break
    }
    if (summary.calls >= maxCalls) {
      summary.stoppedBy = 'max_calls'
      break
    }
    if (opts.deadlineMs !== undefined && Date.now() - started > opts.deadlineMs) {
      summary.stoppedBy = 'deadline'
      break
    }
    let result: { outcome: PersonOutcome; called: boolean; learned?: number }
    try {
      result = await learnMailTone(supabase, person, { now, today, deps: full })
    } catch (err) {
      console.error(`[memory-learning] person skipped: ${err instanceof Error ? err.message : String(err)}`)
      result = { outcome: 'failed', called: false }
    }
    // No mailbox this workspace may read: no place taken in the run's cap.
    if (result.outcome !== 'no_mailbox') summary.considered += 1
    if (result.called) summary.calls += 1
    summary.learned += result.learned ?? 0
    summary.outcomes.push({ ...person, outcome: result.outcome, ...(result.learned ? { learned: result.learned } : {}) })
  }
  return summary
}
