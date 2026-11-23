'use client'

/**
 * The team chat composer's + menu Create group (docs/plans/channels-inbox.md,
 * phases 3 and 4): what a conversation can make, each through the app's own
 * way of making it.
 *
 *   (New poll and New form are the box's own dialogs, added by the
 *   composer: team-chat-poll-dialog.tsx, team-chat-form-dialog.tsx.)
 *   New task   the action composer (openTaskComposer), its title from the
 *              conversation's latest message (a thread's: its root), linked
 *              back to that message on create (`about`).
 *   New doc    the Create dialog's doc composer.
 *   Start a call  the header's call (useTeamCalls().startCall): offered
 *              where calls are, never in a thread's box.
 */
import { useMemo } from 'react'
import { CircleCheck, FileText, Phone } from 'lucide-react'
import type { ComposerCreateItem } from '@/app/account/(dashboard)/chat/chat-input'
import { openCreateDialog, openTaskComposer } from '@/lib/create/open-create'
import { messageTaskLabel, taskTitleFor } from '@/lib/entities/actions'
import type { TeamChatChannel, TeamChatMessage } from '@/lib/team-chat/types'

export interface TeamChatCreateInput {
  channel: Pick<TeamChatChannel, 'id' | 'kind' | 'archived_at'>
  /** How the channel is called ("#launch", "Ana Ruiz"): the call's label. */
  label: string
  /** The message a new task comes from: the conversation's latest, or the thread's root. */
  source: Pick<TeamChatMessage, 'id' | 'body' | 'deleted_at'> | null
  /** In a thread's box: no call from there. */
  inThread: boolean
  calls?: { available: boolean; start: () => void } | null
}

/** The items, in menu order (pure: the hook below memoizes it). */
export function teamChatCreateItems(input: TeamChatCreateInput): ComposerCreateItem[] {
  const items: ComposerCreateItem[] = []
  const source = input.source && !input.source.deleted_at ? input.source : null
  items.push({
    id: 'task',
    label: 'New task from this conversation',
    icon: CircleCheck,
    onSelect: () =>
      source
        ? openTaskComposer({ type: 'team_chat_message', id: source.id, title: taskTitleFor(messageTaskLabel(source.body)) })
        : openCreateDialog({ type: 'action' }),
  })
  items.push({ id: 'document', label: 'New doc', icon: FileText, onSelect: () => openCreateDialog({ type: 'document' }) })
  if (!input.inThread && input.calls?.available && !input.channel.archived_at) {
    items.push({ id: 'call', label: input.channel.kind === 'dm' ? 'Start a call' : 'Start a call here', icon: Phone, onSelect: input.calls.start })
  }
  return items
}

export function useTeamChatCreateItems(input: TeamChatCreateInput): ComposerCreateItem[] {
  const { channel, label, source, inThread, calls } = input
  return useMemo(
    () => teamChatCreateItems({ channel, label, source, inThread, calls }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel.id, channel.kind, channel.archived_at, label, source?.id, source?.body, source?.deleted_at, inThread, calls?.available, calls?.start],
  )
}
