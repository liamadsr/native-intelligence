/**
 * The app rail's icons (./app-rail.tsx), and its page groups' member pages'
 * (../page-panel/page-group-panel.tsx, the group's sub-nav rows): the rail's
 * own for Liam's reference pages, the `/` menu's for the rest
 * (chat/command-menu.tsx).
 *
 * Liam, 11-11: Contacts: Companies, Contacts, Deals · Outreach: Prospecting,
 * Sequences, Campaigns · Calendar: Captures (./page-groups.ts). A group wears
 * its namesake member's icon (Contacts, Calendar); Outreach wears Send, so
 * Sequences (Send in the `/` menu) wears ListOrdered in the sub-nav, the
 * steps of a sequence, two rows never sharing the group's glyph by accident.
 *
 * Liam, 11-13: the Studio joins Outreach (no rail icon of its own); its
 * Clapperboard is its row's in Outreach's sub-nav.
 *
 * Liam, 11-11: Drive (Docs, Knowledge, Files, Tables) wears HardDrive, its members
 * the icons they had; Agents (Agents & skills, Flows, Evals) keeps Agents &
 * skills' Sparkles, its namesake member's.
 */
import {
  AudioLines,
  Bot,
  Brain,
  Building2,
  Calendar,
  CalendarClock,
  Clapperboard,
  Contact,
  FlaskConical,
  Folder,
  HandCoins,
  HardDrive,
  KeyRound,
  Link2,
  ListChecks,
  ListOrdered,
  Mail,
  MapPin,
  Megaphone,
  MessagesSquare,
  MousePointerClick,
  Paperclip,
  ScanSearch,
  SearchCheck,
  Send,
  Sparkles,
  Swords,
  Table2,
  Telescope,
  TrendingUp,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { RailPageId } from './rail-pages'

/** Each rail item's icon: a page's, or a group's. */
export const RAIL_ICONS: Readonly<Record<RailPageId, LucideIcon>> = {
  drive: HardDrive,
  mail: Mail,
  'team-chat': MessagesSquare,
  actions: ListChecks,
  calendar: Calendar,
  contacts: Contact,
  outreach: Send,
  seo: SearchCheck,
  agents: Sparkles,
  teams: Users,
}

/** Each group member page's icon, in its group's sub-nav. */
export const GROUP_PAGE_ICONS: Readonly<Record<string, LucideIcon>> = {
  calendar: Calendar,
  // Liam, 11-11: Availability, its own page under Calendar.
  availability: CalendarClock,
  captures: AudioLines,
  companies: Building2,
  contacts: Contact,
  deals: HandCoins,
  prospecting: Telescope,
  sequences: ListOrdered,
  campaigns: Megaphone,
  // Studio (migration 620): videos and ads, Outreach's last member (Liam, 11-13).
  studio: Clapperboard,
  // SEO: Site audit (the group wears SearchCheck; the audit, a page scanned).
  'seo-audit': ScanSearch,
  'seo-keywords': KeyRound,
  'seo-rankings': TrendingUp,
  'seo-search': MousePointerClick,
  'seo-competitors': Swords,
  'seo-backlinks': Link2,
  'seo-ai-visibility': Bot,
  'seo-local': MapPin,
  // Drive and Agents (Liam, 11-11).
  docs: Folder,
  knowledge: Brain,
  files: Paperclip,
  tables: Table2,
  agents: Sparkles,
  flows: Workflow,
  evals: FlaskConical,
}
