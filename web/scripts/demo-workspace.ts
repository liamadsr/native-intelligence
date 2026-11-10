/**
 * A demo workspace full of made-up data: for README screenshots, and for
 * anyone who wants to look around a fresh install.
 *
 * Creates, or finds, one demo person and fills their workspace:
 *   - the auth user demo@native-intelligence.test (a reserved .test domain, so
 *     it can never be a real person), with no password;
 *   - their own workspace (the signup trigger makes it, with its General team
 *     and that team's board columns), renamed "Fernhill Studio" (a made-up
 *     brand and web design studio) and marked `settings.demo_workspace = true`;
 *   - checked to have that person as its ONLY member;
 *   - a complimentary subscription (a granted_ row, as the admin console
 *     grants), so the trial wall doesn't stop the dashboard;
 *   - made-up work: one project with two milestones, three labels, twelve
 *     tasks across the board, three companies with seven contacts and their
 *     timelines, one finished meeting capture (summary, transcript, attendees,
 *     the tasks and decisions it produced), four calendar events this week,
 *     two documents, and 51 knowledge claims linked to all of it (what the
 *     Knowledge page's Graph draws), learned over the last eight weeks.
 * Every person, company, email and number in it is made up: emails are at
 * `.example` domains and phones are in the 555-01xx range.
 *
 * Running it again adds only what is missing. Calendar events move to the
 * current week each run.
 *
 *   --reset   first delete the rows this script seeded in the demo workspace
 *             (and nothing else), then seed them again.
 *   --clear-activity
 *             first delete what using the demo leaves behind in the demo
 *             workspace: the demo person's chat conversations and every
 *             capture the script didn't seed, with what came from them
 *             (see clearActivity). The browser keeps the main chat too, under
 *             localStorage `ni-chat:<workspace id>`.
 *   --link    also print a one-time sign-in link for the demo person that
 *             works against a local `next dev` on http://localhost:3000
 *             (src/app/auth/demo-link/route.ts redeems it). Open it in the
 *             browser you want signed in; it lands on /account.
 *   --port=N  the port your `next dev` runs on, for --link (default 3000).
 *
 * DEV OR LOCAL ONLY: refuses any Supabase URL but DEV's or one on this
 * machine (localhost / 127.0.0.1), and always refuses PROD. Writes only the
 * demo workspace's rows. Run from web/:
 *   node node_modules/.bin/tsx scripts/demo-workspace.ts [--reset] [--link] [--port=N]
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { DEMO_USER_EMAIL, PROD_SUPABASE_REF, demoSupabaseTarget } from '../src/lib/demo/demo-workspace-guard'

const WORKSPACE_NAME = 'Fernhill Studio'
const PERSON_NAME = 'Jordan Ellery'
const PORT_ARG = process.argv.find((a) => a.startsWith('--port='))?.slice('--port='.length)
const LOCAL_APP_ORIGIN = `http://localhost:${PORT_ARG && /^\d{2,5}$/.test(PORT_ARG) ? PORT_ARG : '3000'}`
/** Every seeded row that has a JSON column carries this, so --reset finds exactly them. */
const SEED = { demo_seed: true } as const

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
/** An ISO time `days` from now, at `hour`:`minute` UTC on that day. */
function at(days: number, hour?: number, minute = 0): string {
  const d = new Date(NOW + days * DAY)
  if (hour !== undefined) d.setUTCHours(hour, minute, 0, 0)
  return d.toISOString()
}
/** A date (YYYY-MM-DD) `days` from now. */
function day(days: number): string {
  return at(days).slice(0, 10)
}

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
}

function check<T>(label: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res.data
}

/** check() for a query that must return its one row. */
function one<T>(label: string, res: { data: T; error: { message: string } | null }): NonNullable<T> {
  const data = check(label, res)
  if (data == null) throw new Error(`${label}: no row`)
  return data as NonNullable<T>
}

async function findUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    const hit = data.users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (data.users.length < 200) return null
  }
  return null
}

// ── The made-up data ────────────────────────────────────────────────────────

const PROJECT_NAME = 'Larkspur Coffee site relaunch'
const LABELS = [
  { name: 'Design', color: '#a855f7' },
  { name: 'Development', color: '#3b82f6' },
  { name: 'Client', color: '#f59e0b' },
]
const MILESTONES = [
  { key: 'design', name: 'Design direction approved', status: 'in_progress', target: 7, sort: 0 },
  { key: 'launch', name: 'Launch', status: 'pending', target: 28, sort: 1 },
] as const

const COMPANIES = [
  {
    name: 'Larkspur Coffee',
    domain: 'larkspurcoffee.example',
    industry: 'Food & Beverage',
    city: 'Portland',
    state: 'OR',
    employees: '11-50',
    phone: '(503) 555-0110',
    description: 'Neighborhood roaster with two cafés and a growing wholesale business. Relaunching their site with online bean subscriptions.',
    tags: ['client', 'active project'],
    contacts: [
      { first: 'Maya', last: 'Okafor', title: 'Owner & Head Roaster', email: 'maya@larkspurcoffee.example', phone: '(503) 555-0111', type: 'customer', strength: 'strong' },
      { first: 'Theo', last: 'Lindqvist', title: 'Marketing Manager', email: 'theo@larkspurcoffee.example', phone: '(503) 555-0112', type: 'customer', strength: 'warm' },
      { first: 'Rosa', last: 'Delgado', title: 'Wholesale Lead', email: 'rosa@larkspurcoffee.example', phone: '(503) 555-0113', type: 'customer', strength: 'neutral' },
    ],
  },
  {
    name: 'Tidewater Outfitters',
    domain: 'tidewateroutfitters.example',
    industry: 'Retail',
    city: 'Astoria',
    state: 'OR',
    employees: '51-200',
    phone: '(503) 555-0120',
    description: 'Outdoor clothing shop with a busy online store. Retainer client for seasonal campaign pages.',
    tags: ['client', 'retainer'],
    contacts: [
      { first: 'Hannah', last: 'Brooks', title: 'Head of E-commerce', email: 'hannah@tidewateroutfitters.example', phone: '(503) 555-0121', type: 'customer', strength: 'warm' },
      { first: 'Marcus', last: 'Webb', title: 'Operations Director', email: 'marcus@tidewateroutfitters.example', phone: '(503) 555-0122', type: 'customer', strength: 'neutral' },
    ],
  },
  {
    name: 'Brightline Dental',
    domain: 'brightlinedental.example',
    industry: 'Healthcare',
    city: 'Beaverton',
    state: 'OR',
    employees: '11-50',
    phone: '(503) 555-0130',
    description: 'Family dental practice opening a second location. Wants a new brand and a booking-first website.',
    tags: ['lead'],
    contacts: [
      { first: 'Elena', last: 'Ruiz', title: 'Practice Owner', email: 'elena@brightlinedental.example', phone: '(503) 555-0131', type: 'lead', strength: 'warm' },
      { first: 'Sam', last: 'Patel', title: 'Office Manager', email: 'sam@brightlinedental.example', phone: '(503) 555-0132', type: 'lead', strength: 'neutral' },
    ],
  },
] as const

type StateName = 'Backlog' | 'Todo' | 'In Progress' | 'Done' | 'Canceled'
interface ActionSeed {
  key: string
  title: string
  description?: string
  state: StateName
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  labels: string[]
  project: boolean
  milestone?: 'design' | 'launch'
  due?: number
  completed?: number
  fromCapture?: boolean
}

const ACTIONS: ActionSeed[] = [
  { key: 'audit', title: 'Audit the current Larkspur site and analytics', state: 'Done', priority: 'medium', labels: ['Development'], project: true, completed: -6,
    description: 'Page speed, top landing pages, and where wholesale enquiries come from today.' },
  { key: 'agenda', title: 'Send the kickoff agenda to Maya and Theo', state: 'Done', priority: 'low', labels: ['Client'], project: true, completed: -2 },
  { key: 'moodboard', title: 'Moodboard: three visual directions for Larkspur', state: 'Done', priority: 'high', labels: ['Design'], project: true, milestone: 'design', completed: -1 },
  { key: 'wireframes', title: 'Homepage wireframes (desktop and mobile)', state: 'In Progress', priority: 'high', labels: ['Design'], project: true, milestone: 'design', due: 2, fromCapture: true,
    description: 'Lead with the subscription offer, then the two cafés, then wholesale. Use the warm editorial direction.' },
  { key: 'copy', title: 'Write new menu and wholesale page copy', state: 'In Progress', priority: 'medium', labels: ['Client'], project: true, due: 4, fromCapture: true },
  { key: 'tidewater', title: 'Tidewater Outfitters: spring lookbook landing page', state: 'In Progress', priority: 'urgent', labels: ['Design', 'Development'], project: false, due: 1,
    description: 'Hero video, six product stories, and a sign-up block for the early-access list.' },
  { key: 'shopify', title: 'Set up a Shopify staging store for bean subscriptions', state: 'Todo', priority: 'high', labels: ['Development'], project: true, milestone: 'launch', due: 6, fromCapture: true },
  { key: 'photos', title: 'Collect product photos from the roastery shoot', state: 'Todo', priority: 'medium', labels: ['Client'], project: true, due: 3, fromCapture: true },
  { key: 'brightline', title: 'Brightline Dental: send proposal and timeline', state: 'Todo', priority: 'high', labels: ['Client'], project: false, due: 2,
    description: 'Brand refresh plus a booking-first site for both locations. Two options: phased or all at once.' },
  { key: 'tokens', title: 'Define the type scale and color tokens for the new brand', state: 'Todo', priority: 'medium', labels: ['Design'], project: true, milestone: 'design', due: 5 },
  { key: 'redirects', title: "Plan 301 redirects from the old site's URLs", state: 'Backlog', priority: 'low', labels: ['Development'], project: true, milestone: 'launch' },
  { key: 'case-study', title: 'Draft a case study once Larkspur launches', state: 'Backlog', priority: 'low', labels: [], project: true },
]

