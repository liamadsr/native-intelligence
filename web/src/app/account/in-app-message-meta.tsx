'use client'

import { Megaphone, Lightbulb, MessageSquareHeart, type LucideIcon } from 'lucide-react'

/** Presentation for each admin message type. The app's house style is
 *  near-monochrome, so the TYPE is conveyed by the icon + label, not color —
 *  every type uses the same muted chip. */
const MESSAGE_TYPE_META: Record<string, { label: string; icon: LucideIcon }> = {
  announcement: { label: 'Announcement', icon: Megaphone },
  tip: { label: 'Tip', icon: Lightbulb },
  feedback_prompt: { label: 'Feedback request', icon: MessageSquareHeart },
}

export function messageMeta(type: string) {
  return MESSAGE_TYPE_META[type] ?? MESSAGE_TYPE_META.announcement
}

/** Shared neutral chrome so the toast + popup icon chip and label read the
 *  same as the rest of the app (muted, low-contrast). */
export const MESSAGE_ICON_CHIP =
  'flex items-center justify-center rounded-full bg-muted text-muted-foreground'
export const MESSAGE_LABEL =
  'text-[10px] font-medium uppercase tracking-wide text-muted-foreground'
