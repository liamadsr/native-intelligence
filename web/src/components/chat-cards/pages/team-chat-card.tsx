'use client'

/**
 * Team chat as a card (roadmap #7): the real TeamChatView, with its own
 * fetches and live updates. Nothing of the person's is kept with the card.
 */
import * as React from 'react'
import { TeamChatView } from '@/app/account/(dashboard)/views/team-chat-view'
import type { PageCardProps } from './page-card'

export default function TeamChatCard({ onCount, fullScreen }: PageCardProps) {
  return (
    <div className="h-full min-h-0">
      <TeamChatView onCount={onCount} compact={!fullScreen} />
    </div>
  )
}