const CAPTURE_TITLE = 'Kickoff: Larkspur Coffee site relaunch'
const CAPTURE_MINUTES = 40

const CAPTURE_SUMMARY = `## Overview
Kickoff for the Larkspur Coffee site relaunch with Maya (owner) and Theo (marketing). The current site is slow on phones, hides wholesale, and can't sell beans online. The new site should sell subscriptions, show off the two cafés, and make wholesale easy to ask about.

## Goals
- **Sell beans online.** Monthly subscriptions first, one-off bags second.
- **Tell the roastery story.** Sourcing, roast dates, the people behind the bar.
- **Grow wholesale.** A clear page and a short enquiry form for cafés and offices.
- **Fast on phones.** Most visits come from Instagram on mobile.

## Discussion
- Maya liked the *warm editorial* moodboard direction best: big photography, a serif headline face, lots of cream and espresso tones.
- Theo wants the homepage to lead with the subscription offer, then the cafés, then wholesale.
- Rosa's wholesale price sheet changes every quarter, so it should live behind the enquiry form, not on the page.
- Online ordering moves to Shopify. The café menus stay on the main site and are edited by Theo.

## Next steps
- Jordan: homepage wireframes for desktop and mobile by Thursday.
- Theo: new menu and wholesale copy.
- Maya: product photos from last month's roastery shoot.
- Jordan: Shopify staging store for subscriptions before the design review.
`

const TRANSCRIPT: [string, string][] = [
  ['local_1', "Thanks for making the time, both of you. I thought we'd start with what's not working on the current site, then goals, then timing."],
  ['Maya Okafor', "Honestly the biggest thing is we can't sell beans online. People ask us every day at the counter."],
  ['Theo Lindqvist', "And it's slow on phones. Almost all our traffic comes from Instagram, so that's most people."],
  ['local_1', 'That matches the audit. The homepage takes about six seconds on a phone, mostly from the uncompressed photos.'],
  ['Maya Okafor', "We also get wholesale emails that just say 'how much?' and nothing else. It would be good to ask a few questions up front."],
  ['local_1', "So three jobs for the site: subscriptions, the café story, and wholesale enquiries. Does that order feel right for the homepage?"],
  ['Theo Lindqvist', 'Subscriptions first, for sure. Then the cafés, then wholesale near the bottom.'],
  ['local_1', 'For the shop, I would put ordering on Shopify and keep the menus on the main site, so Theo can edit them without touching the store.'],
  ['Maya Okafor', "Yes, let's do that. We tried running everything in one place before and it was a mess."],
  ['local_1', 'Great. On the moodboards, which direction felt most like Larkspur?'],
  ['Maya Okafor', "The warm editorial one. The big photos and the serif headlines. It feels like the cafés."],
  ['Theo Lindqvist', "Agreed. Can we keep the cream and espresso colors from that one?"],
  ['local_1', "Definitely. I'll build the type scale and color tokens from it. Rosa mentioned the wholesale price sheet changes every quarter?"],
  ['Maya Okafor', "It does, so let's not put prices on the page. Put them behind the form."],
  ['local_1', "Makes sense. Timing: if we aim for the first week of next month, you'd be live before the holiday blend."],
  ['Theo Lindqvist', "That would be ideal. I can have the menu and wholesale copy to you next week."],
  ['Maya Okafor', "And I'll send the photos from last month's roastery shoot."],
  ['local_1', "Perfect. I'll have homepage wireframes for desktop and mobile by Thursday, and a staging store set up before the design review."],
]

const DECISIONS = [
  { content: 'Move online ordering for beans to Shopify; keep the café menus on the main site.', at: 470 },
  { content: "Go with the 'warm editorial' visual direction from the moodboards.", at: 1240 },
  { content: 'Keep wholesale prices off the site; share them after the enquiry form.', at: 1650 },
  { content: 'Launch in the first week of next month, ahead of the holiday blend.', at: 2010 },
]

const DOCUMENTS = [
  {
    title: 'Larkspur Coffee: project brief',
    project: true,
    content: `# Larkspur Coffee: project brief

## Client
Larkspur Coffee, a neighborhood roaster with two cafés and a wholesale arm.

## Problem
The current site is slow on phones, can't sell beans, and buries wholesale.

## What we're making
- A new marketing site: home, cafés, our coffee, wholesale, about.
- A Shopify store for subscriptions and one-off bags.
- A short wholesale enquiry form.

## Success looks like
- 150 active subscriptions within three months of launch.
- Homepage loads in under two seconds on a mid-range phone.
- Wholesale enquiries that arrive with volume and location filled in.

## Timeline
| Phase | When |
| --- | --- |
| Design direction approved | Next week |
| Build and content | Weeks 2-3 |
| Launch | First week of next month |
`,
  },
  {
    title: 'Studio playbook: client kickoff checklist',
    project: false,
    content: `# Client kickoff checklist

Before the call
- [ ] Audit the current site (speed, analytics, top pages).
- [ ] Prepare two or three moodboard directions.
- [ ] Send the agenda a day ahead.

On the call
- [ ] Agree on the site's top three jobs, in order.
- [ ] Pick a visual direction.
- [ ] Settle where the store and content live.
- [ ] Set a launch date and the first review.

After the call
- [ ] Share the summary and the tasks it produced.
- [ ] Book the design review.
`,
  },
]

// ── Knowledge (the Knowledge page's Graph) ──────────────────────────────────
//
// The Graph draws `claim` rows (active, not dismissed) and the `entity_link`
// rows whose source is a claim (src/lib/knowledge/graph-map/source.ts): a link
// to another claim is an edge, a link to a document, capture, contact, project,
// task or company is a hub. A claim lives on the hub of its EARLIEST link, so
// each claim's first link is the one to its source, as the extractor writes it
// (src/lib/inngest/claim-extraction.ts + src/lib/ai/claim-provenance.ts):
//   - a `cites` link plus a `claim_source` row (with a verbatim excerpt) to
//     where it came from;
//   - `about` links to the source's project and company, each mirrored as a
//     `claim_source` row without an excerpt;
//   - `mentions` / `committed_to` links to people and tasks, and links between
//     claims (`related_to`, `depends_on`, `supersedes`).
// Positions are computed by the app on read; nothing is precomputed, and the
// map needs no embeddings. Seeded claims get ids derived from their key, which
// is how --reset finds them (claim has no JSON column to mark), and
// `woven_at`, so the daily knowledge weaver leaves them alone.

type ClaimType = 'fact' | 'open_question' | 'inference' | 'decision_summary'
type ClaimRelation = 'related_to' | 'depends_on' | 'supersedes'
/** A seeded entity: 'capture', 'project', 'doc:brief', 'doc:playbook', 'co:<slug>', 'ct:<email>', 'act:<task key>'. */
type Ref = string

interface ClaimSeed {
  key: string
  text: string
  type: ClaimType
  /** Days before now it was learned. Ignored for claims from the kickoff capture, which come right after the call. */
  days: number
  source: Ref
  excerpt?: string
  confidence?: number
  suggested?: boolean
  about?: Ref[]
  mentions?: Ref[]
  commits?: Ref[]
  claims?: [string, ClaimRelation][]
  /** The newer claim that replaced this one: it stays in the record, off the map. */
  supersededBy?: string
}

