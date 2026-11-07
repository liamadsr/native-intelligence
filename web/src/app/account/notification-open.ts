/**
 * What a notification click opens: a card in the chat (every way in opens a
 * card, lib/chat-cards/open-card.ts).
 *
 * `resolveNotificationDetailPanel` (notification-panel.ts) says what a
 * notification is about; this turns that into the card it opens. Every click
 * surface (the desktop's native banner, the work item panel's links) goes
 * through `openNotificationTarget`, so they can never drift on where a click
 * lands.
 *
 * Cross-workspace rule: a target in another workspace opens there. The card
 * request carries the workspace, and the tabs provider switches to it first
 * and puts the card in that workspace's chat, never against this one's data.
 */
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import type { NotificationTarget } from './notification-panel'

/** The card a notification's target opens, or null for one nothing draws. */
export function notificationCardTarget(target: NotificationTarget): OpenTarget | null {
  switch (target.type) {
    case 'flow':
      return { type: 'flow', id: target.id, title: target.title, runId: target.runId ?? null }
    case 'mail':
      return { type: 'mail', folder: target.id, title: target.title }
    case 'sequence':
      return { type: 'sequence', id: target.id, title: target.title }
    case 'work_item':
      return { type: 'work_item', id: target.id, title: target.title }
    case 'team_board':
      return { type: 'team_board', id: target.id, title: target.title }
    case 'action':
    case 'capture':
    case 'document':
    case 'project':
    case 'initiative':
    case 'contact':
    case 'company':
      return { type: target.type, id: target.id, title: target.title }
    default:
      return null
  }
}

/**
 * Open what a notification is about, as a card. `foreignWorkspaceId`: the
 * notification's workspace when it is NOT the one on screen (null otherwise).
 * False when the target is nothing a card draws.
 */
export function openNotificationTarget(target: NotificationTarget, opts: { foreignWorkspaceId: string | null }): boolean {
  const card = notificationCardTarget(target)
  if (!card) return false
  return openTarget(card, { from: 'notification', workspaceId: opts.foreignWorkspaceId })
}
