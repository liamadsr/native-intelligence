'use client'

/**
 * A bot's page, its work column (docs/plans/bots-v4.md, "A bot's page"): For
 * you, Working on, Done lately, Notices (its notices, which live with the bot:
 * Phase 4c, notices.tsx) and About, from the page's own read of its
 * teammate (useBotWork, GET /api/account/agent-work?teammate=, kept live off
 * the shell's channel) and the shell's shared source (its counts, cards, Stop
 * and Resume). Its rows are your own, as on the Agents page (`tracked_job`
 * SELECT is owner-only), and all in its workspace.
 *
 * Its trees are the Agents page's lanes narrowed to it (partitionForOwner):
 * Working on its running ones, Done lately its settled ones. For you is its
 * bubble's list (new, then seen), not the trees' waiting rows: cards are in
 * it, and a handoff reviewed with its root isn't.
 *
 * An area face (Captures, Mail, Prospecting, Evals, CRM; one-agent plan S3)
 * adds "What I've learned": what Native Intelligence has learned about you in its area
 * (S2's WhatDial8Learned, `area`), editable there. There is no Conversations
 * card: the main chat is one conversation with the main agent
 * (docs/plans/one-chat.md, Slice 2).
 *
 * Each section is a card of its own (bot-page-card.tsx), stacked with gaps
 * and inset from the column's edges, so they float on the page; the column
 * (the page's right one) scrolls as a whole. Its loading state is the same
 * stack, as blank cards.
 */
import { useCallback, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import type { BotWork as BotWorkData } from '@/hooks/use-bot-work'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { BubbleItem } from '@/lib/bots/bubble-items'
import { partitionForOwner, teammateKey } from '@/lib/work/agent-work-lanes'
import { kindLabel } from '@/lib/work/presentation'
import type { Notification } from '@/app/account/notification-context'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import { About } from './about'
import { DoneLately } from './done-lately'
import { ForYou } from './for-you'
import { Notices } from './notices'
import { useBotPageOpen } from './use-bot-page-open'
import { WorkingOn } from './working-on'
import { AgentLearned, Learned } from './learned'
import { isAgentTeammate } from '@/lib/bots/agent-face'
import { areaOfTeammate } from '@/lib/bots/area-faces'

/**
 * The cards' stack: gaps between them, inset from the column's edges. The
 * column scrolls, so it clips: the inset is the gutter the cards' soft shadow
 * (hud-surface-shadow, tuned for ~16 px at the sides) fades out in, deeper
 * below, where the shadow pools.
 */
const STACK = 'flex flex-col gap-3 px-4 pb-6 pt-2'

export function BotWork({
  teammateId,
  name,
  mate,
  work,
  aiLimit,
  onRefine,
}: {
  teammateId: string
  name: string
  /** Its roster entry from the shell's source, until the page's read holds the one with its breaker. */
  mate: RosterTeammate | null
  work: BotWorkData
  aiLimit: boolean
  /** "Refine in chat" on one of its cards: the page's chat with this bot. */
  onRefine?: (card: AttentionItem, item: BubbleItem | null) => void
}) {
  const { work: shared } = useAgentWorkShared()
  const open = useBotPageOpen(teammateId)
  const rows = work.rows
  const sections = useMemo(() => (rows ? partitionForOwner(rows, new Set([teammateKey(teammateId)])) : null), [rows, teammateId])
  // A run parked on a question asks in the chat (P13), never in For you: it
  // stays on this page under Working on, as "Needs your answer", opening its run's chat.
  const working = useMemo(
    () => (sections ? [...sections.needsYou.filter((t) => t.item.status === 'needs_input'), ...sections.running] : []),
    [sections],
  )
  const teammate = work.teammate ?? mate
  const area = areaOfTeammate(teammate)
  const refresh = work.refresh
  // A notice opens its run's item on this page (Phase 2), titled as the page holds it.
  const openNotice = useCallback(
    (notice: Notification, workItemId: string) => {
      const row = rows?.find((r) => r.id === workItemId)
      const kind = typeof notice.metadata?.kind === 'string' ? notice.metadata.kind : null
      open.item(workItemId, notice.workspace_id, row?.title || (kind ? kindLabel(kind) : 'Work item'), teammateId)
    },
    [rows, open, teammateId],
  )
  const resume = useCallback(
    async (workspaceId: string, role: string) => {
      const ok = await shared.resumeRole(workspaceId, role)
      // Its breaker is the page's read's: read again so "Attempts paused" clears.
      if (ok) await refresh()
      return ok
    },
    [shared, refresh],
  )

  if (!rows || !sections) {
    if (work.failed) {
      return (
        <div role="alert" data-bot-page-failed="" className="flex flex-col items-center gap-2 px-4 py-16 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <p className="text-sm text-muted-foreground">Couldn’t load what {name} is doing.</p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      )
    }
    return (
      <div data-bot-page-loading="" className={STACK}>
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    )
  }

  return (
    <div data-bot-page-cards="" className={STACK}>
      <ForYou teammateId={teammateId} name={name} rows={rows} chips={work.chips} open={open} onRefine={onRefine} />
      <WorkingOn name={name} trees={working} chips={work.chips} open={open} onStop={shared.stop} stopping={shared.stopping} />
      <DoneLately name={name} trees={sections.recent} chips={work.chips} open={open} />
      <Notices teammateId={teammateId} name={name} reachable={teammate?.reachable === true} onOpen={openNotice} />
      {teammate && <About teammate={teammate} about={work.about} mayResume={work.mayResume} onResume={resume} aiLimit={aiLimit} />}
      {area && <Learned area={area} name={name} workspaceId={teammate?.workspace_id ?? null} />}
      {/* The agent's page (one face): what it has learned, area by area. */}
      {isAgentTeammate(teammate) && <AgentLearned name={name} workspaceId={teammate?.workspace_id ?? null} />}
    </div>
  )
}