const CLAIMS: ClaimSeed[] = [
  // Tidewater Outfitters: the longest-running client.
  { key: 'tw-retainer', type: 'fact', days: -56, source: 'co:tidewater', excerpt: 'Retainer client for seasonal campaign pages.',
    text: 'Tidewater Outfitters is a retainer client for seasonal campaign pages.', mentions: ['ct:marcus@tidewateroutfitters.example'] },
  { key: 'tw-hannah-approves', type: 'fact', days: -54, source: 'ct:hannah@tidewateroutfitters.example',
    text: 'Hannah Brooks runs e-commerce at Tidewater and signs off every campaign page.' },
  { key: 'tw-autumn', type: 'fact', days: -48, source: 'co:tidewater',
    text: "Last autumn's Tidewater campaign page went from brief to live in two weeks." },
  { key: 'tw-seasons', type: 'inference', days: -47, source: 'co:tidewater', confidence: 0.72, suggested: true,
    text: "Most of Tidewater's online sales land in the spring and autumn campaign windows.", claims: [['tw-autumn', 'related_to']] },
  { key: 'tw-marcus-timing', type: 'inference', days: -44, source: 'ct:marcus@tidewateroutfitters.example', confidence: 0.68, suggested: true,
    text: 'Marcus cares most about each campaign page shipping before the sale it supports.' },
  { key: 'tw-canada', type: 'open_question', days: -20, source: 'ct:hannah@tidewateroutfitters.example', suggested: true,
    text: 'Does Tidewater want the lookbook page in French for its Canadian customers?', claims: [['tw-lookbook-scope', 'related_to']] },
  { key: 'tw-lookbook-scope', type: 'fact', days: -12, source: 'act:tidewater', excerpt: 'Hero video, six product stories, and a sign-up block for the early-access list.',
    text: 'The spring lookbook page needs a hero video, six product stories and an early-access sign-up.',
    about: ['co:tidewater'], mentions: ['ct:hannah@tidewateroutfitters.example'] },
  { key: 'tw-renewal', type: 'decision_summary', days: -9, source: 'ct:marcus@tidewateroutfitters.example',
    excerpt: 'Marcus is happy to renew the retainer for another six months.',
    text: 'Tidewater is renewing the retainer for another six months.', claims: [['tw-retainer', 'related_to']] },
  { key: 'tw-assets', type: 'fact', days: -3, source: 'ct:hannah@tidewateroutfitters.example', excerpt: 'Hannah shared the hero video and six product shots.',
    text: 'Hannah sent the hero video and six product shots for the spring lookbook.',
    commits: ['act:tidewater'], claims: [['tw-lookbook-scope', 'depends_on']] },

  // The studio's own way of working.
  { key: 'st-audit', type: 'fact', days: -50, source: 'doc:playbook', excerpt: 'Audit the current site (speed, analytics, top pages).',
    text: "Fernhill audits a client's current site (speed, analytics, top pages) before every kickoff." },
  { key: 'st-moodboards', type: 'fact', days: -49.9, source: 'doc:playbook', excerpt: 'Prepare two or three moodboard directions.',
    text: 'The studio prepares two or three moodboard directions for every brand project.' },
  { key: 'st-agenda', type: 'fact', days: -49.8, source: 'doc:playbook', excerpt: 'Send the agenda a day ahead.',
    text: 'Kickoff agendas go out a day before the call.' },
  { key: 'st-top-three', type: 'decision_summary', days: -49.6, source: 'doc:playbook', excerpt: "Agree on the site's top three jobs, in order.",
    text: "Every kickoff ends with the site's top three jobs agreed, in order." },
  { key: 'st-review', type: 'fact', days: -49.5, source: 'doc:playbook', excerpt: 'Book the design review.',
    text: 'The first design review is booked before the kickoff call ends.' },
  { key: 'st-summary', type: 'fact', days: -49.4, source: 'doc:playbook', excerpt: 'Share the summary and the tasks it produced.',
    text: 'After a kickoff the studio shares the summary and the tasks it produced.' },
  { key: 'st-separate-store', type: 'inference', days: -36, source: 'doc:playbook', excerpt: 'Settle where the store and content live.', confidence: 0.7, suggested: true,
    text: 'Clients sign off faster when the store and the content site are separate from the start.' },
  { key: 'st-a11y', type: 'open_question', days: -35, source: 'doc:playbook', suggested: true,
    text: 'Should the kickoff checklist include an accessibility audit?', claims: [['st-audit', 'related_to']] },

  // Brightline Dental: a new lead.
  { key: 'bl-practice', type: 'fact', days: -33, source: 'co:brightline', excerpt: 'Family dental practice opening a second location.',
    text: 'Brightline Dental is a family practice opening a second location.' },
  { key: 'bl-wants', type: 'fact', days: -32.9, source: 'co:brightline', excerpt: 'Wants a new brand and a booking-first website.',
    text: 'Brightline wants a new brand and a website built around online booking.' },
  { key: 'bl-sam', type: 'fact', days: -28, source: 'ct:sam@brightlinedental.example',
    text: 'Sam Patel is the day-to-day contact for scheduling at Brightline.' },
  { key: 'bl-booking-system', type: 'open_question', days: -27.9, source: 'ct:sam@brightlinedental.example', suggested: true,
    text: 'Which booking system does Brightline already use at the first location?', claims: [['bl-wants', 'related_to']] },
  { key: 'bl-proposal-options', type: 'decision_summary', days: -6, source: 'act:brightline', excerpt: 'Two options: phased or all at once.',
    text: 'The Brightline proposal offers two options: phased, or everything at once.', about: ['co:brightline'] },
  { key: 'bl-spring', type: 'fact', days: -5, source: 'ct:elena@brightlinedental.example', excerpt: 'Second location opens in spring; wants online booking on day one.',
    text: "Brightline's second location opens in the spring." },
  { key: 'bl-day-one', type: 'fact', days: -4.9, source: 'ct:elena@brightlinedental.example', excerpt: 'Second location opens in spring; wants online booking on day one.',
    text: "Elena Ruiz wants online booking working on the second location's first day.", claims: [['bl-spring', 'depends_on']] },
  { key: 'bl-phased', type: 'inference', days: -2, source: 'co:brightline', confidence: 0.64, suggested: true,
    text: 'Brightline will probably pick the phased option so booking is ready for the new location.',
    claims: [['bl-proposal-options', 'related_to'], ['bl-day-one', 'depends_on']] },
  { key: 'bl-promise', type: 'fact', days: -1, source: 'ct:sam@brightlinedental.example', excerpt: 'Told Sam the proposal arrives this week.',
    text: 'Jordan promised Sam the proposal this week.', commits: ['act:brightline'] },

  // Larkspur Coffee: the brief and the run-up to kickoff.
  { key: 'lk-company', type: 'fact', days: -24, source: 'co:larkspur', excerpt: 'Neighborhood roaster with two cafés and a growing wholesale business.',
    text: 'Larkspur Coffee is a neighborhood roaster with two cafés and a growing wholesale business.' },
  { key: 'lk-problem', type: 'fact', days: -21, source: 'doc:brief', excerpt: "The current site is slow on phones, can't sell beans, and buries wholesale.",
    text: "Larkspur's current site is slow on phones, can't sell beans and buries wholesale." },
  { key: 'lk-subs-goal', type: 'fact', days: -20.95, source: 'doc:brief', excerpt: '150 active subscriptions within three months of launch.',
    text: 'Success for the relaunch is 150 active bean subscriptions within three months of launch.' },
  { key: 'lk-speed-goal', type: 'fact', days: -20.9, source: 'doc:brief', excerpt: 'Homepage loads in under two seconds on a mid-range phone.',
    text: 'The new Larkspur homepage has to load in under two seconds on a mid-range phone.', claims: [['lk-problem', 'related_to']] },
  { key: 'lk-wholesale-goal', type: 'fact', days: -20.85, source: 'doc:brief', excerpt: 'Wholesale enquiries that arrive with volume and location filled in.',
    text: 'Wholesale enquiries should arrive with volume and location filled in.' },
  { key: 'lk-scope', type: 'fact', days: -20.8, source: 'doc:brief', excerpt: 'A Shopify store for subscriptions and one-off bags.',
    text: 'The relaunch covers a marketing site, a Shopify store for subscriptions and bags, and a wholesale enquiry form.' },
  { key: 'lk-prices-listed', type: 'decision_summary', days: -20.7, source: 'doc:brief', supersededBy: 'kk-prices',
    text: 'Wholesale prices will be listed on the new wholesale page.' },
  { key: 'lk-audit', type: 'fact', days: -6, source: 'act:audit', excerpt: 'Page speed, top landing pages, and where wholesale enquiries come from today.',
    text: 'The site audit covered page speed, the top landing pages and where wholesale enquiries come from.',
    claims: [['st-audit', 'related_to']] },
  { key: 'lk-rosa-sheet', type: 'fact', days: -4, source: 'ct:rosa@larkspurcoffee.example', excerpt: "Rosa sent this quarter's wholesale price sheet.",
    text: "Rosa Delgado's wholesale price sheet changes every quarter." },
  { key: 'lk-agenda-sent', type: 'fact', days: -2, source: 'ct:maya@larkspurcoffee.example', excerpt: 'Sent the agenda and the three moodboard directions.',
    text: 'Jordan sent Maya the kickoff agenda and three moodboard directions.',
    mentions: ['act:agenda'], claims: [['st-agenda', 'related_to'], ['st-moodboards', 'related_to']] },

  // The kickoff call itself.
  { key: 'kk-beans', type: 'fact', days: -1, source: 'capture',
    excerpt: "Honestly the biggest thing is we can't sell beans online. People ask us every day at the counter.",
    text: 'Larkspur customers ask at the counter every day to buy beans online.', mentions: ['ct:maya@larkspurcoffee.example'],
    claims: [['lk-problem', 'related_to']] },
  { key: 'kk-instagram', type: 'fact', days: -1, source: 'capture',
    excerpt: "And it's slow on phones. Almost all our traffic comes from Instagram, so that's most people.",
    text: "Almost all of Larkspur's web traffic comes from Instagram, on phones.", mentions: ['ct:theo@larkspurcoffee.example'],
    claims: [['lk-speed-goal', 'related_to']] },
  { key: 'kk-six-seconds', type: 'inference', days: -1, source: 'capture', confidence: 0.74, suggested: true,
    excerpt: 'That matches the audit. The homepage takes about six seconds on a phone, mostly from the uncompressed photos.',
    text: 'The six-second mobile load time is probably costing Larkspur visitors from Instagram.',
    claims: [['kk-instagram', 'depends_on'], ['lk-audit', 'related_to']] },
  { key: 'kk-how-much', type: 'fact', days: -1, source: 'capture',
    excerpt: "We also get wholesale emails that just say 'how much?' and nothing else.",
    text: 'Wholesale emails often arrive with no detail beyond asking the price.', claims: [['lk-wholesale-goal', 'related_to']] },
  { key: 'kk-order', type: 'decision_summary', days: -1, source: 'capture',
    excerpt: 'Subscriptions first, for sure. Then the cafés, then wholesale near the bottom.',
    text: 'The homepage leads with subscriptions, then the cafés, then wholesale.',
    commits: ['act:wireframes'], claims: [['st-top-three', 'related_to']] },
  { key: 'kk-shopify', type: 'decision_summary', days: -1, source: 'capture',
    excerpt: "Yes, let's do that. We tried running everything in one place before and it was a mess.",
    text: 'Online ordering moves to Shopify; the café menus stay on the main site.',
    commits: ['act:shopify'], claims: [['st-separate-store', 'related_to'], ['lk-scope', 'related_to']] },
  { key: 'kk-direction', type: 'decision_summary', days: -1, source: 'capture',
    excerpt: 'The warm editorial one. The big photos and the serif headlines. It feels like the cafés.',
    text: "Larkspur chose the 'warm editorial' visual direction.", mentions: ['act:moodboard'], claims: [['st-moodboards', 'related_to']] },
  { key: 'kk-colors', type: 'fact', days: -1, source: 'capture', excerpt: 'Agreed. Can we keep the cream and espresso colors from that one?',
    text: 'The new brand keeps the cream and espresso colors from the moodboard.', commits: ['act:tokens'],
    claims: [['kk-direction', 'depends_on']] },
  { key: 'kk-prices', type: 'decision_summary', days: -1, source: 'capture', excerpt: "It does, so let's not put prices on the page. Put them behind the form.",
    text: 'Wholesale prices stay off the site and go out after the enquiry form.', mentions: ['ct:rosa@larkspurcoffee.example'],
    claims: [['lk-prices-listed', 'supersedes'], ['lk-rosa-sheet', 'related_to']] },
  { key: 'kk-launch', type: 'decision_summary', days: -1, source: 'capture',
    excerpt: "Timing: if we aim for the first week of next month, you'd be live before the holiday blend.",
    text: 'The relaunch targets the first week of next month, ahead of the holiday blend.', about: ['act:redirects'] },
  { key: 'kk-theo-copy', type: 'fact', days: -1, source: 'capture', excerpt: 'That would be ideal. I can have the menu and wholesale copy to you next week.',
    text: 'Theo will deliver the menu and wholesale copy next week.', mentions: ['ct:theo@larkspurcoffee.example'], commits: ['act:copy'] },
  { key: 'kk-maya-photos', type: 'fact', days: -1, source: 'capture', excerpt: "And I'll send the photos from last month's roastery shoot.",
    text: "Maya will send the photos from last month's roastery shoot.", mentions: ['ct:maya@larkspurcoffee.example'], commits: ['act:photos'] },
  { key: 'kk-wireframes', type: 'fact', days: -1, source: 'capture',
    excerpt: "Perfect. I'll have homepage wireframes for desktop and mobile by Thursday, and a staging store set up before the design review.",
    text: 'Jordan will have desktop and mobile homepage wireframes by Thursday.', commits: ['act:wireframes', 'act:shopify'],
    claims: [['kk-order', 'depends_on'], ['st-review', 'related_to']] },
  { key: 'kk-bags', type: 'open_question', days: -1, source: 'capture', suggested: true,
    text: 'Should one-off bags launch at the same time as subscriptions?', claims: [['kk-shopify', 'depends_on']] },
  { key: 'kk-gifts', type: 'open_question', days: -1, source: 'capture', suggested: true,
    text: 'Does Larkspur want gift subscriptions in time for the holidays?', claims: [['kk-launch', 'related_to'], ['lk-subs-goal', 'related_to']] },
]

