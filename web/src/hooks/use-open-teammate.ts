'use client'

/**
 * `openTeammate` wired to the shell (src/lib/bots/open-teammate.ts): the
 * shared source (AgentWorkProvider) for what is new, the cards in the chat
 * and the workspace on screen for where it goes, and the bot's page
 * (src/lib/bots/bot-page.ts, showing its work) for `page`, `talk` (there's
 * no bubble any more: talking to it happens on its page) and an `open` with
 * nothing new. `useOpenWorkItem` is the one
 * way any work item opens (bots-v4.md "An item opens on its bot's page",
 * Phase 2): on its teammate's bot's page (lib/bots/bot-page.ts
 * openBotPageItem), else its panel on a card of its own, in its own workspace. What
 * the shared source doesn't hold is looked up first (lib/bots/item-lookup.ts).
 *
 * `OpenTeammateDevBridge` (development only, mounted in the dashboard shell)
 * puts the same call on `window.__dial8OpenTeammate(teammateIds, intent)`, so
 * a click can be tried from the console.
 */
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { openBotPage, openBotPageItem } from '@/lib/bots/bot-page'
import { lookupWorkItem } from '@/lib/bots/item-lookup'
import {
  openItem,
  openTeammate,
  type KnownRow,
  type OpenTeammateNav,
  type OpenTeammateOutcome,
  type OpenTeammateSource,
  type TeammateIntent,
} from '@/lib/bots/open-teammate'

/** The shared source and the workspace on screen as they are at click time. */
function useLatest(): () => { source: OpenTeammateSource; nav: Omit<OpenTeammateNav, 'talk'> } {
  const { work, attention, counts } = useAgentWorkShared()
  const { currentId } = useWorkspaces()
  // Read at click time, so the callbacks' identity doesn't follow every ledger push.
  const latest = useRef({ work, attention, counts, currentId })
  latest.current = { work, attention, counts, currentId }
  return useCallback(() => {
    const s = latest.current
    return {
      source: { rows: s.work.rows ?? [], cardRows: s.work.cardRows, cards: s.attention.items, counts: s.counts, roster: s.work.roster },
      nav: {
        currentWorkspaceId: s.currentId,
        open: (target, workspaceId) => void openTarget(target, { from: 'bot', workspaceId }),
        // Its work, in a narrow window: what opening a bot's page asks for.
        openPage: (teammateId: string) => openBotPage(teammateId, { focus: 'work' }),
        // An item, on its bot's page; and who an item nothing here holds is.
        openItemPage: openBotPageItem,
        lookup: lookupWorkItem,
        // A bot whose page can't open (deleted, or behind a private team) and nothing else to show.
        botNotFound: () => toast('Couldn’t find that agent'),
      },
    }
  }, [])
}

export function useOpenTeammate(): (teammateIds: readonly string[], intent?: TeammateIntent) => OpenTeammateOutcome {
  const latest = useLatest()
  return useCallback(
    (teammateIds: readonly string[], intent: TeammateIntent = 'open') => {
      const { source, nav } = latest()
      return openTeammate(teammateIds, intent, source, {
        ...nav,
        // Talking to it is on its page (its work, as opening its page asks).
        talk: ({ teammateId }) => {
          if (teammateId) openBotPage(teammateId, { focus: 'work' })
        },
      })
    },
    [latest],
  )
}

/**
 * Any work item, from anywhere (open-teammate.ts openItem): on its teammate's
 * bot's page, else on a card of its own. `teammateIds`: the bot it was asked of,
 * whose page opens when the item can't be placed at all (the bubble's Open on
 * a card whose run isn't known); none from a surface that isn't a bot's.
 * `known`: what the caller holds of a row the shared source may not (a settled
 * one), its teammate included when it knows it.
 */
export function useOpenWorkItem(
  /** Where an item with no bot's page to open on goes, instead of a new card (a surface that shows it in place). */
  openHere?: (target: OpenTarget, workspaceId: string | null) => void,
): (itemId: string, teammateIds: readonly string[], known?: KnownRow | null) => OpenTeammateOutcome {
  const latest = useLatest()
  const here = useRef(openHere)
  here.current = openHere
  return useCallback(
    (itemId: string, teammateIds: readonly string[], known?: KnownRow | null) => {
      const { source, nav } = latest()
      const open = here.current
      return openItem(itemId, teammateIds, source, open ? { ...nav, open } : nav, known)
    },
    [latest],
  )
}

type DevWindow = Window & { __dial8OpenTeammate?: (teammateIds: string[], intent?: TeammateIntent) => OpenTeammateOutcome }

/** Development only: `window.__dial8OpenTeammate(['<ai_team_member id>', …], 'talk' | 'open' | 'page')`. */
export function OpenTeammateDevBridge() {
  const open = useOpenTeammate()
  useEffect(() => {
    const w = window as DevWindow
    w.__dial8OpenTeammate = (teammateIds, intent) => open(teammateIds, intent)
    return () => {
      if (w.__dial8OpenTeammate) delete w.__dial8OpenTeammate
    }
  }, [open])
  return null
}
