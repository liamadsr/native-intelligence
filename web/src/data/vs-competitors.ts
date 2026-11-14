/**
 * Data module powering the /vs/[competitor] comparison pages.
 *
 * The pages are written for sales teams choosing a tool, and each one targets the
 * search people actually type ("granola alternative", "otter ai alternative").
 *
 * Every factual cell about a vendor was checked against that vendor's own
 * published material (product pages, pricing pages, help centers, changelogs) in
 * November 2026; each entry's `verifiedAt` says when, and the page prints it.
 * Prices and plan names drift: re-check them before editing a cell.
 *
 * Honesty rules baked into this data:
 *  - Credit what each vendor genuinely does well, in `theirStrengths`.
 *  - State tier limits, betas and add-ons ("Business plan", "labeled beta").
 *    Never call something missing that the vendor ships on a higher plan.
 *  - Where a capability could not be found in published material, say what the
 *    vendor does offer rather than asserting a gap.
 *  - Our own price and trial come from the billing constants, so they cannot
 *    drift from what checkout charges.
 */
import { SEAT_PRICE_USD, TRIAL_DAYS } from '@/lib/billing/access'

// /vs/gong was retired on 2026-11-14 with the sales positioning: it 308s to
// the homepage (next.config.mjs). The four notetaker comparisons stay until
// they are rewritten for the workspace position.
export const VS_COMPETITOR_SLUGS = [
  'granola',
  'otter',
  'fireflies',
  'fathom',
] as const

export type CompetitorSlug = (typeof VS_COMPETITOR_SLUGS)[number]

/** A matrix cell. `true` = has it, `false` = doesn't, string = nuanced note. */
export type Cell = boolean | string

export interface MatrixRow {
  /** Human-readable capability, used as the row header (<th scope="row">). */
  feature: string
  /** Optional clarifying line under the feature name. */
  detail?: string
  ni: Cell
  competitor: Cell
}

export interface Faq {
  q: string
  a: string
}

export interface Competitor {
  slug: CompetitorSlug
  /** Display name, e.g. "Granola". */
  name: string
  /** Their homepage, for an honest outbound reference. */
  site: string
  /** Who the page is for, ending in "sales teams": the H1 reads "The {name} alternative for {audience}". */
  audience: string
  /** Month and year the vendor facts were last checked, e.g. "November 2026". */
  verifiedAt: string
  /** One-line description of what they are, used in the subhead. */
  tagline: string
  /** SEO title: "{Name} Alternative for … | Native Intelligence", at most 60 characters. */
  metaTitle: string
  /** SEO description, 70 to 160 characters. */
  metaDescription: string
  /** 2–3 sentence honest verdict. First sentence credits them. */
  verdict: string
  /** The comparison matrix rows (competitor column): price, platforms and capture live here. */
  matrix: MatrixRow[]
  /** Honest bullets — what the competitor genuinely does better. */
  theirStrengths: { title: string; body: string }[]
  /** FAQ rendered on-page and as FAQPage JSON-LD. */
  faqs: Faq[]
}

// Native Intelligence's own facts. Reused as the left column across every comparison so
// the story stays consistent; the price and trial come from billing.
const NI = {
  // Compact form used inside the comparison matrix price cell.
  startingPriceShort: `${TRIAL_DAYS}-day trial, then $${SEAT_PRICE_USD}/user/mo`,
  platforms: 'macOS + iOS apps, plus web (Windows waitlist)',
}

/** Our seat price in prose: "$99 per seat a month". */
const SEAT = `$${SEAT_PRICE_USD} per seat a month`

// Rows that describe Native Intelligence and are identical across every competitor. The
// competitor cell is filled in per-vendor below.
type SharedRowKey =
  | 'botFree'
  | 'liveHelp'
  | 'dealHistory'
  | 'crm'
  | 'crmSync'
  | 'followUps'
  | 'playbook'
  | 'transcripts'
  | 'platforms'
  | 'price'