/** A stable UUID for a seeded row, from its workspace and key: the same on every run, distinct per workspace. */
function seededUuid(workspaceId: string, key: string): string {
  const h = createHash('sha256').update(`demo-workspace:${workspaceId}:${key}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function claimIds(workspaceId: string): string[] {
  return CLAIMS.map((c) => seededUuid(workspaceId, `claim:${c.key}`))
}

/** Delete entity_link rows from or to the given claims. entity_link has no foreign keys, so nothing cascades to it. */
async function deleteClaimLinks(admin: SupabaseClient, workspaceId: string, ids: string[]): Promise<number> {
  let n = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const from = check('entity_link delete', await admin.from('entity_link').delete().eq('workspace_id', workspaceId).eq('source_type', 'claim').in('source_id', chunk).select('id'))
    const to = check('entity_link delete', await admin.from('entity_link').delete().eq('workspace_id', workspaceId).eq('target_type', 'claim').in('target_id', chunk).select('id'))
    n += (from?.length ?? 0) + (to?.length ?? 0)
  }
  return n
}

async function seedKnowledge(ctx: Ctx, refs: { projectId: string; captureId: string; contacts: ContactMap }): Promise<void> {
  const { admin, workspaceId, memberId } = ctx

  // Every seeded entity a claim can point at, by Ref.
  const ids = new Map<Ref, string>([['capture', refs.captureId], ['project', refs.projectId]])
  const companies = check('company', await admin.from('company').select('id, name').eq('workspace_id', workspaceId).contains('metadata', SEED))
  for (const c of companies ?? []) ids.set(`co:${(c.name as string).split(' ')[0].toLowerCase()}`, c.id as string)
  for (const [email, c] of refs.contacts) ids.set(`ct:${email}`, c.id)
  const docs = check('document', await admin.from('document').select('id, title').eq('workspace_id', workspaceId).contains('frontmatter', SEED))
  for (const d of docs ?? []) ids.set((d.title as string).startsWith('Larkspur') ? 'doc:brief' : 'doc:playbook', d.id as string)
  const acts = check('actions', await admin.from('actions').select('id, context_data').eq('workspace_id', workspaceId).contains('context_data', SEED))
  for (const a of acts ?? []) ids.set(`act:${(a.context_data as { demo_key: string }).demo_key}`, a.id as string)

  const companyOfContact = new Map<string, Ref>()
  for (const c of COMPANIES) for (const p of c.contacts) companyOfContact.set(`ct:${p.email}`, `co:${c.name.split(' ')[0].toLowerCase()}`)
  const projectActions = new Set(ACTIONS.filter((a) => a.project).map((a) => `act:${a.key}`))
  /** The `about` anchors a claim inherits from its source, as the extractor attaches them. */
  const anchorsOf = (source: Ref): Ref[] => {
    if (source === 'capture' || source === 'doc:brief') return ['project', 'co:larkspur']
    if (source.startsWith('ct:')) return [companyOfContact.get(source)!]
    if (projectActions.has(source)) return ['project', 'co:larkspur']
    return []
  }
  const entityType = (ref: Ref): string => {
    if (ref === 'capture' || ref === 'project') return ref
    return { doc: 'document', co: 'company', ct: 'contact', act: 'action' }[ref.split(':')[0]] as string
  }
  const resolve = (ref: Ref): string => {
    const id = ids.get(ref)
    if (!id) throw new Error(`knowledge: no seeded row for ${ref}`)
    return id
  }

  // Kickoff claims come out of the call a few minutes after it ends.
  const kickoffEnded = new Date(at(-1, 17)).getTime() + CAPTURE_MINUTES * 60 * 1000
  const claimRows: Record<string, unknown>[] = []
  const sourceRows: Record<string, unknown>[] = []
  const linkRows: Record<string, unknown>[] = []
  const claimId = (key: string) => seededUuid(workspaceId, `claim:${key}`)
  let kickoffIndex = 0

  for (const c of CLAIMS) {
    const created = c.source === 'capture' ? kickoffEnded + 5 * 60 * 1000 + kickoffIndex++ * 40 * 1000 : NOW + c.days * DAY
    const iso = (offsetSeconds = 0) => new Date(created + offsetSeconds * 1000).toISOString()
    const id = claimId(c.key)
    const confirmed = !c.suggested
    claimRows.push({
      id,
      workspace_id: workspaceId,
      text: c.text,
      type: c.type,
      confidence: c.confidence ?? (c.source === 'capture' ? 0.9 : 0.85),
      confirmation: confirmed ? 'confirmed' : 'suggested',
      auto_accepted: confirmed && c.source === 'capture',
      status: c.supersededBy ? 'superseded' : 'active',
      superseded_by: null,
      scope: 'workspace',
      created_by: memberId,
      created_at: iso(),
      updated_at: iso(),
      event_at: iso(),
      last_verified_at: confirmed ? iso() : null,
      woven_at: iso(),
    })

    // Provenance: `cites` its source (the claim's home on the map), with the excerpt.
    const sourceType = entityType(c.source)
    sourceRows.push({ claim_id: id, workspace_id: workspaceId, source_type: sourceType, source_id: resolve(c.source), source_uri: null, excerpt: c.excerpt ?? null, created_at: iso() })
    const link = (targetType: string, targetId: string, relation: string, offsetSeconds: number) =>
      linkRows.push({ workspace_id: workspaceId, source_type: 'claim', source_id: id, target_type: targetType, target_id: targetId, relation, created_by: memberId, created_at: iso(offsetSeconds) })
    link(sourceType, resolve(c.source), 'cites', 0)

    const abouts = [...new Set([...anchorsOf(c.source), ...(c.about ?? [])])].filter((r) => r !== c.source)
    for (const ref of abouts) {
      link(entityType(ref), resolve(ref), 'about', 1)
      sourceRows.push({ claim_id: id, workspace_id: workspaceId, source_type: entityType(ref), source_id: resolve(ref), source_uri: null, excerpt: null, created_at: iso(1) })
    }
    for (const ref of c.mentions ?? []) link(entityType(ref), resolve(ref), 'mentions', 2)
    for (const ref of c.commits ?? []) link(entityType(ref), resolve(ref), 'committed_to', 2)
    for (const [other, relation] of c.claims ?? []) link('claim', claimId(other), relation, 3)
  }

  const existing = check('claim', await admin.from('claim').select('id').eq('workspace_id', workspaceId).in('id', claimRows.map((r) => r.id as string)))
  const have = new Set((existing ?? []).map((r) => r.id as string))
  const missing = claimRows.filter((r) => !have.has(r.id as string))
  if (missing.length > 0) check('claim insert', await admin.from('claim').insert(missing))
  for (const c of CLAIMS) {
    if (!c.supersededBy || have.has(claimId(c.key))) continue
    check('claim superseded_by', await admin.from('claim').update({ superseded_by: claimId(c.supersededBy) }).eq('id', claimId(c.key)))
  }

  check(
    'claim_source upsert',
    await admin.from('claim_source').upsert(sourceRows, { onConflict: 'claim_id,source_type,source_id,source_uri', ignoreDuplicates: true }),
  )
  check(
    'entity_link upsert',
    await admin.from('entity_link').upsert(linkRows, { onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation', ignoreDuplicates: true }),
  )
}

// ── Clearing what screenshots leave behind ──────────────────────────────────

/**
 * --clear-activity: remove what using the demo leaves behind, so the next
 * screenshot starts clean. Only in the demo workspace, re-checked here by id
 * and `settings.demo_workspace`:
 *   - the demo person's chat conversations there (messages, home turns, relays,
 *     memory epochs and proposed changes go with them by foreign key; pending
 *     tool approvals and chat agent runs, which only hold the id, are deleted
 *     first);
 *   - every capture there that the script didn't seed (participants,
 *     decisions, labels, chunks, references, extraction passes, directives,
 *     lens findings and proposed changes go with it by foreign key; tasks it
 *     produced, comments on it, timeline rows pointing at it, and claims
 *     extracted from it or from the chats, with their links, are deleted first
 *     because nothing cascades to them).
 * Seeded rows are never touched.
 */
/** The `ref` a legacy JWT service-role key was minted for, or null (a new-style key, or not a JWT). */
function serviceKeyRef(key: string): string | null {
  const parts = key.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { ref?: unknown }
    return typeof payload.ref === 'string' ? payload.ref : null
  } catch {
    return null
  }
}

async function clearActivity(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId } = ctx
  const ws = one('workspace', await admin.from('workspace').select('id, settings').eq('id', workspaceId).single())
  if (ws.id !== workspaceId || (ws.settings as Record<string, unknown> | null)?.demo_workspace !== true) {
    throw new Error('refusing --clear-activity: the workspace is not marked settings.demo_workspace = true')
  }
  const inChunks = async (label: string, list: string[], run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    let n = 0
    for (let i = 0; i < list.length; i += 100) n += ((check(label, await run(list.slice(i, i + 100))) as unknown[] | null) ?? []).length
    return n
  }

  const convs = check('chat_conversations', await admin.from('chat_conversations').select('id').eq('workspace_id', workspaceId).eq('user_id', userId))
  const convIds = (convs ?? []).map((c) => c.id as string)
  const caps = check('captures', await admin.from('captures').select('id, metadata').eq('workspace_id', workspaceId))
  const capIds = (caps ?? []).filter((c) => (c.metadata as Record<string, unknown> | null)?.demo_seed !== true).map((c) => c.id as string)

  // Claims that came from those captures or chats (never a seeded claim).
  const seeded = new Set(claimIds(workspaceId))
  const fromSources = new Set<string>()
  for (const [type, list] of [['capture', capIds], ['conversation', convIds]] as const) {
    for (let i = 0; i < list.length; i += 100) {
      const rows = check('claim_source', await admin.from('claim_source').select('claim_id').eq('workspace_id', workspaceId).eq('source_type', type).in('source_id', list.slice(i, i + 100)))
      for (const r of rows ?? []) if (!seeded.has(r.claim_id as string)) fromSources.add(r.claim_id as string)
    }
  }
  const derivedClaims = [...fromSources]
  const claimLinks = await deleteClaimLinks(admin, workspaceId, derivedClaims)
  const claims = await inChunks('claim delete', derivedClaims, (c) => admin.from('claim').delete().eq('workspace_id', workspaceId).in('id', c).select('id'))

  const tasks = await inChunks('actions delete', capIds, (c) =>
    admin.from('actions').delete().eq('workspace_id', workspaceId).in('source_capture_id', c).select('id'),
  )
  const comments = await inChunks('comment delete', capIds, (c) => admin.from('comment').delete().eq('commentable_type', 'capture').in('commentable_id', c).select('id'))
  const timeline = await inChunks('contact_interaction delete', capIds, (c) =>
    admin.from('contact_interaction').delete().eq('workspace_id', workspaceId).eq('reference_type', 'capture').in('reference_id', c).select('id'),
  )
  const links =
    (await inChunks('entity_link delete', capIds, (c) => admin.from('entity_link').delete().eq('workspace_id', workspaceId).eq('target_type', 'capture').in('target_id', c).select('id'))) +
    (await inChunks('entity_link delete', convIds, (c) => admin.from('entity_link').delete().eq('workspace_id', workspaceId).eq('target_type', 'conversation').in('target_id', c).select('id')))
  const approvals = await inChunks('tool_approval delete', convIds, (c) => admin.from('tool_approval').delete().eq('workspace_id', workspaceId).in('conversation_id', c).select('id'))
  const runs = await inChunks('agent_run delete', convIds, (c) => admin.from('agent_run').delete().eq('workspace_id', workspaceId).in('chat_conversation_id', c).select('id'))

  const captures = await inChunks('captures delete', capIds, (c) => admin.from('captures').delete().eq('workspace_id', workspaceId).in('id', c).select('id'))
  const conversations = await inChunks('chat_conversations delete', convIds, (c) =>
    admin.from('chat_conversations').delete().eq('workspace_id', workspaceId).eq('user_id', userId).in('id', c).select('id'),
  )
  console.error(
    `clear-activity: deleted ${conversations} conversation(s), ${captures} capture(s), ${tasks} task(s) from them, ${claims} claim(s) ` +
      `(${claimLinks + links} link(s)), ${comments} comment(s), ${timeline} timeline row(s), ${approvals} approval(s), ${runs} agent run(s)`,
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

interface Ctx {
  admin: SupabaseClient
  userId: string
  workspaceId: string
  memberId: string
  teamId: string
  states: Map<string, string>
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..')
  loadEnvFile(resolve(root, '.env.development.local'))
  loadEnvFile(resolve(root, '.env.local'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const target = demoSupabaseTarget(url)
  if (!target) {
    throw new Error("refusing: NEXT_PUBLIC_SUPABASE_URL is neither DEV's Supabase nor a local one; the demo workspace lives on DEV or local only")
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (serviceKeyRef(key) === PROD_SUPABASE_REF) {
    throw new Error("refusing: SUPABASE_SERVICE_ROLE_KEY is PROD's (a tunnel or proxy to PROD looks local by URL alone)")
  }
  const admin = createClient(url, key, { auth: { persistSession: false } })
  console.error(`[demo-workspace] Supabase: ${target === 'dev' ? 'DEV' : 'local'}`)

  let userId = await findUserId(admin, DEMO_USER_EMAIL)
  const createdNow = !userId
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: DEMO_USER_EMAIL,
      email_confirm: true,
      user_metadata: { full_name: PERSON_NAME },
    })
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? 'no user'}`)
    userId = data.user.id
    console.error(`created ${DEMO_USER_EMAIL} (${userId})`)
  }

  const memberships = check('member', await admin.from('member').select('id, workspace_id').eq('user_id', userId))
  if (!memberships || memberships.length !== 1) {
    throw new Error(`expected the demo person in exactly one workspace, found ${memberships?.length ?? 0}`)
  }
  const workspaceId = memberships[0].workspace_id as string
  const memberId = memberships[0].id as string

  const members = check('member', await admin.from('member').select('user_id').eq('workspace_id', workspaceId))
  if (!members || members.length !== 1 || members[0].user_id !== userId) {
    throw new Error('the demo workspace has another member: refusing to seed it')
  }

  // The flag is set once, on the run that made the demo person, and required
  // on every run after: a workspace that isn't already marked is never written.
  const ws = check('workspace', await admin.from('workspace').select('settings').eq('id', workspaceId).single())
  const current = (ws?.settings as Record<string, unknown> | null) ?? {}
  if (!createdNow && current.demo_workspace !== true) {
    throw new Error('refusing: the demo person\'s workspace is not marked settings.demo_workspace = true')
  }
  const settings = { ...current, demo_workspace: true }
  check('workspace update', await admin.from('workspace').update({ name: WORKSPACE_NAME, settings }).eq('id', workspaceId))

  // Past onboarding, in a known time zone, so /account opens on the dashboard.
  const me = one('member', await admin.from('member').select('onboarding_completed_at, time_zone').eq('id', memberId).single())
  const memberPatch: Record<string, unknown> = {}
  if (!me.onboarding_completed_at) memberPatch.onboarding_completed_at = new Date().toISOString()
  if (!me.time_zone) memberPatch.time_zone = 'America/Los_Angeles'
  if (Object.keys(memberPatch).length > 0) check('member update', await admin.from('member').update(memberPatch).eq('id', memberId))

  await grantSubscription(admin, userId)

  const team = one(
    'team',
    await admin.from('team').select('id').eq('workspace_id', workspaceId).order('created_at', { ascending: true }).limit(1).single(),
  )
  const stateRows = check('workflow_state', await admin.from('workflow_state').select('id, name').eq('team_id', team.id))
  const states = new Map((stateRows ?? []).map((s) => [s.name as string, s.id as string]))
  for (const s of ['Backlog', 'Todo', 'In Progress', 'Done']) {
    if (!states.has(s)) throw new Error(`the team has no "${s}" column`)
  }

  const ctx: Ctx = { admin, userId, workspaceId, memberId, teamId: team.id as string, states }

  if (process.argv.includes('--clear-activity')) await clearActivity(ctx)
  if (process.argv.includes('--reset')) await reset(ctx)

  const labelIds = await seedLabels(ctx)
  const { projectId, milestoneIds } = await seedProject(ctx)
  const contacts = await seedCrm(ctx)
  const captureId = await seedCapture(ctx, projectId, contacts)
  await seedActions(ctx, { labelIds, projectId, milestoneIds, captureId })
  await seedInteractions(ctx, contacts, captureId)
  await seedCalendar(ctx)
  await seedDocuments(ctx, projectId)
  await seedKnowledge(ctx, { projectId, captureId, contacts })

  await printSummary(ctx)

  if (process.argv.includes('--link')) await printLink(admin)
}

