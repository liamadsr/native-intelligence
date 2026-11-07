'use client'

/**
 * A bot's page as a card (the `bot` page kind, phase P5): the real
 * TeammateChatPage, its chat on the left and its work on the right, opened
 * full screen from the Library (Agents & skills), a work item or a notice. Only the person
 * opens one (show doesn't offer it).
 *
 * One of the teammate's items open on the page is where the card is (`at`, a
 * work item), kept with the card like any page card's place, so Back and a
 * reload return to it; going back to the lists clears it. Another teammate
 * picked in the switcher opens its own page, as a card of its own.
 */
import * as React from 'react'
import { TeammateChatPage } from '@/components/bots/teammate-chat-page'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { openBotPage } from '@/lib/bots/bot-page'
import { PageCardNotice, usePagePlace, type PageCardProps } from './page-card'

export default function BotCard(props: PageCardProps) {
  const { spec } = props
  const place = usePagePlace(props)
  const { work } = useAgentWorkShared()
  const teammateId = spec.target?.type === 'bot' ? spec.target.id : null
  const mate = teammateId ? work.roster.find((t) => t.id === teammateId) ?? null : null
  const item = place.at?.type === 'work_item' ? place.at : null

  const { go } = place
  const onOpenItem = React.useCallback(
    (next: { itemId: string; title: string } | null) => {
      go(next ? { type: 'work_item', id: next.itemId, label: next.title } : null)
    },
    [go],
  )
  const onSwitchTeammate = React.useCallback((id: string, focus: 'work' | 'chat') => {
    openBotPage(id, { focus })
  }, [])

  if (!teammateId) return <PageCardNotice text="This agent’s page can’t open." />
  return (
    <div className="h-full min-h-0">
      <TeammateChatPage
        teammateId={teammateId}
        name={mate?.name?.trim() || spec.target?.label || spec.title}
        workspaceId={mate?.workspace_id ?? null}
        itemId={item?.id}
        itemTitle={item?.label}
        // A mounted card is drawn: it unmounts when it folds to its pill.
        drawn
        onOpenItem={onOpenItem}
        onSwitchTeammate={onSwitchTeammate}
      />
    </div>
  )
}