const NI_ROW: Record<SharedRowKey, { feature: string; detail?: string; ni: Cell }> = {
  botFree: {
    feature: 'Bot-free capture',
    detail: 'No bot joins the call as a participant',
    ni: true,
  },
  liveHelp: {
    feature: 'Live help during the call',
    detail: 'Your playbook, pricing and battlecards on screen while you talk, visible only to you',
    ni: true,
  },
  dealHistory: {
    feature: 'Ask about any deal’s history',
    detail: 'What was promised, what is blocking and what happens next',
    ni: true,
  },
  crm: {
    feature: 'CRM that updates itself after calls',
    detail: 'Notes, next steps and deal stages, with no data entry',
    ni: true,
  },
  crmSync: {
    feature: 'Works with your CRM',
    ni: 'Built-in CRM, two-way HubSpot sync, Attio and Affinity',
  },
  followUps: {
    feature: 'Follow-up emails drafted for you',
    ni: true,
  },
  playbook: {
    feature: 'One shared sales playbook',
    detail: 'Product, pricing, objections and battlecards, shared with every rep',
    ni: true,
  },
  transcripts: {
    feature: 'Transcripts and AI summaries',
    ni: true,
  },
  platforms: {
    feature: 'Platforms',
    ni: NI.platforms,
  },
  price: {
    feature: 'Starting price',
    ni: NI.startingPriceShort,
  },
}

function row(key: SharedRowKey, competitor: Cell): MatrixRow {
  const base = NI_ROW[key]
  return { feature: base.feature, detail: base.detail, ni: base.ni, competitor }
}

// What Native Intelligence does for the rep on the call. Shared across pages, and the
// same claims the home page makes.
export const NI_STRENGTHS: { title: string; body: string }[] = [
  {
    title: 'Help on the call, not just notes after it',
    body: 'A live agent listens with your product, pricing, playbook and the customer’s history, and brings the right piece into a panel only you can see, while you are still talking.',
  },
  {
    title: 'A CRM that fills itself in',
    body: 'Notes, next steps and deal stages update the moment you hang up, in the built-in CRM or two-way with HubSpot. Your pipeline stays current because your team is already talking to customers.',
  },
  {
    title: 'Every deal’s history, one question away',
    body: 'New rep on the account? Ask what was promised, what is blocking and what happens next, drawn from every call and email your team has had.',
  },
  {
    title: 'One shared playbook for the whole team',
    body: 'Product knowledge, pricing, objection plays and battlecards live in one shared package, so every rep sells with what your best rep knows.',
  },
]