async function grantSubscription(admin: SupabaseClient, userId: string): Promise<void> {
  // No free tier: the demo holds a complimentary grant, the same row the admin
  // console's grant-subscription route writes. Only once.
  const sub = check(
    'subscriptions',
    await admin.from('subscriptions').select('id').eq('user_id', userId).in('status', ['active', 'trialing']).limit(1).maybeSingle(),
  )
  if (sub) return
  check(
    'subscriptions insert',
    await admin.from('subscriptions').insert({
      user_id: userId,
      stripe_subscription_id: `granted_demo_workspace_${Date.now()}`,
      stripe_customer_id: null,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: null,
      cancel_at_period_end: false,
    }),
  )
  const plan = one('ai_plan_definitions', await admin.from('ai_plan_definitions').select('id').eq('name', 'subscriber').single())
  check(
    'ai_user_plans upsert',
    await admin.from('ai_user_plans').upsert({ user_id: userId, plan_id: plan.id, is_active: true }, { onConflict: 'user_id' }),
  )
  console.error('granted the demo person a complimentary subscription')
}

/** Delete exactly what this script seeds in the demo workspace. Children go with their parents (ON DELETE CASCADE). */
async function reset(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId, teamId } = ctx
  // Claims first: their links point at the rows below, and nothing cascades to entity_link.
  const seededClaims = claimIds(workspaceId)
  const claimLinks = await deleteClaimLinks(admin, workspaceId, seededClaims)
  const claimsDeleted = check('reset claims', await admin.from('claim').delete().eq('workspace_id', workspaceId).in('id', seededClaims).select('id'))?.length ?? 0

  const del = async (label: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>) =>
    ((check(label, await q) as unknown[] | null) ?? []).length

  const actions = await del('reset actions', admin.from('actions').delete().eq('workspace_id', workspaceId).contains('context_data', SEED).select('id'))
  const captures = await del('reset captures', admin.from('captures').delete().eq('workspace_id', workspaceId).contains('metadata', SEED).select('id'))
  const contacts = await del('reset contacts', admin.from('contact').delete().eq('workspace_id', workspaceId).contains('metadata', SEED).select('id'))
  const companies = await del('reset companies', admin.from('company').delete().eq('workspace_id', workspaceId).contains('metadata', SEED).select('id'))
  const projects = await del('reset projects', admin.from('projects').delete().eq('workspace_id', workspaceId).eq('name', PROJECT_NAME).select('id'))
  const labels = await del(
    'reset labels',
    admin.from('label').delete().eq('workspace_id', workspaceId).in('name', LABELS.map((l) => l.name)).select('id'),
  )
  const documents = await del('reset documents', admin.from('document').delete().eq('workspace_id', workspaceId).contains('frontmatter', SEED).select('id'))
  const events = await del(
    'reset calendar',
    admin.from('local_calendar_event').delete().eq('user_id', userId).eq('workspace_id', workspaceId).like('external_id', 'demo-%').select('id'),
  )

  // With no tasks left on the team, number them from 1 again (GEN-1, GEN-2, ...).
  const { count, error: countErr } = await admin.from('actions').select('id', { count: 'exact', head: true }).eq('team_id', teamId)
  if (countErr) throw new Error(`actions: ${countErr.message}`)
  if (count === 0) check('team counter', await admin.from('team').update({ issue_counter: 0 }).eq('id', teamId))

  console.error(
    `reset: deleted ${claimsDeleted} claim(s) (${claimLinks} link(s)), ${actions} task(s), ${captures} capture(s), ${contacts} contact(s), ${companies} company(ies), ` +
      `${projects} project(s), ${labels} label(s), ${documents} document(s), ${events} calendar event(s)`,
  )
}

