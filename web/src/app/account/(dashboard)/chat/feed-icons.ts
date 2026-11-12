/**
 * A record's kind as a glyph: the one mapping the palette's rows
 * (command-menu.tsx) and the page panel's recents (page-panel/home-recents.tsx)
 * both draw, so a doc or a deal looks the same wherever it is listed.
 *
 * A plain module (no React): the panel takes the glyphs without pulling the
 * palette in.
 */
import {
  AudioLines,
  Boxes,
  Building2,
  CalendarDays,
  CircleCheck,
  FileText,
  FolderKanban,
  Handshake,
  Hash,
  Paperclip,
  Target,
  User,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { FeedEntry } from '@/lib/entities/feed-model'
import type { MenuSearchRow } from '@/lib/search/menu-search'

/** The record kinds drawn as a plain glyph on a tile. */
export const RECORD_ICONS: Partial<Record<MenuSearchRow['kind'], LucideIcon>> = {
  action: CircleCheck,
  document: FileText,
  project: FolderKanban,
  initiative: Target,
  capture: AudioLines,
  deal: Handshake,
  flow: Workflow,
  attachment: Paperclip,
  calendar_event: CalendarDays,
  agent: Boxes,
  team_chat_message: Hash,
}

/** A feed row's kind, as a glyph on a tile. */
export const FEED_ICONS: Partial<Record<FeedEntry['type'], LucideIcon>> = {
  ...RECORD_ICONS,
  contact: User,
  company: Building2,
  team_chat_message: Hash,
}

/** A kind with no glyph of its own. */
export const FALLBACK_FEED_ICON: LucideIcon = Building2
