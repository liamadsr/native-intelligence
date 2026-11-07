import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'

/**
 * conversation/activity → (debounced) → claim/extract-from-source
 *
 * The chat routes fire a lightweight `conversation/activity` event on every
 * save. Inngest's debounce holds the function until the conversation has been
 * quiet for the debounce period — i.e. the chat is effectively over — and the
 * LAST event wins. Only then do we kick off the (LLM-bearing) extraction, so
 * a 30-message back-and-forth costs exactly one extraction, not thirty.
 *
 * Re-ingestion after further activity is safe: extraction dedupes claims by
 * vector similarity and provenance upserts are idempotent, so re-processing
 * an extended conversation grows evidence instead of duplicating claims.
 *
 * A conversation with an AI teammate (bots v2, chat_conversations.
 * ai_team_member_id, migration 300) is never ingested: its emitters already
 * skip it, and this is the one chokepoint every emitter's event passes, so a
 * missed emitter still can't feed it to the knowledge graph.
 */
export const conversationIngest = inngest.createFunction(
  {
    id: 'conversation-ingest',
    retries: 1,
    debounce: { key: 'event.data.conversationId', period: '20m' },
    triggers: [{ event: 'conversation/activity' }],
  },
  async ({ event, step }) => {
    const data = event.data as {
      workspaceId: string
      userId: string
      conversationId: string
    }
    const supabase = getServiceClient()

    const conversation = await step.run('load-conversation', async () => {
      const { data: conv } = await supabase
        .from('chat_conversations')
        .select('id, title, ai_team_member_id, agent_guest_id')
        .eq('id', data.conversationId)
        .eq('workspace_id', data.workspaceId)
        .maybeSingle()
      if (!conv) return null
      if (conv.ai_team_member_id) return { teammate: true as const }
      // A guest's texts with the agent the owner made for them (guest access)
      // are theirs, never the owner's facts.
      if (conv.agent_guest_id) return { guest: true as const }
      // Cheap pre-filter; the extraction job re-checks with full text rules.
      const { count } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', data.conversationId)
        .eq('workspace_id', data.workspaceId)
      return { title: (conv.title as string | null) ?? 'Conversation', messages: count ?? 0 }
    })

    if (conversation && 'teammate' in conversation) {
      return { status: 'skipped', reason: 'teammate_thread' }
    }
    if (conversation && 'guest' in conversation) {
      return { status: 'skipped', reason: 'guest_thread' }
    }
    if (!conversation || conversation.messages < 4) {
      return { status: 'skipped', reason: 'too_short_or_missing' }
    }

    const memberId = await step.run('resolve-member', async () => {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', data.userId)
        .eq('workspace_id', data.workspaceId)
        .maybeSingle()
      return member?.id ?? null
    })

    await step.sendEvent('send-extraction', {
      name: 'claim/extract-from-source',
      data: {
        workspaceId: data.workspaceId,
        userId: data.userId,
        memberId,
        sourceType: 'conversation',
        sourceId: data.conversationId,
        sourceLabel: `Chat: ${conversation.title}`,
      },
    })

    return { status: 'queued', conversationId: data.conversationId }
  },
)