async function seedLabels(ctx: Ctx): Promise<Map<string, string>> {
  const { admin, workspaceId } = ctx
  const existing = check('label', await admin.from('label').select('id, name').eq('workspace_id', workspaceId).in('name', LABELS.map((l) => l.name)))
  const ids = new Map((existing ?? []).map((l) => [l.name as string, l.id as string]))
  const missing = LABELS.filter((l) => !ids.has(l.name))
  if (missing.length > 0) {
    const rows = check(
      'label insert',
      await admin.from('label').insert(missing.map((l) => ({ workspace_id: workspaceId, name: l.name, color: l.color }))).select('id, name'),
    )
    for (const l of rows ?? []) ids.set(l.name as string, l.id as string)
  }
  return ids
}

async function seedProject(ctx: Ctx): Promise<{ projectId: string; milestoneIds: Map<string, string> }> {
  const { admin, workspaceId, userId, memberId } = ctx
  let project = check(
    'projects',
    await admin.from('projects').select('id').eq('workspace_id', workspaceId).eq('name', PROJECT_NAME).limit(1).maybeSingle(),
  )
  if (!project) {
    project = one(
      'projects insert',
      await admin
        .from('projects')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          name: PROJECT_NAME,
          description: 'New marketing site and Shopify store for Larkspur Coffee: bean subscriptions, the two cafés, and wholesale enquiries.',
          icon: 'folder',
          color: '#b45309',
          status: 'active',
          priority: 'high',
          health: 'on_track',
          lead_id: memberId,
          start_date: day(-7),
          target_date: day(28),
        })
        .select('id')
        .single(),
    )
  }
  const projectId = project.id as string

  const existing = check('milestone', await admin.from('milestone').select('id, name').eq('project_id', projectId))
  const byName = new Map((existing ?? []).map((m) => [m.name as string, m.id as string]))
  const milestoneIds = new Map<string, string>()
  for (const m of MILESTONES) {
    let id = byName.get(m.name)
    if (!id) {
      const row = one(
        'milestone insert',
        await admin
          .from('milestone')
          .insert({ project_id: projectId, name: m.name, status: m.status, target_date: day(m.target), sort_order: m.sort })
          .select('id')
          .single(),
      )
      id = row.id as string
    }
    milestoneIds.set(m.key, id)
  }
  return { projectId, milestoneIds }
}

