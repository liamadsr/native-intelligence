'use client'

/**
 * Teams as a card: the real TeamsView, the teams or one team's settings and
 * members. Opening a team moves the card. A team's board opens over it, inside
 * the card; each is a step the card header's Back and Forward walk.
 */
import * as React from 'react'
import { TeamsView } from '@/app/account/(dashboard)/views/teams-view'
import { TeamActionsView } from '@/app/account/(dashboard)/views/team-actions-view'
import { useTeams } from '@/app/account/teams-context'
import { CardSurfaceContext } from '@/components/views/unified-view-layout'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'
import { useCardNav } from '../card-history'
import { CardOverlay, CardCovered } from '../card-covered'

export default function TeamsCard(props: PageCardProps) {
  const surface = usePageCardSurface(props)
  // The board over the Teams page is not the page the card shows: its list is quiet.
  const quiet = usePageCardSurface(props, { quiet: true })
  const place = usePagePlace(props)
  const { teams } = useTeams()
  const { value: board, set: setBoard } = useCardNav<{ id: string; name: string } | null>('team_board', () => null)
  // Where the card opened: TeamsView reads it once, then owns the selection.
  // Back or Forward to another team opens it there again (a new TeamsView).
  const teamId = place.at?.type === 'team' ? place.at.id : null
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per restore
  const initialTeamId = React.useMemo(() => teamId, [place.restored])
  return (
    <PageCardSurface surface={surface}>
      <div className="relative h-full min-h-0">
        <CardCovered covered={!!board}>
        <TeamsView
          key={place.restored}
          initialTeamId={initialTeamId}
          onTeamChange={(id) => place.go(id ? { type: 'team', id, label: teams.find((t) => t.id === id)?.name } : null)}
          onOpenTeamBoard={(id, name) => setBoard({ id, name })}
        />
        </CardCovered>
        {board && (
          <CardOverlay>
            <div className="min-h-0 flex-1">
              <CardSurfaceContext.Provider value={quiet}>
                <TeamActionsView key={board.id} teamId={board.id} teamName={board.name} />
              </CardSurfaceContext.Provider>
            </div>
          </CardOverlay>
        )}
      </div>
    </PageCardSurface>
  )
}
