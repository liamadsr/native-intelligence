/**
 * Writes the signup researcher's brief into the member's durable HOME
 * conversation as the opening assistant message — the first beat of
 * conversational onboarding ("the dashboard is the reveal").
 *
 * WHY A MIRROR (not an import of src/lib/chat/home-message-writer.ts): the eve
 * compile bundles ONLY this agent's tree (agents/onboarding-researcher/*), so a
 * tool cannot import from src/. This file is the deliberate agent-side twin of
 * that writer — same get-or-create of the member's home thread
 * (`chat_conversations.is_home`, migration 330; see
 * home-conversation-pointer.ts), same
 * stable-messageId + ignoreDuplicates upsert (migration 173) idempotency. Keep
 * the two in sync, exactly as research-progress.ts mirrors the app's merge.
 *
 * SECURITY: tenancy (userId, workspaceId) comes from the verified principal via
 * requireOwner(ctx) — NEVER from model input — before this is called. The
 * get-or-create is pinned to that pair, so the brief can only ever land in the
 * ONE home conversation that member owns.
 *
 * IDEMPOTENT ACROSS RE-RUNS: finish_research is CAS-guarded and can re-run; the
 * stable message id `onboarding-brief-<workspaceId>` collapses every re-run,
 * double-finish, and resync race onto ONE bubble (ignoreDuplicates → the first
 * write stands). Best-effort by design: a chat-write failure NEVER fails the
 * research run — the brief is already durably persisted to onboarding_progress
 * before this runs, and F2's client adoption renders it from there as a
 * fallback.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SeededSummary, ResearchActivityEntry } from './research-progress.js'
import { resolveHomeConversation } from './home-conversation-pointer.js'

export interface HomeBriefResult {
  written: boolean
  conversationId?: string
  created?: boolean
  reason?: 'no_conversation' | 'error'
}

/**
 * Compose the opening chat message from the researcher's authored brief.
 *
 * Beat 1 rules (see the experience script):
 *   - The body is the researcher's OWN authored brief — warm, first-person,
 *     honest. We never re-author or invent knowledge here.
 *   - When starter content was seeded, add ONE line naming the project in prose
 *     (a real in-app project LINK is not an authorable message part for a plain
 *     assistant bubble — entity links only ride tool outputs — so we DEGRADE to
 *     naming the project, per the design's explicit fallback rule).
 *   - Gate the seeded line on seededSummary PRESENCE (never status): a light /
 *     skipped run that seeded nothing gets no seeded line and never fakes it.
 *   - End on an INVITATION, not a full stop — it opens a dialogue, it isn't a
 *     banner. "Have a look… I'll be right here."
 */
export function composeBriefMessage(
  brief: string,
  seededSummary: SeededSummary | undefined,
): string {
  const parts: string[] = [brief.trim()]

  if (seededSummary?.projectName) {
    const n = seededSummary.actionCount
    const steps =
      n > 0
        ? ` with ${n} first ${n === 1 ? 'step' : 'steps'} already on the board`
        : ''
    parts.push(
      `I set up a project called **${seededSummary.projectName}**${steps} — ` +
        `have a look, then tell me if any of it's off. I'll be right here.`,
    )
  } else {
    // No seeded content (light/skipped run). Keep the invitation, drop the
    // seeded line entirely — never name a project that doesn't exist.
    parts.push("Have a look around, and tell me if anything's off. I'll be right here.")
  }

  return parts.join('\n\n')
}

/**
 * Strip the trailing "…" and any leading present-tense verb dressing from a
 * captured label so it reads as a past-tense, scannable bullet in the recap.
 * We keep it simple and lossless-enough: drop the ellipsis, lower the first
 * letter is NOT done (labels are already sentence-case fragments). The label
 * text itself ("Searching the web for Acme", "Reading acme.com") carries the
 * meaning; we only de-"…" it.
 */
function tidyLabel(label: string): string {
  return label.replace(/[.…]+$/, '').trim()
}

/**
 * Compose the "here's what I looked into" recap from the captured tool-call
 * trail. Returns null when there's nothing worth showing (no entries, or only
 * entries that produced no distinct line) so the caller writes NO message rather
 * than an empty one — the recap is gated on real data existing (founder ask #3).
 *
 * The recap is deliberately COMPACT and GROUPED, not a raw event log:
 *   - web_search / web_fetch entries become one "Looked around the web" group
 *     (deduped labels, capped) — the browsing story in one scannable block;
 *   - the save_* entries (company profile, claims, starter content) become a
 *     short "Set things up" group.
 * The two groups mirror the run's two phases (research → assembly). Everything is
 * driven off the pre-computed `label`, so this stays in lockstep with the live
 * wizard's wording without re-deriving anything from raw tool input.
 */