type ContactMap = Map<string, { id: string; name: string; company: string; title: string }>

async function seedCrm(ctx: Ctx): Promise<ContactMap> {
  const { admin, workspaceId, memberId } = ctx
  const existingCompanies = check(
    'company',
    await admin.from('company').select('id, name').eq('workspace_id', workspaceId).contains('metadata', SEED),
  )
  const companyIds = new Map((existingCompanies ?? []).map((c) => [c.name as string, c.id as string]))
  const existingContacts = check(
    'contact',
    await admin.from('contact').select('id, email').eq('workspace_id', workspaceId).contains('metadata', SEED),
  )
  const contactIds = new Map((existingContacts ?? []).map((c) => [c.email as string, c.id as string]))

  const contacts: ContactMap = new Map()
  for (const c of COMPANIES) {
    let companyId = companyIds.get(c.name)
    if (!companyId) {
      const row = one(
        'company insert',
        await admin
          .from('company')
          .insert({
            workspace_id: workspaceId,
            name: c.name,
            domain: c.domain,
            website: `https://${c.domain}`,
            industry: c.industry,
            description: c.description,
            employee_count_range: c.employees,
            city: c.city,
            state: c.state,
            country: 'US',
            phone: c.phone,
            tags: [...c.tags],
            metadata: SEED,
          })
          .select('id')
          .single(),
      )
      companyId = row.id as string
    }
    for (const p of c.contacts) {
      let id = contactIds.get(p.email)
      if (!id) {
        const row = one(
          'contact insert',
          await admin
            .from('contact')
            .insert({
              workspace_id: workspaceId,
              company_id: companyId,
              first_name: p.first,
              last_name: p.last,
              full_name: `${p.first} ${p.last}`,
              email: p.email,
              phone: p.phone,
              job_title: p.title,
              relationship_type: p.type,
              relationship_strength: p.strength,
              source: 'manual',
              visibility: 'workspace',
              created_by_member_id: memberId,
              metadata: SEED,
            })
            .select('id')
            .single(),
        )
        id = row.id as string
      }
      contacts.set(p.email, { id, name: `${p.first} ${p.last}`, company: c.name, title: p.title })
    }
  }
  return contacts
}

async function seedCapture(ctx: Ctx, projectId: string, contacts: ContactMap): Promise<string> {
  const { admin, workspaceId, userId, memberId, teamId } = ctx
  const existing = check(
    'captures',
    await admin
      .from('captures')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('title', CAPTURE_TITLE)
      .contains('metadata', SEED)
      .limit(1)
      .maybeSingle(),
  )
  const started = at(-1, 17)
  const ended = new Date(new Date(started).getTime() + CAPTURE_MINUTES * 60 * 1000).toISOString()
  const maya = contacts.get('maya@larkspurcoffee.example')!
  const theo = contacts.get('theo@larkspurcoffee.example')!

  let captureId = existing?.id as string | undefined
  if (!captureId) {
    const capture = one(
      'captures insert',
      await admin
        .from('captures')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          team_id: teamId,
          project_id: projectId,
          title: CAPTURE_TITLE,
          ai_summary: CAPTURE_SUMMARY,
          transcript: TRANSCRIPT.map(([speaker, text]) => `[${speaker}] ${text}`).join('\n'),
          duration_seconds: CAPTURE_MINUTES * 60,
          status: 'active',
          ai_processed: true,
          batch_processed_at: ended,
          recorded_at: started,
          started_at: started,
          ended_at: ended,
          is_transcript_locked: true,
          scheduled_start: started,
          scheduled_end: ended,
          organizer_email: DEMO_USER_EMAIL,
          location: 'Video call',
          participants: [
            { name: PERSON_NAME, email: DEMO_USER_EMAIL, company: WORKSPACE_NAME, isOrganizer: true },
            { name: maya.name, email: 'maya@larkspurcoffee.example', company: maya.company, jobTitle: maya.title },
            { name: theo.name, email: 'theo@larkspurcoffee.example', company: theo.company, jobTitle: theo.title },
          ],
          visibility: 'workspace',
          metadata: { ...SEED, capture_mode: 'desktop_dual', finalized: true },
        })
        .select('id')
        .single(),
    )
    captureId = capture.id as string
  }

  // Attendees and decisions, each only while the capture has none. Every
  // attendee row names every column: a bulk insert fills a column one row
  // leaves out with null, not its default.
  const head = { count: 'exact' as const, head: true }
  const { count: attendees, error: aErr } = await admin.from('capture_participant').select('id', head).eq('capture_id', captureId)
  if (aErr) throw new Error(`capture_participant: ${aErr.message}`)
  if (!attendees) {
    const attendee = (p: { member_id?: string; contact_id?: string; name?: string; email?: string; company?: string; title?: string; label: string; self?: boolean }) => ({
      capture_id: captureId,
      member_id: p.member_id ?? null,
      contact_id: p.contact_id ?? null,
      external_name: p.name ?? null,
      external_email: p.email ?? null,
      company: p.company ?? null,
      job_title: p.title ?? null,
      speaker_label: p.label,
      role: p.self ? 'organizer' : 'attendee',
      is_self: !!p.self,
      self_binding: p.self ? 'confirmed' : 'none',
      source: 'calendar_event',
    })
    check(
      'capture_participant insert',
      await admin.from('capture_participant').insert([
        attendee({ member_id: memberId, label: 'local_1', self: true }),
        attendee({ contact_id: maya.id, name: maya.name, email: 'maya@larkspurcoffee.example', company: maya.company, title: maya.title, label: maya.name }),
        attendee({ contact_id: theo.id, name: theo.name, email: 'theo@larkspurcoffee.example', company: theo.company, title: theo.title, label: theo.name }),
      ]),
    )
  }
  const { count: decisions, error: dErr } = await admin.from('decision').select('id', head).eq('capture_id', captureId)
  if (dErr) throw new Error(`decision: ${dErr.message}`)
  if (!decisions) {
    check(
      'decision insert',
      await admin.from('decision').insert(
        DECISIONS.map((d) => ({
          capture_id: captureId,
          content: d.content,
          source_timestamp: d.at,
          project_id: projectId,
          confirmation: 'confirmed',
          decided_by: memberId,
        })),
      ),
    )
  }
  return captureId
}

async function seedActions(
  ctx: Ctx,
  refs: { labelIds: Map<string, string>; projectId: string; milestoneIds: Map<string, string>; captureId: string },
): Promise<void> {
  const { admin, workspaceId, userId, memberId, teamId, states } = ctx
  const existing = check(
    'actions',
    await admin.from('actions').select('context_data').eq('workspace_id', workspaceId).contains('context_data', SEED),
  )
  const have = new Set((existing ?? []).map((a) => (a.context_data as { demo_key?: string } | null)?.demo_key))

  // One at a time, in order, so the team numbers them in the order listed.
  for (const [i, a] of ACTIONS.entries()) {
    if (have.has(a.key)) continue
    const row = one(
      'actions insert',
      await admin
        .from('actions')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          team_id: teamId,
          status_id: states.get(a.state),
          title: a.title,
          description: a.description ?? null,
          priority: a.priority,
          all_day: true,
          due_at: a.due !== undefined ? at(a.due, 17) : null,
          completed_at: a.completed !== undefined ? at(a.completed, 21) : null,
          assignee_id: memberId,
          project_id: a.project ? refs.projectId : null,
          milestone_id: a.milestone ? refs.milestoneIds.get(a.milestone) : null,
          sort_order: i,
          confirmation: 'confirmed',
          source_type: a.fromCapture ? 'meeting_extraction' : 'user',
          source_capture_id: a.fromCapture ? refs.captureId : null,
          context_data: { ...SEED, demo_key: a.key },
        })
        .select('id')
        .single(),
    )
    check('action_assignee insert', await admin.from('action_assignee').insert({ action_id: row.id, member_id: memberId }))
    const labels = a.labels.map((n) => refs.labelIds.get(n)).filter((id): id is string => !!id)
    if (labels.length > 0) {
      check('action_label insert', await admin.from('action_label').insert(labels.map((label_id) => ({ action_id: row.id, label_id }))))
    }
  }
}

