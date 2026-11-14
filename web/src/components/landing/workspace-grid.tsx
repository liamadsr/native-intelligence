/**
 * The landing page's map of the workspace: one tile per area the app's rail
 * offers, each with the rail's own icon (app/account/(dashboard)/rail/
 * rail-icons.ts), so the page names the same places a new member finds when
 * they sign in. Static: no timers, no animation of its own.
 *
 * EVERY TILE IS A SHIPPED AREA. The page claims nothing the product lacks, so
 * a tile is added when its area is live in production, and its copy says only
 * what that area does today. `AREAS` is exported for the page's test.
 */
import type { LucideIcon } from 'lucide-react'
import { GROUP_PAGE_ICONS, RAIL_ICONS } from '@/app/account/(dashboard)/rail/rail-icons'

export interface WorkspaceArea {
  name: string
  body: string
  icon: LucideIcon
}

export const AREAS: readonly WorkspaceArea[] = [
  {
    name: 'Mail',
    body: 'Gmail and Outlook in one inbox. Send later, and turn a thread into a task.',
    icon: RAIL_ICONS.mail,
  },
  {
    name: 'Chat and calls',
    body: 'Channels, direct messages and team calls, with your agents in the room.',
    icon: RAIL_ICONS['team-chat'],
  },
  {
    name: 'Meetings',
    body: 'Calls captured without a bot. Notes, transcript and next steps when you hang up.',
    icon: GROUP_PAGE_ICONS.captures,
  },
  {
    name: 'Calendar',
    body: 'Your calendars in one place, plus booking links people can pick a time from.',
    icon: RAIL_ICONS.calendar,
  },
  {
    name: 'Tasks and projects',
    body: 'Tasks, projects and initiatives, with workflows for each team.',
    icon: RAIL_ICONS.actions,
  },
  {
    name: 'Docs and tables',
    body: 'Docs, tables and files in one drive, which your agents can read and edit.',
    icon: RAIL_ICONS.drive,
  },
  {
    name: 'Customers',
    body: 'Companies, contacts and deals that fill themselves in from your calls and mail.',
    icon: RAIL_ICONS.contacts,
  },
  {
    name: 'Agents and flows',
    body: 'Agents with skills, and flows that run when mail arrives, a meeting ends or a schedule fires.',
    icon: RAIL_ICONS.agents,
  },
]

export function WorkspaceGrid() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {AREAS.map(({ name, body, icon: Icon }) => (
        <li key={name} className="rounded-2xl border border-border bg-secondary/30 p-5 text-left">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background">
            <Icon aria-hidden className="h-[18px] w-[18px] text-foreground" />
          </span>
          <h3 className="mt-4 font-medium text-foreground">{name}</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
        </li>
      ))}
    </ul>
  )
}
