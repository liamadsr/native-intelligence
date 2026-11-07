import type { Site } from './server'

/**
 * The driver fixtures (docs/plans/cloud-browser.md, C1), each a scripted run:
 * read the page, find a control by its accessible name, act on it exactly as
 * the task executor would, and record the runtime's answer plus what the page
 * saw. The desktop's WebKit layer and the cloud driver must give the same
 * record (desktop-baseline.json).
 */

export type Step =
  | { do: 'click'; name: string; approved?: boolean }
  | { do: 'type'; name: string; text: string }
  | { do: 'select'; name: string; option: number }
  | { do: 'wait'; ms: number }

export interface FixtureCase {
  id: string
  start: { site: Site; path: string }
  /** Blocked sites for the navigation guard while the case runs. */
  sites?: string[]
  steps: Step[]
}

export const CASES: FixtureCase[] = [
  { id: 'same-origin-frame-form', start: { site: 'A', path: '/same-origin' },
    steps: [{ do: 'type', name: 'Guests', text: '4' }, { do: 'click', name: 'Book' }] },
  { id: 'cross-site-frame-button', start: { site: 'A', path: '/cross' },
    steps: [{ do: 'type', name: 'Guests', text: '2' }, { do: 'click', name: 'Book' }] },
  { id: 'nested-cross-site-frames', start: { site: 'A', path: '/nested' },
    steps: [{ do: 'click', name: 'Book inner' }] },
  { id: 'open-shadow-picker', start: { site: 'A', path: '/shadow' },
    steps: [{ do: 'click', name: 'Day 2' }] },
  { id: 'native-select', start: { site: 'A', path: '/select' },
    steps: [{ do: 'select', name: 'Size', option: 2 }] },
  { id: 'covered-button', start: { site: 'A', path: '/covered' },
    steps: [{ do: 'click', name: 'Continue' }, { do: 'click', name: 'Help' }] },
  { id: 'sensitive-submit', start: { site: 'A', path: '/sensitive' },
    steps: [{ do: 'click', name: 'Place order' }, { do: 'click', name: 'Place order', approved: true }] },
  { id: 'redirect-into-blocked-site', start: { site: 'A', path: '/redirect-start' }, sites: ['localhost'],
    steps: [{ do: 'click', name: 'Continue to partner' }, { do: 'wait', ms: 1100 }, { do: 'click', name: 'Open partner' }] },
  { id: 'download-link', start: { site: 'A', path: '/download' },
    steps: [{ do: 'click', name: 'Get the file' }] },
  { id: 'popup', start: { site: 'A', path: '/popup' }, sites: ['localhost'],
    steps: [{ do: 'click', name: 'Open details' }, { do: 'click', name: 'Open partner window' }] },
]
