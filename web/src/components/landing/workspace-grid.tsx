/**
 * The landing page's map of the workspace: one entry per area the app's rail
 * offers, each with the rail's own icon (app/account/(dashboard)/rail/
 * rail-icons.ts), so the page names the same places a new member finds when
 * they sign in. Each is a pane of clear glass over the sky, a link to the
 * area's page, and says which apps the area stands in for (the same list the
 * calculator above it adds up: lib/marketing/replace-apps.ts). Under the
 * pointer a tile lights where the pointer is and its arrow steps out. No
 * timers: the tiles arrive in turn, once.
 *
 * EVERY TILE IS A SHIPPED AREA. The page claims nothing the product lacks, so
 * an entry is added when its area is live in production, and its copy says
 * only what that area does today. `AREAS` is exported for the page's test.
 */
'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import { REPLACED_APPS, type ReplacedCategory } from '@/lib/marketing/replace-apps'
import { GROUP_PAGE_ICONS, RAIL_ICONS } from '@/app/account/(dashboard)/rail/rail-icons'
import { GROUP, MEMBER } from './motion'

export interface WorkspaceArea {
  name: string
  /** The area's deep dive. */
  href: string
  body: string
  icon: LucideIcon
  /** The kinds of app this area stands in for; none for the part no other app has. */
  replaces: readonly ReplacedCategory[]
}

export const AREAS: readonly WorkspaceArea[] = [
  {
    name: 'Mail',
    href: '/features/mail',
    body: 'Gmail and Outlook in one inbox. Send later, and turn a thread into a task.',
    icon: RAIL_ICONS.mail,
    replaces: ['Mail client'],
  },
  {
    name: 'Chat and calls',
    href: '/features/chat',
    body: 'Channels, direct messages and team calls, with your agents in the room.',
    icon: RAIL_ICONS['team-chat'],
    replaces: ['Team chat'],
  },
  {
    name: 'Meetings',
    href: '/features/meetings',
    body: 'Every call captured on your Mac. Notes, transcript and next steps when you hang up.',
    icon: GROUP_PAGE_ICONS.captures,
    replaces: ['Meeting notes'],
  },
  {
    name: 'Calendar',
    href: '/features/calendar',
    body: 'Your calendars in one place, plus booking links people can pick a time from.',
    icon: RAIL_ICONS.calendar,
    replaces: ['Scheduling'],
  },
  {
    name: 'Tasks and projects',
    href: '/features/tasks',
    body: 'Tasks, projects and initiatives, with workflows for each team.',
    icon: RAIL_ICONS.actions,
    replaces: ['Tasks and projects'],
  },
  {
    name: 'Docs and tables',
    href: '/features/docs',
    body: 'Docs, tables and files in one drive, which your agents can read and edit.',
    icon: RAIL_ICONS.drive,
    replaces: ['Docs and wiki', 'Tables'],
  },
  {
    name: 'Customers',
    href: '/features/crm',
    body: 'Companies, contacts and deals, created and updated from your calls and mail.',
    icon: RAIL_ICONS.contacts,
    replaces: ['CRM'],
  },
  {
    name: 'Agents and flows',
    href: '/features/agents',
    body: 'Agents with skills, and flows that run when mail arrives, a meeting ends or a schedule fires.',
    icon: RAIL_ICONS.agents,
    replaces: [],
  },
]

/** The names of the apps an area stands in for, in the calculator's order. */
export function replacedBy(area: WorkspaceArea): string[] {
  return REPLACED_APPS.filter((app) => area.replaces.includes(app.category)).map((app) => app.name)
}

/** Where the pointer is over a tile, for the light that follows it. */
function trackPointer(event: React.PointerEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.style.setProperty('--x', `${event.clientX - box.left}px`)
  event.currentTarget.style.setProperty('--y', `${event.clientY - box.top}px`)
}

/** The areas as glass tiles, four across on a wide screen, arriving in turn as they scroll into view. */
export function WorkspaceHub() {
  return (
    <motion.ul
      variants={GROUP}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: '-80px' }}
      className="grid gap-3 text-left sm:grid-cols-2 lg:grid-cols-4"
    >
      {AREAS.map((area) => {
        const { name, href, body, icon: Icon } = area
        const replaced = replacedBy(area)
        return (
          <motion.li key={name} variants={MEMBER} className="flex">
            <Link
              href={href}
              onPointerMove={trackPointer}
              className="group relative flex w-full flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-5 backdrop-blur-md transition-[border-color,background-color,translate] duration-300 hover:-translate-y-0.5 hover:border-foreground/25 hover:bg-foreground/[0.05] focus-visible:border-foreground/40 focus-visible:outline-none"
            >
              {/* The light under the pointer: white, like everything else lit on this page. */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{ background: 'radial-gradient(14rem circle at var(--x, 50%) var(--y, 0%), color-mix(in oklab, var(--foreground) 10%, transparent), transparent 70%)' }}
              />
              <span className="relative flex items-start justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-foreground/15 bg-background transition-transform duration-300 group-hover:scale-105">
                  <Icon aria-hidden className="h-5 w-5 text-foreground" />
                </span>
                <ArrowUpRight
                  aria-hidden
                  className="h-4 w-4 -translate-x-1 translate-y-1 text-muted-foreground opacity-0 transition-[opacity,translate,color] duration-300 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:text-foreground group-hover:opacity-100"
                />
              </span>
              <h3 className="relative mt-5 text-lg font-medium text-foreground">{name}</h3>
              <p className="relative mt-1.5 flex-1 text-[15px]/6 text-muted-foreground">{body}</p>
              <p className="relative mt-5 border-t border-foreground/10 pt-3 text-xs/5 text-muted-foreground">
                {replaced.length > 0 ? (
                  <>
                    <span className="mr-1.5 text-muted-foreground/70">Replaces</span>
                    <span className="text-foreground/80">{replaced.join(', ')}</span>
                  </>
                ) : (
                  <span className="text-foreground/80">Works across every area here</span>
                )}
              </p>
            </Link>
          </motion.li>
        )
      })}
    </motion.ul>
  )
}
