'use client'

/**
 * Team chat as a card (roadmap #7): the real TeamChatView, with its own
 * fetches and live updates. Nothing of the person's is kept with the card
 * but where it opened (`at`, migration 560): a channel, or one message (a
 * notification or a search hit), which the view opens in its channel or its
 * thread, scrolled to it. Opening it again elsewhere moves it there.
 */
import * as React from 'react'
import { TeamChatView, type TeamChatFocus } from '@/app/account/(dashboard)/views/team-chat-view'
import { usePagePlace, type PageCardProps } from './page-card'

export default function TeamChatCard(props: PageCardProps) {
  const { onCount, fullScreen } = props
  const { at } = usePagePlace(props)
  // The view acts on its type and id only (a fresh object each render moves nothing).
  const focus: TeamChatFocus | null =
    at?.type === 'team_chat_message' ? { type: 'message', id: at.id } : at?.type === 'team_chat_channel' ? { type: 'channel', id: at.id } : null
  return (
    <div className="h-full min-h-0">
      <TeamChatView onCount={onCount} compact={!fullScreen} focus={focus} />
    </div>
  )
}
