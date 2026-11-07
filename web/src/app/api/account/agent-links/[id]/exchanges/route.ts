import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { getLinkForParty } from '@/lib/agent-links/store'
import {
  AGENT_LINK_EXCHANGE_STATES,
  AGENT_LINK_MESSAGE_KINDS,
  type AgentLinkExchangeState,
  type AgentLinkMessageKind,
  type AgentLinkState,
  type ExchangeView,
} from '@/lib/agent-links/views'
import { NextResponse, type NextRequest } from 'next/server'

type RouteContext = { params: Promise<{ id: string }> }

/** The most exchanges the conversation card reads in one go. */
export const AGENT_LINK_EXCHANGE_PAGE = 20

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ExchangeRow {
  id: string
  topic: string
  state: string
  started_by_user_id: string
  created_at: string
  closed_at: string | null
}

interface MessageRow {
  id: string
  exchange_id: string
  from_user_id: string
  kind: string
  body: string
  created_at: string
}

/** What the card's header says of the link, from the reader's side. */
export interface ExchangesLinkView {
  id: string
  state: AgentLinkState
  /** The other person, by the name the reader gave them in People. */
  peerName: string
  /** The workspace their agent answers from; null until they accept. */
  workspaceName: string | null
  /** The reader's half (agent_guest), for "Manage in People". */
  myHalfGuestId: string | null
}

const oneOf = <T extends string>(values: readonly T[], v: string, fallback: T): T => ((values as readonly string[]).includes(v) ? (v as T) : fallback)

/**
 * GET: the conversation between the signed-in person's agent and the other
 * person's agent over one link (agent links phase D), for the read-only card
 * in their chat (src/components/chat-cards/pages/agent-link-card.tsx): the
 * link as the reader sees it, and its exchanges, newest first, each with its
 * messages oldest first, `from` 'me' or 'them'. `?before=<ISO>` pages back to
 * exchanges started before then.
 *
 * Only the two people on the link: read with the service role (the other
 * side's workspace name isn't the reader's to read), fenced on the reader
 * being its requester or its target. Anyone else, and a link that never was,
 * is a 404 either way. A link that ended still shows what was said. Read-only.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('No such link')

  const db = getServiceClient()
  let link
  try {
    link = await getLinkForParty(db, id, user.id)
  } catch (err) {
    console.error('[agent-links] link read failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read this link')
  }
  if (!link) return notFound('No such link')

  const mine = link.requesterUserId === user.id
  const myHalfGuestId = mine ? link.requesterGuestId : link.targetGuestId
  const theirWorkspaceId = mine ? link.targetWorkspaceId : link.requesterWorkspaceId

  const before = new URL(request.url).searchParams.get('before')
  const cursor = before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : null

  try {
    const [half, workspace, page] = await Promise.all([
      myHalfGuestId
        ? db.from('agent_guest').select('display_name').eq('id', myHalfGuestId).eq('owner_user_id', user.id).maybeSingle<{ display_name: string }>()
        : Promise.resolve({ data: null, error: null }),
      theirWorkspaceId
        ? db.from('workspace').select('name').eq('id', theirWorkspaceId).maybeSingle<{ name: string | null }>()
        : Promise.resolve({ data: null, error: null }),
      (() => {
        let q = db
          .from('agent_link_exchange')
          .select('id, topic, state, started_by_user_id, created_at, closed_at')
          .eq('link_id', link.id)
          .order('created_at', { ascending: false })
          .limit(AGENT_LINK_EXCHANGE_PAGE + 1)
        if (cursor) q = q.lt('created_at', cursor)
        return q
      })(),
    ])
    if (page.error) throw new Error(page.error.message)
    const rows = (page.data ?? []) as ExchangeRow[]
    const hasMore = rows.length > AGENT_LINK_EXCHANGE_PAGE
    const exchanges = rows.slice(0, AGENT_LINK_EXCHANGE_PAGE)

    const byExchange = new Map<string, MessageRow[]>()
    if (exchanges.length) {
      const { data: messages, error: messagesError } = await db
        .from('agent_link_message')
        .select('id, exchange_id, from_user_id, kind, body, created_at')
        .eq('link_id', link.id)
        .in('exchange_id', exchanges.map((e) => e.id))
        .order('created_at', { ascending: true })
      if (messagesError) throw new Error(messagesError.message)
      for (const m of (messages ?? []) as MessageRow[]) {
        const list = byExchange.get(m.exchange_id) ?? []
        list.push(m)
        byExchange.set(m.exchange_id, list)
      }
    }

    const side = (userId: string): 'me' | 'them' => (userId === user.id ? 'me' : 'them')
    const views: ExchangeView[] = exchanges.map((e) => ({
      id: e.id,
      topic: e.topic,
      state: oneOf<AgentLinkExchangeState>(AGENT_LINK_EXCHANGE_STATES, e.state, 'done'),
      startedBy: side(e.started_by_user_id),
      messages: (byExchange.get(e.id) ?? []).map((m) => ({
        id: m.id,
        from: side(m.from_user_id),
        kind: oneOf<AgentLinkMessageKind>(AGENT_LINK_MESSAGE_KINDS, m.kind, 'note'),
        body: m.body,
        at: m.created_at,
      })),
      createdAt: e.created_at,
      closedAt: e.closed_at,
    }))

    const view: ExchangesLinkView = {
      id: link.id,
      state: link.state,
      peerName: half.data?.display_name?.trim() || 'Them',
      workspaceName: workspace.data?.name?.trim() || null,
      myHalfGuestId,
    }
    return NextResponse.json({ link: view, exchanges: views, hasMore })
  } catch (err) {
    console.error('[agent-links] exchanges read failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read the conversation')
  }
}
