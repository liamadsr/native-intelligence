'use client'

/**
 * Teams inside the My Actions page's card (Liam, 11-11: "Teams should be
 * under action items"; "yes thats what I meant for teams"): the two places
 * the Tasks sub-nav's Teams section opens (lib/chat-cards/tasks-places.ts),
 * drawn over the card's list by card-body.tsx TasksCardBody.
 *
 *   teams        All teams: the real TeamsView (the list, a team's settings
 *                and members, making a team), as the Teams page's card draws it
 *   team:<id>    that team's board: the real TeamActionsView, as a team
 *                board's card draws it
 *
 * A board opened from All teams, another team picked in a board's switcher,
 * and a board's "View all teams" are each a step in the card's history
 * (`go`), so Back walks them and the card in front never changes (My Actions
 * stays selected and lit). An action opened on a board opens inside the card,
 * over it, as a row of the list does (`openAction`).
 *
 * Every list inside is a quiet card list: its changes kept with the card by
 * team (`lists`), never the real page's saved views, and never reported as
 * what the card shows (that is My Actions' own list).
 *
 * Loaded the first time one of these places opens: a Tasks card never on
 * one never pays for the Teams page.
 */
import * as React from 'react'
import { TeamsView } from '@/app/account/(dashboard)/views/teams-view'
import { TeamActionsView } from '@/app/account/(dashboard)/views/team-actions-view'
import { useTeams } from '@/app/account/teams-context'
import { CardSurfaceContext, type CardLayoutOptions, type CardSurface } from '@/components/views/unified-view-layout'
import type { ViewConfig } from '@/components/views/hooks/use-view'
import { ALL_TEAMS_PLACE, teamOfPlace, teamPlace, type TasksPlace } from '@/lib/chat-cards/tasks-places'
import type { ChatCardStore } from '../card-store'

export interface TasksTeamsPlaceProps {
  /** All teams, or one team's board. */
  place: TasksPlace
  toolCallId: string
  store: ChatCardStore
  fullScreen: boolean
  /** To another place inside the card: a step in its history. */
  go: (place: TasksPlace) => void
  /** An action opened on a board: inside the card, over it. */
  openAction: (id: string, title: string) => void
  /** The action open over the board, if any. */
  selectedActionId: string | null
  /** A record is open over the board. */
  obscured: boolean
}

/** Every list under it a quiet card list, kept with the card by its key (as page-card.tsx usePageCardSurface's quiet one). */
function useQuietSurface(toolCallId: string, store: ChatCardStore, fullScreen: boolean): CardSurface {
  return React.useMemo(() => {
    const cache = new Map<string, CardLayoutOptions>()
    return {
      listOptions(_entityType, key) {
        const hit = cache.get(key)
        if (hit) return hit
        const kept = store.state(toolCallId)
        const options: CardLayoutOptions = {
          baseline: {},
          overrides: kept.lists?.[key] as Partial<ViewConfig> | undefined,
          compact: !fullScreen,
          onOverridesChange: (overrides) => {
            const lists = { ...(store.state(toolCallId).lists ?? {}), [key]: overrides as Record<string, unknown> }
            store.update(toolCallId, { lists }, { touch: true })
          },
          view: kept.views?.[key],
          onViewChange: (view) => store.update(toolCallId, { views: { ...store.state(toolCallId).views, [key]: view } }, { touch: true }),
        }
        cache.set(key, options)
        return options
      },
    }
  }, [toolCallId, store, fullScreen])
}

export default function TasksTeamsPlace({ place, toolCallId, store, fullScreen, go, openAction, selectedActionId, obscured }: TasksTeamsPlaceProps) {
  const surface = useQuietSurface(toolCallId, store, fullScreen)
  // The names the sub-nav lists (teams-context.tsx: read once, kept live by team events).
  const { teams } = useTeams()
  const teamId = teamOfPlace(place)
  return (
    <CardSurfaceContext.Provider value={surface}>
      {teamId ? (
        <TeamActionsView
          key={teamId}
          teamId={teamId}
          teamName={teams.find((t) => t.id === teamId)?.name ?? 'Team'}
          obscured={obscured}
          selectedActionId={selectedActionId}
          onSelectAction={(id, title) => openAction(id, title)}
          onSelectTeam={(id) => go(teamPlace(id))}
          onViewAllTeams={() => go(ALL_TEAMS_PLACE)}
        />
      ) : (
        <TeamsView onOpenTeamBoard={(id) => go(teamPlace(id))} />
      )}
    </CardSurfaceContext.Provider>
  )
}
