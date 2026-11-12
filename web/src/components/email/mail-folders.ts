/**
 * Mail's folders, in our words and with our icons, and the count each one's
 * badge shows: the one list the Mail page's folder Select (email-layout.tsx)
 * and its sub-nav beside the rail (page-panel/mail-panel.tsx; Liam, 11-11:
 * "see and select all the accounts … the inbox, faves, sent … and any tags
 * that are available for email") both draw.
 *
 * The Inbox's count is its UNREAD threads (`countUnit`), not all of them: a
 * mail card's header counts every thread its list holds, so the badge says
 * which number it is.
 *
 * Client-safe and light (icons only), so the panel needn't load the page.
 */
import { Archive, FileEdit, Inbox, MailCheck, Send, ShieldAlert, Star, Trash2, type LucideIcon } from 'lucide-react'

/** The folders' counts, as /api/account/email/counts answers them. */
export interface FolderCounts {
  inbox_unread?: number
  inbox_total?: number
  starred?: number
  sent?: number
  drafts?: number
  spam?: number
  trash?: number
  needs_reply?: number
  /** Threads held beside a reply draft, waiting for the person (src/lib/email/hold.ts). */
  review?: number
}

export interface MailFolderEntry {
  id: string
  label: string
  icon: LucideIcon
  countKey: keyof FolderCounts | null
  countUnit?: string
}

export const MAIL_FOLDER_ENTRIES: readonly MailFolderEntry[] = [
  { id: 'inbox', label: 'Inbox', icon: Inbox, countKey: 'inbox_unread', countUnit: 'unread' },
  { id: 'review', label: 'To review', icon: MailCheck, countKey: 'review' },
  { id: 'starred', label: 'Starred', icon: Star, countKey: 'starred' },
  { id: 'sent', label: 'Sent', icon: Send, countKey: null },
  { id: 'drafts', label: 'Drafts', icon: FileEdit, countKey: 'drafts' },
  { id: 'archive', label: 'Archive', icon: Archive, countKey: null },
  { id: 'spam', label: 'Spam', icon: ShieldAlert, countKey: null },
  { id: 'trash', label: 'Trash', icon: Trash2, countKey: null },
]