export const COMPETITORS: Record<CompetitorSlug, Competitor> = {
  granola: {
    slug: 'granola',
    name: 'Granola',
    site: 'https://www.granola.ai',
    audience: 'sales teams',
    verifiedAt: 'November 2026',
    tagline: 'the polished, bot-free AI notepad for meetings',
    metaTitle: 'Granola Alternative for Sales Teams | Native Intelligence',
    metaDescription:
      'A Granola alternative for sales: bot-free calls like Granola, plus live help while you talk and a CRM that updates itself after every call.',
    verdict:
      'Granola is one of the best-made notetakers there is: capture without a bot on every major platform, notes that feel effortless, a chat that knows your meetings, and Briefs that remind you who you are meeting and what you discussed last time. It is built around the note. Native Intelligence is built around the sale: help on screen while you talk, every deal’s history one question away, and a CRM that updates its own fields when you hang up, instead of a note you share by hand.',
    matrix: [
      row('botFree', true),
      row('liveHelp', 'Ask its chat a question mid-meeting'),
      row('dealHistory', 'Chat across meetings by person or company'),
      row('crm', 'Notes shared to HubSpot by hand, or via Zapier'),
      row('crmSync', 'HubSpot, Attio, Affinity (Business); Salesforce (Enterprise)'),
      row('followUps', true),
      row('playbook', 'Shared team notes and templates'),
      row('transcripts', true),
      row('platforms', 'Mac, Windows, iOS, Android, Apple Watch'),
      row('price', 'Free, then $14/user/mo (Business)'),
    ],
    theirStrengths: [
      {
        title: 'Craft and polish',
        body: 'Granola is one of the best-designed notetakers on the market. The notes feel effortless, and capture without a bot is a nicer experience than a bot joining your call.',
      },
      {
        title: 'On every device',
        body: 'Granola runs on Mac, Windows, iPhone, Android and Apple Watch. Native Intelligence covers macOS, iOS and the web, with Windows on a waitlist.',
      },
      {
        title: 'Briefs before you start',
        body: 'When you open a meeting’s note, Granola shows who you are meeting and what you discussed last time.',
      },
      {
        title: 'A much lower price',
        body: 'Granola has a free plan, and Business is $14 per user a month. If you only need excellent notes, that is hard to argue with.',
      },
    ],
    faqs: [
      {
        q: 'Does Granola use a meeting bot?',
        a: 'No. Like Native Intelligence, Granola records your microphone and system audio on your device, so nothing joins the call.',
      },
      {
        q: 'Can Granola help me during a sales call?',
        a: 'You can ask Granola’s chat a question mid-meeting, such as what you missed. Native Intelligence’s live agent follows the call and puts the right piece of your playbook, pricing or battlecards on your screen without being asked.',
      },
      {
        q: 'Does Granola update my CRM?',
        a: 'Granola connects to HubSpot, Attio and Affinity on its Business plan (Salesforce on Enterprise), and you share a note to HubSpot by hand; its HubSpot integration does not map custom fields. Native Intelligence updates notes, next steps and deal stages itself after each call, in its own CRM or two-way with HubSpot.',
      },
      {
        q: 'Which should I choose?',
        a: 'If you want the most polished notes on every device at a low price, choose Granola. If you sell for a living and want help on the call and a CRM that keeps itself current, choose Native Intelligence.',
      },
    ],
  },

  otter: {
    slug: 'otter',
    name: 'Otter.ai',
    site: 'https://otter.ai',
    audience: 'sales teams',
    verifiedAt: 'November 2026',
    tagline: 'the established transcription platform, now with sales features',
    metaTitle: 'Otter.ai Alternative for Sales Teams | Native Intelligence',
    metaDescription:
      'An Otter.ai alternative for sales teams: live help on every call, deal history on request, and a CRM that updates itself, with no bot joining.',
    verdict: `Otter.ai is a mature, widely used platform with excellent transcription, apps on every platform, and a Live Assist feature that shows reps private tip cards from their own playbooks and battlecards during a call. Live Assist and Otter’s sales notetaker are Enterprise features. Native Intelligence puts live help, every deal’s history and a CRM that updates itself into one seat at ${SEAT}, and records every call from your Mac without a bot.`,
    matrix: [
      row('botFree', 'Bot-free through its Mac and Windows apps; a bot for web meetings'),
      row('liveHelp', 'Live Assist tip cards from your playbooks (Enterprise only)'),
      row('dealHistory', 'AI chat across meetings, capped per plan'),
      row('crm', 'Syncs call notes to Salesforce and HubSpot (user limits by plan)'),
      row('crmSync', 'Salesforce, HubSpot (Pro and up, with user limits)'),
      row('followUps', true),
      row('playbook', 'Playbooks and battlecards power Live Assist (Enterprise)'),
      row('transcripts', true),
      row('platforms', 'Mac, Windows, web, iOS, Android, Chrome'),
      row('price', 'Free, then $16.99/user/mo (Pro, monthly)'),
    ],
    theirStrengths: [
      {
        title: 'Broad platform coverage',
        body: 'Otter runs on Mac, Windows, web, iOS, Android and Chrome. Native Intelligence covers macOS, iOS and the web (Windows is waitlist-only), so if your reps use Windows or Android today, Otter reaches further.',
      },
      {
        title: 'Mature, reliable transcription',
        body: 'Otter has been doing real-time transcription for years, with strong live captions and speaker identification and a large, established user base.',
      },
      {
        title: 'Live Assist for enterprise teams',
        body: 'Otter’s Live Assist shows reps private, real-time tip cards drawn from their uploaded playbooks and battlecards, inside Zoom, Meet, Teams or its desktop app. It is the closest match to our live panel, on Otter’s Enterprise plan.',
      },
    ],
    faqs: [
      {
        q: 'Does Otter.ai use a meeting bot?',
        a: 'For web meetings, yes: the Otter Notetaker joins Zoom, Teams and Meet as a participant. Its Mac and Windows desktop apps can also record without a bot. Native Intelligence records every call from your Mac, so nothing joins.',
      },
      {
        q: 'Can Otter help me during a sales call?',
        a: 'Yes, on its Enterprise plan: Live Assist shows private tip cards from your playbooks and battlecards. In Native Intelligence, live help comes with every seat: your playbook, pricing and battlecards on screen while you talk, visible only to you.',
      },
      {
        q: 'Does Otter update my CRM?',
        a: 'Otter integrates with Salesforce and HubSpot and syncs call notes there, with user limits by plan. Native Intelligence updates notes, next steps and deal stages after every call, in its own CRM or two-way with HubSpot.',
      },
      {
        q: 'Which should I choose?',
        a: `For transcription on every platform, or an enterprise rollout with Live Assist, Otter is a solid choice. For a small team that wants live help, deal history and a self-updating CRM in one seat at ${SEAT}, choose Native Intelligence.`,
      },
    ],
  },

  fireflies: {
    slug: 'fireflies',
    name: 'Fireflies.ai',
    site: 'https://fireflies.ai',
    audience: 'sales teams',
    verifiedAt: 'November 2026',
    tagline: 'the integration-rich meeting assistant',
    metaTitle: 'Fireflies Alternative for Sales Teams | Native Intelligence',
    metaDescription:
      'A Fireflies.ai alternative for sales teams: no bot in your calls, your playbook on screen while you talk, and a CRM that updates itself.',
    verdict: `Fireflies.ai is a capable meeting assistant with the broadest ecosystem here, more than 240 integrations, and sales features on its Business plan: Autofill drafts for your CRM, Deal Intelligence for HubSpot and Salesforce, and Sales Assist answers from your knowledge base during calls. Most of that sits on Business, and Sales Assist needs its bot in the call. Native Intelligence records every call without a bot, puts your playbook on screen while you talk, and updates the CRM itself, in one seat at ${SEAT}.`,
    matrix: [
      row('botFree', 'Bot by default; its desktop app and Chrome extension skip it'),
      row('liveHelp', 'Live Assist on paid plans; Sales Assist on bot calls (Business)'),
      row('dealHistory', 'Ask about a deal via Deal Intelligence (Business)'),
      row('crm', 'Autofill drafts CRM updates for the rep to review (Business)'),
      row('crmSync', 'Salesforce, HubSpot, Zoho and others; no CRM of its own'),
      row('followUps', 'Drafted from templates with AI Skills (Business)'),
      row('playbook', 'An uploaded knowledge base feeds Sales Assist (Business)'),
      row('transcripts', true),
      row('platforms', 'Mac, Windows, web, iOS, Android, Chrome'),
      row('price', 'Free, then $18/user/mo (Pro, monthly)'),
    ],
    theirStrengths: [
      {
        title: 'A huge integration catalog',
        body: 'Fireflies lists more than 240 integrations, including Salesforce, HubSpot and Zoho. If your work already lives in many tools, that breadth is a real advantage.',
      },
      {
        title: 'Broad platform and conferencing coverage',
        body: 'Fireflies works across Zoom, Meet, Teams and Webex, with Mac and Windows apps, mobile apps and a Chrome extension.',
      },
      {
        title: 'Deal questions on Business',
        body: 'On its Business plan, Deal Intelligence lets reps ask about a specific HubSpot or Salesforce deal, and Autofill drafts the CRM update for review.',
      },
    ],
    faqs: [
      {
        q: 'Does Fireflies.ai use a meeting bot?',
        a: 'By default, yes: the Fred bot joins your calendar meetings. Its desktop app and Chrome extension can record without a bot, but those recordings keep no audio or speaker labels. Native Intelligence records every call from your Mac, so nothing joins.',
      },
      {
        q: 'Can Fireflies help me during a sales call?',
        a: 'Fireflies offers Live Assist on paid plans, and on Business, Sales Assist answers questions from your knowledge base during calls its bot attends. Native Intelligence’s live agent puts your playbook, pricing and battlecards on your screen during any call, without a bot.',
      },
      {
        q: 'Does Fireflies update my CRM?',
        a: 'On its Business plan, Autofill drafts field updates for HubSpot or Salesforce that the rep reviews and sends. Native Intelligence updates notes, next steps and deal stages itself after every call, in its own CRM or two-way with HubSpot.',
      },
      {
        q: 'Which should I choose?',
        a: 'If you want the widest set of integrations and are fine with a bot in your calls, Fireflies is a strong fit. If you want help on every call and a CRM that keeps itself current, without a bot, choose Native Intelligence.',
      },
    ],
  },

  fathom: {
    slug: 'fathom',
    name: 'Fathom',
    site: 'https://www.fathom.ai',
    audience: 'sales teams',
    verifiedAt: 'November 2026',
    tagline: 'the AI notetaker with a generous free plan and CRM sync, now part of Superhuman',
    metaTitle: 'Fathom Alternative for Sales Teams | Native Intelligence',
    metaDescription:
      'A Fathom alternative for sales teams: no bot on any call, your playbook on screen while you talk, and a CRM that updates itself after every call.',
    verdict: `Fathom is a strong, generous notetaker, now part of Superhuman: a usable free plan, clean summaries and follow-up emails, and on its Business plan a Deal View that gathers every call on a HubSpot or Salesforce deal with an AI summary and field sync. It joins calls with a bot by default, and its live help today is a running summary, with real-time coaching announced. Native Intelligence records every call without a bot, puts your playbook on screen while you talk, and updates the CRM after each call, in one seat at ${SEAT}.`,
    matrix: [
      row('botFree', 'Bot by default; bot-free on Mac'),
      row('liveHelp', 'Live summaries on Mac; real-time coaching announced'),
      row('dealHistory', 'Deal View and Ask Fathom on a deal (Business)'),
      row('crm', 'Summaries pushed to your CRM; field sync on Business only'),
      row('crmSync', 'HubSpot, Salesforce, Planhat; no CRM of its own'),
      row('followUps', true),
      row('playbook', 'Scorecards against your sales method (Business)'),
      row('transcripts', true),
      row('platforms', 'Web and Mac'),
      row('price', 'Free, then $20/user/mo (Premium, monthly)'),
    ],
    theirStrengths: [
      {
        title: 'A genuinely generous free plan',
        body: 'Fathom’s free plan records and transcribes your calls, with limits on its AI features. For a solo rep who mostly wants recordings, that is hard to beat.',
      },
      {
        title: 'Deal View for HubSpot and Salesforce',
        body: 'On the Business plan, Fathom gathers every call on a deal into one page with an AI deal summary, and syncs fields into HubSpot and Salesforce.',
      },
      {
        title: 'A lower entry price',
        body: 'Premium is $20 per user a month ($16 billed annually), and Business is $34 ($25 billed annually).',
      },
    ],
    faqs: [
      {
        q: 'Does Fathom use a meeting bot?',
        a: 'By default, yes: a bot joins your call. On Mac, Fathom also offers capture without a bot. Native Intelligence records every call from your Mac, so nothing joins.',
      },
      {
        q: 'Can Fathom help me during a sales call?',
        a: 'Fathom shows a running summary on Mac during the call and has announced real-time coaching. Native Intelligence’s live agent puts your playbook, pricing and battlecards on your screen while you talk, visible only to you.',
      },
      {
        q: 'Does Fathom update my CRM?',
        a: 'Fathom pushes call summaries to HubSpot and Salesforce, and syncs CRM fields on its Business plan. Native Intelligence updates notes, next steps and deal stages after every call, in its own CRM or two-way with HubSpot.',
      },
      {
        q: 'Which should I choose?',
        a: 'For a generous notetaker with a free plan and HubSpot or Salesforce sync, Fathom is a strong pick. For help during the call and a CRM that keeps itself current, with no bot, choose Native Intelligence.',
      },
    ],
  },
}

/** The listed vendor for a slug; never an inherited property ("constructor", "toString"). */
export function getCompetitor(slug: string): Competitor | undefined {
  return Object.hasOwn(COMPETITORS, slug) ? COMPETITORS[slug as CompetitorSlug] : undefined
}
