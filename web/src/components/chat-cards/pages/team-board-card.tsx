'use client'

/**
 * A team board as a card: the real TeamActionsView, one team's actions by
 * state. Its list takes the agent's filters as its baseline (the card
 * surface), switching teams moves the card, and an action opens inside the
 * card. The board's links out of itself (team settings, all teams) are left
 * off: those are the Teams page's, which is its own card.
 */
import * as React from 'react'
import { TeamActionsView } from '@/app/account/(dashboard)/views/team-actions-view'
import { PageCardNotice, PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'
import { RecordOverlay, usePageRecords } from './record-overlay'
import { CardCovered } from '../card-covered'

export default function TeamBoardCard(props: PageCardProps) {
  const surface = usePageCardSurface(props)
  const place = usePagePlace(props)
  const records = usePageRecords(props.toolCallId, props.store)
  const team = place.at?.type === 'team' ? place.at : null
  if (!team) return <PageCardNotice text="This board's team is gone." />
  return (
    <PageCardSurface surface={surface}>
      <div className="relative h-full min-h-0">
        <CardCovered covered={!!records.current}>
        <TeamActionsView
          key={team.id}
          teamId={team.id}
          teamName={team.label ?? 'Team'}
          obscured={!!records.current}
          selectedActionId={records.current?.type === 'action' ? records.current.id : null}
          onSelectAction={(id, title) => records.open({ type: 'action', id, label: title })}
          onSelectTeam={(id, name) => place.go({ type: 'team', id, label: name })}
        />
        </CardCovered>
        <RecordOverlay records={records} page={props} />
      </div>
    </PageCardSurface>
  )
}