export function composeActivityMessage(
  activityLog: ResearchActivityEntry[] | undefined,
): string | null {
  if (!activityLog || activityLog.length === 0) return null

  const webLines: string[] = []
  const setupLines: string[] = []
  const seenWeb = new Set<string>()
  const seenSetup = new Set<string>()

  for (const entry of activityLog) {
    const line = tidyLabel(entry.label)
    if (!line) continue
    if (entry.toolName === 'web_search' || entry.toolName === 'web_fetch') {
      if (seenWeb.has(line)) continue
      seenWeb.add(line)
      webLines.push(line)
    } else {
      if (seenSetup.has(line)) continue
      seenSetup.add(line)
      setupLines.push(line)
    }
  }

  if (webLines.length === 0 && setupLines.length === 0) return null

  // Keep each group tight — a recap, not a transcript. The earliest calls are the
  // most representative, so cap from the front.
  const WEB_CAP = 8
  const SETUP_CAP = 6
  const parts: string[] = ["Here's what I looked into while you were signing up."]

  if (webLines.length > 0) {
    const shown = webLines.slice(0, WEB_CAP)
    const extra = webLines.length - shown.length
    const bullets = shown.map((l) => `- ${l}`)
    if (extra > 0) bullets.push(`- …and ${extra} more`)
    parts.push('**Around the web**\n' + bullets.join('\n'))
  }

  if (setupLines.length > 0) {
    const bullets = setupLines.slice(0, SETUP_CAP).map((l) => `- ${l}`)
    parts.push('**Setting up your workspace**\n' + bullets.join('\n'))
  }

  parts.push('Ask me about any of it — it all came from those, not a guess.')
  return parts.join('\n\n')
}

/**
 * Get-or-create the member's home conversation (via the onboarding_progress
 * pointer) and write the onboarding messages idempotently: FIRST an optional
 * "here's what I looked into" recap of the research trail, THEN the opening brief.
 *
 * The recap is written with an EARLIER created_at so it renders ABOVE the brief
 * (the home read orders by created_at ASC), and is GATED on a real trail existing
 * — a run that captured no activity writes only the brief, exactly as before.
 * This is founder ask #3: the research the agent did is in the message history,
 * so the user can see what it found and ask questions about it.
 *
 * Both rows are the main agent's own opening messages: from the person's first
 * reply it walks them through getting started (docs/plans/getting-started-skill.md),
 * with these two in the thread's history. The brief carries
 * `onboarding_brief:true`; the recap carries `onboarding_activity:true`.
 */
export async function writeBriefToHome(
  service: SupabaseClient,
  args: {
    userId: string
    workspaceId: string
    brief: string
    seededSummary?: SeededSummary
    activityLog?: ResearchActivityEntry[]
  },
): Promise<HomeBriefResult> {
  try {
    const conversation = await resolveHomeConversation(service, args.userId, args.workspaceId)
    if (!conversation) return { written: false, reason: 'no_conversation' }
    const { conversationId, created } = conversation

    // Anchor timestamps so the recap always sorts above the brief regardless of
    // clock jitter / insertion order. Both stable-id upserts are idempotent, and
    // ignoreDuplicates means a re-run keeps the FIRST created_at — so ordering is
    // stable across finish_research re-runs too.
    const briefAt = new Date()
    const recapAt = new Date(briefAt.getTime() - 1000)

    // ── Recap (optional, first) ──────────────────────────────────────────────
    const recapText = composeActivityMessage(args.activityLog)
    if (recapText) {
      const recapId = `onboarding-activity-${args.workspaceId}`
      const recapMessage = {
        id: recapId,
        role: 'assistant' as const,
        parts: [{ type: 'text', text: recapText }],
        metadata: {
          onboarding_home: true,
          onboarding_activity: true,
        },
      }
      const { error: recapErr } = await service.from('chat_messages').upsert(
        {
          conversation_id: conversationId,
          user_id: args.userId,
          workspace_id: args.workspaceId,
          role: 'assistant',
          ui_message: recapMessage,
          created_at: recapAt.toISOString(),
        },
        { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true },
      )
      if (recapErr) {
        // Non-fatal: the recap is a bonus, the brief is the payload. Log and
        // continue to the brief write.
        console.warn('home-brief-writer: activity recap upsert failed:', recapErr.message)
      }
    }

    // ── Brief (always, second) ───────────────────────────────────────────────
    const messageId = `onboarding-brief-${args.workspaceId}`
    const text = composeBriefMessage(args.brief, args.seededSummary)
    const uiMessage = {
      id: messageId,
      role: 'assistant' as const,
      parts: [{ type: 'text', text }],
      metadata: {
        onboarding_home: true,
        onboarding_brief: true,
      },
    }

    const { error } = await service.from('chat_messages').upsert(
      {
        conversation_id: conversationId,
        user_id: args.userId,
        workspace_id: args.workspaceId,
        role: 'assistant',
        ui_message: uiMessage,
        created_at: briefAt.toISOString(),
      },
      { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true },
    )
    if (error) {
      console.warn('home-brief-writer: brief upsert failed:', error.message)
      return { written: false, conversationId, created, reason: 'error' }
    }

    void service
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .then(undefined, () => {})

    return { written: true, conversationId, created }
  } catch (err) {
    console.warn('home-brief-writer: brief write threw:', err)
    return { written: false, reason: 'error' }
  }
}
