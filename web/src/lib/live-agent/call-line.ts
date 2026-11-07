import type { SupabaseClient } from '@supabase/supabase-js'
import { findMeetingGoalForCapture } from '@/lib/meetings/meeting-goal'

/**
 * The main agent's one line about a call going on (one-chat plan, Slice 3,
 * "The main agent during a call"): while the person records a live capture,
 * the main chat stays their main agent (the call's live agent talks in its own
 * chat, in the HUD), and each of its turns carries the capture
 * (systemContext.onCallCaptureId). This turns that into the `call` turn-context
 * section:
 *
 *   ## On a call now
 *   On a call now: "Acme renewal", live agent Sales Coach (capture <id>), their goal (their words): "close the pilot". …
 *
 * It is never the live meeting's context (the transcript's tail, the
 * proposals): the main agent reads the transcript with the capture tools when
 * the person asks about the call, and it has no tell_note_taker
 * (chat-run-rebuild.ts leaves that to live turns).
 *
 * OWNERSHIP IS ENFORCED HERE: the id is client-controlled, so the capture must
 * be the caller's own, in this workspace (as buildLiveCaptureContext checks),
 * and still going (no `ended_at`). Anything else is no line. The live agent is
 * the capture conversation's persona (its recipe_id; none = the built-in
 * Assistant). The person's own goal for the meeting (meeting_goal, read for
 * them alone: findMeetingGoalForCapture fences on the person) rides the line
 * in a few quoted words when there is one (live sidekick plan, Phase 4).
 * Best-effort: a failed read is no line (no goal, for the goal's read), never
 * a failed turn.
 */
export async function buildCallLine(
  supabase: SupabaseClient,
  captureId: string,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  if (!isId(captureId)) return null
  const [captureRead, conversationRead, goal] = await Promise.all([
    supabase
      .from('captures')
      .select('id, title, ended_at')
      .eq('id', captureId)
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle<{ id: string; title: string | null; ended_at: string | null }>(),
    supabase
      .from('chat_conversations')
      .select('recipe_id')
      .eq('capture_id', captureId)
      .eq('user_id', userId)
      .maybeSingle<{ recipe_id: string | null }>(),
    findMeetingGoalForCapture(supabase, { workspaceId, userId, captureId }).catch(() => null),
  ])
  const capture = captureRead.data
  if (captureRead.error || !capture || capture.ended_at) return null
  const recipeId = conversationRead.data?.recipe_id ?? null
  let agentName = 'Assistant'
  if (recipeId) {
    const { data: recipe } = await supabase.from('recipe').select('name').eq('id', recipeId).maybeSingle<{ name: string | null }>()
    agentName = oneLine(recipe?.name) || agentName
  }
  return renderCallLine({
    captureId: capture.id,
    title: oneLine(capture.title) || 'Untitled call',
    agentName,
    goal: oneLine(goal?.goal, MAX_GOAL_CHARS) || null,
  })
}

/** The section's text. Pure. */
export function renderCallLine({
  captureId,
  title,
  agentName,
  goal = null,
}: {
  captureId: string
  title: string
  agentName: string
  /** The person's goal for the meeting, already one short line (no double quotes). */
  goal?: string | null
}): string {
  return [
    '## On a call now',
    `On a call now: "${title}", live agent ${agentName} (capture ${captureId})${goal ? `, their goal (their words): "${goal}"` : ''}. ` +
      'The live agent is with the person on the call and answers them there; you carry on with everything else. ' +
      'When they ask you about the call, read it with the capture tools (get_capture_transcript, get_capture_content) on that capture.',
  ].join('\n')
}

const MAX_NAME_CHARS = 120
/** The goal in a few words: the line stays one line. */
const MAX_GOAL_CHARS = 140

/** A title, name or goal as one short line: no newlines, quotes or runs of space. */
function oneLine(value: string | null | undefined, max = MAX_NAME_CHARS): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/["\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value)
}
