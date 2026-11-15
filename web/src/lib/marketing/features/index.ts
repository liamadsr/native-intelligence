/**
 * Every feature with a deep-dive page at /features/<slug>, in the side
 * panel's order (lib/marketing/site-nav.ts lists the same slugs with their
 * icons; __tests__/features.test.ts holds the two together).
 *
 * To add the recorded walkthrough to a page, set `video` in that feature's
 * file (see FeatureVideo in ./types.ts). The page opens on it from then on.
 */
import type { FeaturePage } from './types'
import { mail } from './mail'
import { tasks } from './tasks'
import { chat } from './chat'
import { docs } from './docs'
import { meetings } from './meetings'
import { crm } from './crm'
import { agents } from './agents'
import { tables } from './tables'
import { calendar } from './calendar'
import { coding } from './coding'
import { drive } from './drive'
import { flows } from './flows'
import { skills } from './skills'
import { bookingLinks } from './booking-links'
import { studio } from './studio'
import { seo } from './seo'
import { desktopApp } from './desktop-app'
import { mcp } from './mcp'

export type { FeaturePage, FeatureSection, FeatureVideo, FeatureDemoKey } from './types'

export const FEATURES: readonly FeaturePage[] = [
  mail,
  tasks,
  chat,
  docs,
  meetings,
  crm,
  agents,
  tables,
  calendar,
  coding,
  drive,
  flows,
  skills,
  bookingLinks,
  studio,
  seo,
  desktopApp,
  mcp,
]

export function getFeature(slug: string): FeaturePage | undefined {
  return FEATURES.find((feature) => feature.slug === slug)
}
