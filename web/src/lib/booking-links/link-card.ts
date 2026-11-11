/**
 * What the chat's booking link cards draw (src/app/account/(dashboard)/chat/
 * booking-link-card.tsx), read from the tools' answers
 * (src/lib/ai/tools/booking-links.ts):
 *
 *   create_booking_link   the link made: its title, length, hosts, address
 *   update_booking_link   the link as it is now, on or off
 *   delete_booking_link   the link, turned off
 *   list_booking_links    each link, on or off, with its address
 *
 * Only what the answer already says to the person. Null (the generic chip
 * instead) for a refusal, or a list with nothing in it. Pure.
 */
import { lengthLabel } from '@/lib/time-offers/display'
import { HOST_MODES, type HostMode } from './types'

export interface LinkCardItem {
  id: string
  title: string
  url: string | null
  durationMinutes: number
  hostNames: string[]
  hostMode: HostMode
  active: boolean
  askFirst: boolean
}

export type BookingLinkCardData = { kind: 'link'; verb: 'made' | 'changed' | 'off'; link: LinkCardItem } | { kind: 'links'; links: LinkCardItem[] }

/** The tools that draw a card here. */
export const BOOKING_LINK_CARD_TOOLS = ['create_booking_link', 'update_booking_link', 'delete_booking_link', 'list_booking_links'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function itemOf(v: unknown): LinkCardItem | null {
  if (!isRecord(v)) return null
  const id = str(v.id)
  const title = str(v.title)
  if (!id || !title || typeof v.duration_minutes !== 'number') return null
  return {
    id,
    title,
    url: str(v.url),
    durationMinutes: v.duration_minutes,
    hostNames: Array.isArray(v.host_names) ? v.host_names.filter((n): n is string => typeof n === 'string' && !!n) : [],
    hostMode: (HOST_MODES as readonly unknown[]).includes(v.host_mode) ? (v.host_mode as HostMode) : 'one',
    active: v.active !== false,
    askFirst: v.ask_first === true,
  }
}

/** The card for a tool's answer, or null. */
export function bookingLinkCardOf(toolName: string, output: unknown): BookingLinkCardData | null {
  if (!isRecord(output) || output.success !== true) return null
  if (toolName === 'list_booking_links') {
    const links = Array.isArray(output.links) ? output.links.map(itemOf).filter((l): l is LinkCardItem => !!l) : []
    return links.length ? { kind: 'links', links } : null
  }
  const link = itemOf(output.link)
  if (!link) return null
  if (toolName === 'create_booking_link') return { kind: 'link', verb: 'made', link }
  if (toolName === 'update_booking_link') return { kind: 'link', verb: link.active ? 'changed' : 'off', link }
  if (toolName === 'delete_booking_link') return { kind: 'link', verb: 'off', link }
  return null
}

/** "30 min · Ada Finch", "1 hr · Ada Finch and Ben Ruiz, all attend", "30 min · Ada Finch or Ben Ruiz". */
export function linkCardLine(link: Pick<LinkCardItem, 'durationMinutes' | 'hostNames' | 'hostMode'>): string {
  const names = link.hostNames
  const length = lengthLabel(link.durationMinutes)
  if (!names.length) return length
  if (names.length === 1) return `${length} · ${names[0]}`
  const list = `${names.slice(0, -1).join(', ')} ${link.hostMode === 'any' ? 'or' : 'and'} ${names[names.length - 1]}`
  return `${length} · ${list}${link.hostMode === 'all' ? ', all attend' : ''}`
}
