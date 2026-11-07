import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { appendAgentMessage } from '@/lib/live-agent/conversation-writer'
import { resolveDefaultRecipeForCapture } from '@/lib/live-agent/default-agent'
import { describeAttachedPackages } from '@/lib/live-agent/package-greeting'
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'

/**
 * POST /api/account/chat-history/live — get-or-create the capture-scoped chat
 * conversation for a live capture (live-agent → chat merge, plan WS-1b).
 *
 * Called by recording-context when a live-mode recording starts. Atomic
 * get-or-create against the unique capture_id index (migration 173): the
 * upsert with ignoreDuplicates means concurrent calls (React strict-mode
 * double effects, the first live turn racing the recording client) converge
 * on one conversation — and the greeting is written ONLY by the call that
 * actually created the row, with a stable message id as the second guard.
 *
 * The conversation's recipe_id is the agent listening in on the call (persona
 * continuity, plan D2): the chat pins it. recording-context calls again whenever that agent changes
 * mid-call, and an explicit, different id re-points the existing row.
 *
 * Owner-only: the conversation belongs to the capture owner (plan D6 — the v1
 * audience is the recorder; teammates keep HUD nudges + capture-page cards).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { capture_id, recipe_id } = (await request.json()) as {
    capture_id?: string
    /** The meeting persona driving this capture's live agent (persona
     *  continuity, plan D2) — the same recipe answers talk-back turns. */
    recipe_id?: string | null
  }

  if (!capture_id) {
    return NextResponse.json({ error: 'capture_id required' }, { status: 400 })
  }

  const { data: capture } = await supabase
    .from('captures')
    .select('id, user_id, title, created_at, package_ids')
    .eq('id', capture_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }
  if (capture.user_id !== user.id) {
    // Owner-only, mirroring the batch-extraction gate: the conversation is the
    // recorder's thread with THEIR meeting agent.
    return NextResponse.json({ error: 'Only the capture owner has a live conversation' }, { status: 403 })
  }

  // Persona: the agent the live-agent route will actually run for this call.
  // An explicit id is validated via RLS (a bogus/foreign id degrades to null —
  // the built-in Assistant — rather than erroring the recording start). With no
  // id, the workspace's default live agent: the same fallback the live-agent
  // route applies when a turn arrives without a recipe_id, e.g. when recording
  // started before the capture panel's live lock had selected the agent.
  const explicitRecipeId = typeof recipe_id === 'string' && recipe_id ? recipe_id : null
  const persona = explicitRecipeId
    ? await loadPersona(supabase, explicitRecipeId)
    : await loadDefaultPersona(supabase, workspaceId)

  const title = `Live: ${
    (capture.title as string | null)?.trim() ||
    new Date((capture.created_at as string) ?? Date.now()).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  }`

  // Atomic get-or-create: the ignored-duplicate upsert returns no row for the
  // loser, which doubles as the "did I create it?" signal for the greeting.
  const { data: createdRow, error: upsertError } = await supabase
    .from('chat_conversations')
    .upsert(
      {
        user_id: user.id,
        workspace_id: workspaceId,
        capture_id,
        recipe_id: persona?.id ?? null,
        title,
      },
      { onConflict: 'capture_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle()

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  let conversationId = (createdRow?.id as string | undefined) ?? null
  const created = conversationId !== null
  let recipeId = persona?.id ?? null

  if (!conversationId) {
    const { data: existing } = await supabase
      .from('chat_conversations')
      .select('id, recipe_id')
      .eq('capture_id', capture_id)
      .maybeSingle()
    conversationId = (existing?.id as string | undefined) ?? null
    if (!conversationId) {
      return NextResponse.json({ error: 'Failed to resolve conversation' }, { status: 500 })
    }
    const storedRecipeId = (existing?.recipe_id as string | null | undefined) ?? null
    recipeId = storedRecipeId
    // The live agent changed since the row was created (the live lock landing
    // after recording started, or a new selection): re-point the conversation
    // so the chat and the local live loop follow it. Only an explicit, valid id
    // moves it — a call without one is a re-open (live toggle,
    // resume), not a request to reset the persona.
    if (explicitRecipeId && persona && persona.id !== storedRecipeId) {
      const { error: updateError } = await supabase
        .from('chat_conversations')
        .update({ recipe_id: persona.id })
        .eq('id', conversationId)
      if (!updateError) recipeId = persona.id
    }
  }

  if (created) {
    // Attached context packages ("+ Packages" chip) get named in the greeting
    // — the user should SEE what's guiding the call. Names resolve server-side under the caller's RLS (never from
    // client labels), so an id the user can't see silently drops out.
    const packagesLine = await describeAttachedPackages(
      supabase,
      (capture.package_ids as string[] | null) ?? [],
    )
    const greeting = [
      persona
        ? `**${persona.name}** here — I'm listening in on this call.`
        : "I'm listening in on this call.",
      packagesLine,
      "I'll flag anything worth capturing as we go — and you can talk to me right here whenever you want me to look into something or make a change.",
    ]
      .filter(Boolean)
      .join(' ')

    // Stable id: if two creates ever race past the row-created check, the
    // message unique index still collapses them to one greeting.
    await appendAgentMessage(supabase, {
      captureId: capture_id,
      messageId: `greeting-${capture_id}`,
      parts: [{ type: 'text', text: greeting }],
      metadata: { kind: 'greeting' },
    })
  }

  return NextResponse.json({ conversationId, recipeId, created })
}

/**
 * GET /api/account/chat-history/live?capture_id=… — the capture's live
 * conversation, for its page's read-only "Live chat" section (one-chat plan,
 * Slice 3: after a call its thread is read there, with no history list
 * anywhere). Answers `{ conversationId, messageCount }`: `conversationId` null
 * when the capture has none of the caller's. Owner-only, as the POST: RLS
 * (chat_conversations: auth.uid() = user_id) plus the explicit user filter.
 * Reads nothing else; the thread itself is GET /api/account/chat-history/[id].
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const captureId = request.nextUrl.searchParams.get('capture_id')
  if (!captureId || !UUID_RE.test(captureId)) return badRequest('capture_id must be a capture id')

  const { data: conversation, error } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('capture_id', captureId)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string }>()
  if (error) {
    console.error('[chat-history/live] conversation read failed:', error.message)
    return serverError()
  }
  if (!conversation) return NextResponse.json({ conversationId: null, messageCount: 0 })

  const { count, error: countError } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
  if (countError) {
    console.error('[chat-history/live] message count failed:', countError.message)
    return serverError()
  }
  return NextResponse.json({ conversationId: conversation.id, messageCount: count ?? 0 })
}

interface Persona {
  id: string
  name: string
}

/** A recipe the caller can see under RLS, or null (unknown, foreign, bogus). */
async function loadPersona(supabase: SupabaseClient, recipeId: string): Promise<Persona | null> {
  const { data } = await supabase
    .from('recipe')
    .select('id, name')
    .eq('id', recipeId)
    .maybeSingle()
  return data ? { id: data.id as string, name: data.name as string } : null
}

/** The workspace's default live agent, or null for the built-in Assistant.
 *  resolveDefaultRecipeForCapture never throws. */
async function loadDefaultPersona(supabase: SupabaseClient, workspaceId: string): Promise<Persona | null> {
  const fallback = await resolveDefaultRecipeForCapture({ supabase, workspaceId, mode: 'live' })
  return fallback ? loadPersona(supabase, fallback.id) : null
}