async function seedInteractions(ctx: Ctx, contacts: ContactMap, captureId: string): Promise<void> {
  const { admin, workspaceId } = ctx
  const rows: { email: string; type: string; ref?: string; title: string; summary: string; days: number }[] = [
    { email: 'maya@larkspurcoffee.example', type: 'capture', ref: 'capture', title: CAPTURE_TITLE, summary: 'Agreed on Shopify for subscriptions and the warm editorial direction.', days: -1 },
    { email: 'theo@larkspurcoffee.example', type: 'capture', ref: 'capture', title: CAPTURE_TITLE, summary: 'Theo owns the menu and wholesale copy.', days: -1 },
    { email: 'maya@larkspurcoffee.example', type: 'email_sent', title: 'Kickoff agenda', summary: 'Sent the agenda and the three moodboard directions.', days: -2 },
    { email: 'rosa@larkspurcoffee.example', type: 'email_received', title: 'Wholesale price sheet', summary: "Rosa sent this quarter's wholesale price sheet.", days: -4 },
    { email: 'hannah@tidewateroutfitters.example', type: 'email_received', title: 'Spring lookbook assets', summary: 'Hannah shared the hero video and six product shots.', days: -3 },
    { email: 'marcus@tidewateroutfitters.example', type: 'note_added', title: 'Retainer renewal', summary: 'Marcus is happy to renew the retainer for another six months.', days: -9 },
    { email: 'elena@brightlinedental.example', type: 'note_added', title: 'Discovery call notes', summary: 'Second location opens in spring; wants online booking on day one.', days: -5 },
    { email: 'sam@brightlinedental.example', type: 'email_sent', title: 'Proposal timing', summary: 'Told Sam the proposal arrives this week.', days: -1 },
  ]
  const existing = check(
    'contact_interaction',
    await admin.from('contact_interaction').select('metadata').eq('workspace_id', workspaceId).contains('metadata', SEED),
  )
  const have = new Set((existing ?? []).map((r) => (r.metadata as { demo_key?: string } | null)?.demo_key))

  const latest = new Map<string, { at: string; count: number }>()
  for (const r of rows) {
    const contact = contacts.get(r.email)
    if (!contact) continue
    const occurredAt = at(r.days, 18)
    const prev = latest.get(contact.id)
    latest.set(contact.id, { at: !prev || occurredAt > prev.at ? occurredAt : prev.at, count: (prev?.count ?? 0) + 1 })
    const demoKey = `${r.email}:${r.type}:${r.title}`
    if (have.has(demoKey)) continue
    check(
      'contact_interaction insert',
      await admin.from('contact_interaction').insert({
        workspace_id: workspaceId,
        contact_id: contact.id,
        interaction_type: r.type,
        reference_type: r.ref ?? null,
        reference_id: r.ref ? captureId : null,
        title: r.title,
        summary: r.summary,
        occurred_at: occurredAt,
        metadata: { ...SEED, demo_key: demoKey },
      }),
    )
  }
  for (const [contactId, v] of latest) {
    check(
      'contact update',
      await admin.from('contact').update({ last_interaction_at: v.at, interaction_count: v.count }).eq('id', contactId),
    )
  }
}

/** Events need no connected Google or Microsoft account: the calendar shows local_calendar_event rows on their own. */
async function seedCalendar(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId } = ctx
  const events = [
    { key: 'larkspur-review', title: 'Larkspur Coffee: homepage design review', days: 1, hour: 17, minutes: 45, attendees: ['maya@larkspurcoffee.example', 'theo@larkspurcoffee.example'] },
    { key: 'tidewater-checkin', title: 'Tidewater Outfitters: lookbook check-in', days: 2, hour: 18, minutes: 30, attendees: ['hannah@tidewateroutfitters.example'] },
    { key: 'brightline-proposal', title: 'Brightline Dental: proposal walkthrough', days: 3, hour: 16, minutes: 60, attendees: ['elena@brightlinedental.example', 'sam@brightlinedental.example'] },
    { key: 'studio-planning', title: 'Studio planning: next week', days: 4, hour: 22, minutes: 30, attendees: [] as string[] },
  ]
  check(
    'local_calendar_event upsert',
    await admin.from('local_calendar_event').upsert(
      events.map((e) => {
        const start = at(e.days, e.hour)
        return {
          user_id: userId,
          workspace_id: workspaceId,
          external_id: `demo-${e.key}`,
          title: e.title,
          start_at: start,
          end_at: new Date(new Date(start).getTime() + e.minutes * 60 * 1000).toISOString(),
          is_all_day: false,
          location: 'Video call',
          organizer: DEMO_USER_EMAIL,
          attendees: [DEMO_USER_EMAIL, ...e.attendees],
          calendar_name: WORKSPACE_NAME,
          source: 'local_exchange',
          synced_at: new Date().toISOString(),
        }
      }),
      { onConflict: 'user_id,external_id' },
    ),
  )
}

async function seedDocuments(ctx: Ctx, projectId: string): Promise<void> {
  const { admin, workspaceId, memberId, teamId } = ctx
  const existing = check(
    'document',
    await admin.from('document').select('title').eq('workspace_id', workspaceId).contains('frontmatter', SEED),
  )
  const have = new Set((existing ?? []).map((d) => d.title as string))
  for (const [i, d] of DOCUMENTS.entries()) {
    if (have.has(d.title)) continue
    check(
      'document insert',
      await admin.from('document').insert({
        workspace_id: workspaceId,
        team_id: teamId,
        project_id: d.project ? projectId : null,
        title: d.title,
        content: d.content,
        created_by: memberId,
        last_edited_by: memberId,
        status: 'active',
        published_status: 'published',
        published_at: new Date().toISOString(),
        visibility: 'workspace',
        sort_order: i,
        frontmatter: SEED,
      }),
    )
  }
}

async function printSummary(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId } = ctx
  const count = async (label: string, q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await q
    if (error) throw new Error(`${label}: ${error.message}`)
    return n ?? 0
  }
  const head = { count: 'exact' as const, head: true }
  const captures = check('captures', await admin.from('captures').select('id').eq('workspace_id', workspaceId).contains('metadata', SEED))
  const captureIds = (captures ?? []).map((c) => c.id as string)
  const rows: [string, number][] = [
    ['tasks (actions)', await count('actions', admin.from('actions').select('id', head).eq('workspace_id', workspaceId).contains('context_data', SEED))],
    ['projects', await count('projects', admin.from('projects').select('id', head).eq('workspace_id', workspaceId).eq('name', PROJECT_NAME))],
    ['labels', await count('label', admin.from('label').select('id', head).eq('workspace_id', workspaceId).in('name', LABELS.map((l) => l.name)))],
    ['companies', await count('company', admin.from('company').select('id', head).eq('workspace_id', workspaceId).contains('metadata', SEED))],
    ['contacts', await count('contact', admin.from('contact').select('id', head).eq('workspace_id', workspaceId).contains('metadata', SEED))],
    ['timeline rows', await count('contact_interaction', admin.from('contact_interaction').select('id', head).eq('workspace_id', workspaceId).contains('metadata', SEED))],
    ['captures', captureIds.length],
    ['decisions', captureIds.length ? await count('decision', admin.from('decision').select('id', head).in('capture_id', captureIds)) : 0],
    ['capture attendees', captureIds.length ? await count('capture_participant', admin.from('capture_participant').select('id', head).in('capture_id', captureIds)) : 0],
    ['calendar events', await count('local_calendar_event', admin.from('local_calendar_event').select('id', head).eq('user_id', userId).like('external_id', 'demo-%'))],
    ['documents', await count('document', admin.from('document').select('id', head).eq('workspace_id', workspaceId).contains('frontmatter', SEED))],
    ['claims', await count('claim', admin.from('claim').select('id', head).eq('workspace_id', workspaceId).in('id', claimIds(workspaceId)))],
    ['claim sources', await count('claim_source', admin.from('claim_source').select('id', head).in('claim_id', claimIds(workspaceId)))],
    ['claim links', await count('entity_link', admin.from('entity_link').select('id', head).eq('workspace_id', workspaceId).eq('source_type', 'claim').in('source_id', claimIds(workspaceId)))],
  ]
  console.log(`demo workspace: ${WORKSPACE_NAME} (${workspaceId})`)
  console.log(`demo person:    ${DEMO_USER_EMAIL} (${userId})`)
  for (const [label, n] of rows) console.log(`  ${label.padEnd(18)} ${n}`)
}

/**
 * A one-time sign-in link for a local `next dev` (:3000, or --port). The magic-link
 * token comes from the service role (no email is sent); the app's
 * /auth/demo-link route redeems it, only under next dev, on localhost, for
 * the demo person. Supabase's own action_link isn't used: it would leave the
 * session in a URL fragment, which the app's PKCE sign-in doesn't accept.
 */
async function printLink(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DEMO_USER_EMAIL })
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink: ${error?.message ?? 'no token'}`)
  const link = new URL('/auth/demo-link', LOCAL_APP_ORIGIN)
  link.searchParams.set('token_hash', data.properties.hashed_token)
  console.log('')
  console.log(`sign in (one use; expires with the project's OTP expiry, an hour by default; needs next dev on ${LOCAL_APP_ORIGIN}):`)
  console.log(link.toString())
}

main().catch((err) => {
  console.error(`[demo-workspace] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
