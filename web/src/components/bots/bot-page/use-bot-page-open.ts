'use client'

/**
 * Where a click on a bot's page goes (docs/plans/bots-v4.md, "An item opens on
 * its bot's page", Phase 2):
 *
 *   this bot's item   on this page (BotPageNav, kept with the page's card):
 *                     the item on the work side, its chat beside it, and Back
 *                     to the lists.
 *   another bot's     on that bot's page (a handoff it did, or the run this
 *                     bot's handoff was part of), where any item opens
 *                     (useOpenWorkItem), and its tooltip says so when the
 *                     roster holds that bot. One behind a private team you're
 *                     not on, or since deleted, opens on a card of its own,
 *                     like an item no bot owns.
 *   a card            its run's item, by the same rules.
 *   a record's chip   that record, as a card in the chat, in its row's
 *                     workspace (switched to when it isn't the one on screen).
 */
import { useMemo, useRef } from 'react'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { chipTarget } from '@/components/work/work-rows'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { openTarget } from '@/lib/chat-cards/open-card'
import { kindLabel } from '@/lib/work/presentation'
import type { EntityChip } from '@/lib/work/touch-summary'
import type { WorkItem } from '@/lib/work/types'
import { useBotPageNav } from './bot-page-nav'

type PageRow = Pick<WorkItem, 'id' | 'workspace_id' | 'kind' | 'ai_team_member_id' | 'teammate'> & { title?: string | null }

export interface BotPageOpen {
  /**
   * A work item (a card's run): on this page when it's this bot's
   * (`teammateId`, when known), else where any item opens. Its workspace and
   * title as the caller has them.
   */
  item: (workItemId: string, workspaceId: string, title: string, teammateId?: string | null) => void
  /** A row: this bot's on this page; another bot's on that bot's page; one no bot owns, on a card of its own. */
  row: (row: PageRow) => void
  /** The other bot a row opens on, by name (its tooltip); null when it opens on this page or on a card of its own. */
  pageOf: (row: PageRow) => string | null
  /** A touched record's chip, as a card, in its row's workspace. */
  entity: (row: Pick<WorkItem, 'workspace_id'>, chip: EntityChip) => void
}

export function useBotPageOpen(teammateId: string): BotPageOpen {
  const { work } = useAgentWorkShared()
  const openWorkItem = useOpenWorkItem()
  const nav = useBotPageNav()
  const roster = work.roster
  const latest = useRef({ openWorkItem, nav })
  latest.current = { openWorkItem, nav }
  return useMemo(() => {
    const item = (workItemId: string, workspaceId: string, title: string, owner?: string | null) => {
      const pageNav = latest.current.nav
      if (owner === teammateId && pageNav) {
        pageNav.openItem({ itemId: workItemId, title })
        return
      }
      // Whose it is, when known (a card's run whose row isn't held is asked
      // about first); one that can't be placed at all opens this bot's page.
      latest.current.openWorkItem(workItemId, owner === undefined ? [teammateId] : [], {
        workspaceId,
        title,
        ...(owner !== undefined ? { teammateId: owner } : {}),
      })
    }
    /** Another bot the row belongs to, when the roster holds it (its page can open). */
    const otherBot = (row: PageRow) => {
      const id = row.ai_team_member_id
      if (!id || id === teammateId) return null
      return roster.find((t) => t.id === id) ?? null
    }
    return {
      item,
      row: (row) => item(row.id, row.workspace_id, row.title || kindLabel(row.kind), row.ai_team_member_id ?? null),
      pageOf: (row) => {
        const other = otherBot(row)
        return other ? other.name?.trim() || row.teammate?.name?.trim() || 'Teammate' : null
      },
      entity: (row, chip) => void openTarget(chipTarget(chip), { from: 'bot-page', workspaceId: row.workspace_id }),
    }
  }, [teammateId, roster])
}
