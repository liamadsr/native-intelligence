'use client'

/**
 * Icons for the integration catalog — the CLIENT half of `catalog.ts`.
 *
 * Split out so `catalog.ts` stays plain data and can be imported by the server
 * component that renders the integration detail route (it needs name and
 * description only, and must not pull React components into its graph).
 *
 * Two layers, same as the four hand-written maps this replaces:
 *   - `INTEGRATION_BRAND_ICONS` — the official mark, when one exists.
 *   - `CAPABILITY_ICONS` — the lucide fallback, chosen by CAPABILITY (not by
 *     provider), tinted with the entry's `iconColor` from the catalog.
 *
 * Every pair in the catalog has a brand mark today; the fallback is what a pair
 * would render if a mark were ever unavailable.
 */

import { BarChart3, Calendar, Mail, GitBranch, Building2, CheckSquare, Contact, MessageSquare, MessageSquareText, Monitor, Plug, SearchCheck } from 'lucide-react'
import {
  GitHubIcon,
  GoogleCalendarIcon,
  GmailIcon,
  OutlookIcon,
  OutlookCalendarIcon,
  HubSpotIcon,
  AsanaIcon,
  JiraIcon,
  LinearIcon,
  SlackIcon,
} from '@/components/brand-icons'
import { integrationKey } from './catalog'

export type BrandIconComponent = (props: { className?: string }) => React.ReactNode

/** Lucide fallback per capability. */
export const CAPABILITY_ICONS: Record<string, typeof Calendar> = {
  calendar: Calendar,
  email: Mail,
  github: GitBranch,
  crm: Building2,
  contacts: Contact,
  // The SEO area's Google sources (no brand mark: the lucide fallback).
  search_console: SearchCheck,
  analytics: BarChart3,
  tasks: CheckSquare,
  messaging: MessageSquare,
  // A connected app with no brand mark (a custom MCP server, Typefully today):
  // the connector plug MCP servers use, not the calendar fallback.
  mcp: Plug,
}

/** Official brand marks, keyed by `${provider}:${capability}`. */
export const INTEGRATION_BRAND_ICONS: Record<string, BrandIconComponent> = {
  'google:calendar': GoogleCalendarIcon,
  'google:email': GmailIcon,
  'microsoft:calendar': OutlookCalendarIcon,
  'microsoft:email': OutlookIcon,
  'github:github': GitHubIcon,
  'hubspot:crm': HubSpotIcon,
  'asana:tasks': AsanaIcon,
  'jira:tasks': JiraIcon,
  'linear:tasks': LinearIcon,
  // Native Intelligence's Slack app (SLACK_APP_ENTRY), not a catalog pair.
  'slack:messaging': SlackIcon,
  // Texting (TEXTING_ENTRY): no brand, the phone page's own icon.
  'sms:messaging': ({ className }) => <MessageSquareText className={className} />,
}

export function getBrandIcon(
  provider: string,
  capability: string,
): BrandIconComponent | undefined {
  return INTEGRATION_BRAND_ICONS[integrationKey(provider, capability)]
}

/**
 * The lucide icon for a capability. `Calendar` is the historical default for an
 * unrecognized capability, preserved from the detail view's `ICONS[...] ??
 * Calendar`.
 */
export function getCapabilityIcon(capability: string): typeof Calendar {
  return CAPABILITY_ICONS[capability] ?? Calendar
}

/** The local-Exchange card/detail icon — no brand mark, desktop-only. */
export const LOCAL_EXCHANGE_ICON = Monitor
