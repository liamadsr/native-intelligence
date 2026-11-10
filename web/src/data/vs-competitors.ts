/**
 * Data module powering the /vs/[competitor] comparison pages.
 *
 * Every factual cell here was verified against each vendor's published
 * material in July 2026. Where a vendor's capability is nuanced (e.g. a
 * competitor extracts action items but only pushes them to an external tool),
 * the copy says so explicitly rather than overclaiming. Prices are quoted as
 * "per their published pricing" and can drift — keep the `verifiedAt` note in
 * mind when editing.
 *
 * Honesty rules baked into this data:
 *  - We never claim a competitor lacks transcription, summaries, or capture.
 *  - We acknowledge each competitor's genuine strengths in `theirStrengths`.
 *  - The differentiator rows are precise: "a real task tracker (identifiers,
 *    boards, cycles)" and "agents that execute (code, PRs, docs)" — not vague
 *    claims that competitors have "no tasks" or "no agents."
 */

export const VS_COMPETITOR_SLUGS = [
  'granola',
  'fathom',
  'otter',
  'fireflies',
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
  /** One-line description of what they are, used in the subhead. */
  tagline: string
  /** SEO title — kept short. */
  metaTitle: string
  /** SEO description ~150 chars. */
  metaDescription: string
  /** 2–3 sentence honest verdict. First sentence credits them. */
  verdict: string
  /** Their published starting price, quoted conservatively. */
  startingPrice: string
  /** Platforms they run on, as verified. */
  platforms: string
  /** How they capture audio (bot vs bot-free), as verified. */
  capture: string
  /** The comparison matrix rows (competitor column). */
  matrix: MatrixRow[]
  /** Honest bullets — what the competitor genuinely does better. */
  theirStrengths: { title: string; body: string }[]
  /** FAQ rendered on-page and as FAQPage JSON-LD. */
  faqs: Faq[]
}

// Native Intelligence's own facts, verified against pricing/page copy in this repo. Reused as
// the left column across every comparison so the story stays consistent.
const NI = {
  startingPrice: '14-day free trial, then $99 per user / month (Pro)',
  // Compact form used inside the comparison matrix price cell.
  startingPriceShort: '14-day trial, then $99/user/mo',
  platforms: 'macOS + iOS apps, plus web (Windows waitlist)',
  capture: 'Bot-free — the desktop app captures audio locally; nothing joins the call',
}

// Rows that describe Native Intelligence and are identical across every competitor. The
// competitor cell is filled in per-vendor below.
type SharedRowKey =
  | 'botFree'
  | 'transcription'
  | 'summaries'
  | 'taskTracker'
  | 'liveProjects'
  | 'crm'
  | 'executingAgents'
  | 'mcp'
  | 'emailDrafting'
  | 'knowledgeGraph'
  | 'platforms'
  | 'price'

const NI_ROW: Record<SharedRowKey, { feature: string; detail?: string; ni: Cell }> = {
  botFree: {
    feature: 'Bot-free capture',
    detail: 'No bot joins the call as a participant',
    ni: true,
  },
  transcription: {
    feature: 'Live transcription',
    ni: true,
  },
  summaries: {
    feature: 'AI summaries',
    ni: true,
  },
  taskTracker: {
    feature: 'Action items become tracked work',
    detail: 'A real task system with identifiers, boards, and cycles',
    ni: true,
  },
  liveProjects: {
    feature: 'Projects that update from conversations',
    ni: true,
  },
  crm: {
    feature: 'Self-updating CRM from calls',
    ni: true,
  },
  executingAgents: {
    feature: 'AI agents that execute',
    detail: 'Agents that write code, open PRs, and draft docs',
    ni: true,
  },
  mcp: {
    feature: 'Workspace exposed over MCP',
    detail: 'Bring your own agents; connect external MCP servers',
    ni: true,
  },
  emailDrafting: {
    feature: 'Email drafting',
    ni: true,
  },
  knowledgeGraph: {
    feature: 'Persistent knowledge-graph memory',
    detail: 'Facts, decisions, and commitments accumulate with provenance',
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

// What Native Intelligence argues it does that notetakers stop short of. Shared across pages
// because the structural difference is the same regardless of competitor.
export const NI_STRENGTHS: { title: string; body: string }[] = [
  {
    title: 'Meetings become tracked work, not just notes',
    body: 'Action items land in a real task system — identifiers like ENG-42, boards, workflow states, and cycles — so follow-ups are worked, not just written down and forgotten in a summary.',
  },
  {
    title: 'Projects and CRM stay current on their own',
    body: 'Conversations update project status and contact history automatically. Your CRM fills itself in from calls instead of waiting for someone to log it after the fact.',
  },
  {
    title: 'Agents that actually do the work',
    body: 'Native Intelligence hands actions to AI agents that execute — writing code, opening pull requests, drafting documents — with the full context of the meeting that created the task.',
  },
  {
    title: 'One knowledge graph, open over MCP',
    body: 'Every meeting, doc, and email feeds a persistent knowledge graph you can search, and the whole workspace is exposed over MCP so you can point your own agents at it.',
  },
]

export const COMPETITORS: Record<CompetitorSlug, Competitor> = {
  granola: {
    slug: 'granola',
    name: 'Granola',
    site: 'https://www.granola.ai',
    tagline: 'the polished, bot-free AI notepad for meetings',
    metaTitle: 'Native Intelligence vs Granola: notes vs. work that ships (2026)',
    metaDescription:
      'Granola takes beautiful bot-free meeting notes. Native Intelligence turns those meetings into tracked tasks, live projects, a self-updating CRM, and agents that execute.',
    verdict:
      'Granola is genuinely excellent at what it does: bot-free, beautifully designed AI notes that feel effortless, plus an AI chat that already knows your meetings, and integrations that push into tools like HubSpot and Attio. The difference is architectural. In Granola the meeting output is a note and a chat you export from; with Native Intelligence the meeting output is the tracker — action items become tracked tasks with identifiers and boards, projects and a native CRM update themselves, and agents pick up the work, all in the same system.',
    startingPrice: 'Free, then $14 per user / month (Business, monthly), per their published pricing (July 2026)',
    platforms: 'macOS desktop app, with a mobile app for phone calls',
    capture: 'Bot-free — captures audio locally, like Native Intelligence',
    matrix: [
      row('botFree', true),
      row('transcription', true),
      row('summaries', true),
      row('taskTracker', 'Notes and chat only — no built-in task tracker'),
      row('liveProjects', false),
      row('crm', 'Integrations (HubSpot, Attio, Affinity) — not a native CRM'),
      row('executingAgents', 'AI chat that answers; does not execute work'),
      row('mcp', 'MCP integration on Business+'),
      row('emailDrafting', 'Via templates and integrations'),
      row('knowledgeGraph', false),
      row('platforms', 'macOS + mobile'),
      row('price', 'Free, then $14/user/mo (Business, monthly)'),
    ],
    theirStrengths: [
      {
        title: 'Craft and polish',
        body: 'Granola is one of the best-designed notetakers on the market. The notes feel effortless, and the bot-free capture is a genuinely nicer experience than a bot dialing into your call.',
      },
      {
        title: 'A polished mobile app',
        body: 'Granola’s mobile app for in-person and phone conversations is mature and widely used. Native Intelligence ships an iOS app as well, but Granola’s mobile experience has had longer to bake.',
      },
      {
        title: 'A focused, mature note-and-chat product',
        body: 'If all you want is excellent notes plus a chat that knows your meetings, Granola does exactly that without the surface area of a full work system.',
      },
    ],
    faqs: [
      {
        q: 'Does Granola create tasks from meetings?',
        a: 'Granola extracts and organizes notes and lets you chat with them, but it does not have a built-in task tracker with identifiers, boards, and cycles. It relies on integrations to push items into other tools. Native Intelligence turns action items into tracked work inside the same system.',
      },
      {
        q: 'Does Native Intelligence use a meeting bot?',
        a: 'No. Like Granola, Native Intelligence captures audio locally through its macOS desktop app — nothing joins your call as a participant.',
      },
      {
        q: 'Can Granola update my project status or CRM automatically?',
        a: 'Granola focuses on notes and chat and integrates with tools like HubSpot and Attio, but it does not maintain live projects or a self-updating CRM. In Native Intelligence, conversations update project status and contact history on their own.',
      },
      {
        q: 'Which should I choose?',
        a: 'If you want the most polished bot-free notepad and chat, Granola is a great pick. If you want meetings to feed a task system, live projects, a CRM, and agents that execute the work, that is what Native Intelligence is built for.',
      },
    ],
  },

  fathom: {
    slug: 'fathom',
    name: 'Fathom',
    site: 'https://www.fathom.ai',
    tagline: 'the free-friendly AI notetaker with strong CRM sync',
    metaTitle: 'Native Intelligence vs Fathom: notes vs. executed work (2026)',
    metaDescription:
      'Fathom is a generous AI notetaker with clean CRM sync. Native Intelligence turns meetings into tracked tasks, live projects, a native CRM, and agents that execute the work.',
    verdict:
      'Fathom is a genuinely strong notetaker — a usable free tier, clean AI summaries, action items, follow-up emails, reliable CRM syncing into HubSpot and Salesforce, and action-item push into task tools like Asana. The difference is architectural: those are exports out of a notes product. With Native Intelligence the meeting output is the tracker — the same meeting becomes tracked tasks with identifiers and boards, projects and a native CRM stay current on their own, and actions go to agents that execute — all in one system, with nothing to route into afterward.',
    startingPrice: 'Free tier, then Premium at $20/user/mo (monthly), per their published pricing (July 2026)',
    platforms: 'Web plus a Mac desktop app; bot-free capture is in beta on Mac',
    capture: 'Bot by default, with bot-free capture in beta on Mac',
    matrix: [
      row('botFree', 'Bot by default; bot-free in beta on Mac'),
      row('transcription', true),
      row('summaries', true),
      row('taskTracker', 'Action items in notes, pushed to tools like Asana — no native tracker'),
      row('liveProjects', false),
      row('crm', 'CRM syncing (HubSpot, Salesforce) — not a native CRM'),
      row('executingAgents', 'Meeting assistant answers; does not execute work'),
      row('mcp', 'ChatGPT and Claude integrations; not an MCP workspace'),
      row('emailDrafting', 'AI follow-up emails (Premium+)'),
      row('knowledgeGraph', false),
      row('platforms', 'Web + Mac'),
      row('price', 'Free, then $20/user/mo (monthly)'),
    ],
    theirStrengths: [
      {
        title: 'A genuinely generous free plan',
        body: 'Fathom offers unlimited recordings and transcripts on its free tier with a monthly cap on AI summaries. For solo users who mostly want recordings and transcripts, that is hard to beat.',
      },
      {
        title: 'Solid CRM syncing',
        body: 'Fathom syncs call notes and fields into HubSpot and Salesforce cleanly, with deal and customer views on higher tiers. If your workflow lives in an existing CRM, that sync is well done.',
      },
      {
        title: 'Follow-up emails and coaching',
        body: 'AI-drafted follow-up emails and call-coaching metrics are strong for sales teams that want polish on outbound and rep feedback.',
      },
    ],
    faqs: [
      {
        q: 'Does Fathom create tasks from meetings?',
        a: 'Fathom extracts AI action items into your notes, can send follow-up emails, and pushes action items into task tools like Asana, but it does not include its own built-in task tracker with identifiers, boards, and cycles. Native Intelligence turns action items into tracked work inside the same system, with nothing to route into afterward.',
      },
      {
        q: 'Does Fathom use a meeting bot?',
        a: 'By default Fathom sends a visible bot to join your call, though it has a bot-free capture mode in beta on Mac. Native Intelligence is bot-free by design — its desktop app captures audio locally and nothing joins the call.',
      },
      {
        q: 'Does Native Intelligence sync to my CRM like Fathom?',
        a: 'Native Intelligence has a native CRM that updates itself from calls — contacts, companies, and interaction history — rather than only syncing fields into a third-party CRM. If you are committed to HubSpot or Salesforce, Fathom’s sync is a strength.',
      },
      {
        q: 'Which should I choose?',
        a: 'For a generous notetaker with clean CRM sync, Fathom is a strong pick. If you want meetings to become tracked tasks, live projects, and work that agents execute, Native Intelligence is built for that loop.',
      },
    ],
  },

  otter: {
    slug: 'otter',
    name: 'Otter.ai',
    site: 'https://otter.ai',
    tagline: 'the established transcription platform with sales agents',
    metaTitle: 'Native Intelligence vs Otter.ai: transcripts vs. tracked work (2026)',
    metaDescription:
      'Otter.ai is a mature transcription platform with sales agents. Native Intelligence turns meetings into tracked tasks, live projects, a CRM, and agents that execute.',
    verdict:
      'Otter.ai is a mature, widely adopted platform with excellent live transcription, broad app coverage, and a growing suite of domain agents like its SDR and sales notetaker agents. Where it differs from Native Intelligence is scope. Otter is built around the transcript and specialized sales workflows; Native Intelligence is built around the whole loop — turning any meeting into tracked tasks with identifiers and boards, keeping projects and CRM current, and running general agents that execute code, PRs, and docs.',
    startingPrice: 'Free (300 min/mo), then Pro at $16.99/user/mo (monthly), per their published pricing (July 2026)',
    platforms: 'macOS, Windows, web, iOS, Android, and a Chrome extension',
    capture: 'Uses a meeting bot (OtterPilot) that joins Zoom, Teams, and Meet',
    matrix: [
      row('botFree', 'Uses the OtterPilot bot to join calls'),
      row('transcription', true),
      row('summaries', true),
      row('taskTracker', 'Action items in notes — no built-in task tracker'),
      row('liveProjects', false),
      row('crm', 'Salesforce / HubSpot integrations — not a native CRM'),
      row('executingAgents', 'Sales/SDR agents (narrow domain); no code/PR/doc agents'),
      row('mcp', false),
      row('emailDrafting', 'Via AI chat and agents'),
      row('knowledgeGraph', false),
      row('platforms', 'Mac, Windows, web, iOS, Android'),
      row('price', 'Free, then $16.99/user/mo (monthly)'),
    ],
    theirStrengths: [
      {
        title: 'Broad platform coverage',
        body: 'Otter runs on Mac, Windows, web, iOS, Android, and Chrome. Native Intelligence covers macOS, iOS, and web (Windows is waitlist-only), so if you need Windows or Android today, Otter’s reach is wider.',
      },
      {
        title: 'Mature, reliable transcription',
        body: 'Otter has been doing real-time transcription for years, with strong live-caption and speaker-identification features and a large, established user base.',
      },
      {
        title: 'Domain sales agents',
        body: 'Otter ships specialized agents — an autonomous SDR agent that runs live demos and qualifies leads, plus a sales notetaker. For website lead-gen and sales workflows specifically, those are real capabilities.',
      },
    ],
    faqs: [
      {
        q: 'Does Otter.ai create tasks from meetings?',
        a: 'Otter surfaces action items in its notes and offers sales-focused agents, but it does not include a built-in task tracker with identifiers, boards, and cycles. Native Intelligence turns action items into tracked work in the same system.',
      },
      {
        q: 'Does Native Intelligence use a meeting bot like Otter?',
        a: 'No. Otter uses the OtterPilot bot, which joins your Zoom, Teams, or Meet call as a participant. Native Intelligence captures audio locally through its desktop app — nothing joins the call.',
      },
      {
        q: 'Otter has AI agents — how is Native Intelligence different?',
        a: 'Otter’s agents are domain-specific for sales — running demos, qualifying leads, and taking sales notes. Native Intelligence’s agents are general executors: they take an action from a meeting and write code, open pull requests, or draft documents with the full meeting context.',
      },
      {
        q: 'Which should I choose?',
        a: 'For broad platform coverage, mature transcription, and sales-agent workflows, Otter is a solid choice. If you want meetings to become tracked tasks, live projects, a self-updating CRM, and general agents that execute, that is Native Intelligence.',
      },
    ],
  },

  fireflies: {
    slug: 'fireflies',
    name: 'Fireflies.ai',
    site: 'https://fireflies.ai',
    tagline: 'the integration-rich meeting assistant with a bot',
    metaTitle: 'Native Intelligence vs Fireflies.ai: notes vs. tracked work (2026)',
    metaDescription:
      'Fireflies.ai is an integration-rich meeting assistant. Native Intelligence turns meetings into tracked tasks, live projects, a native CRM, and agents that execute.',
    verdict:
      'Fireflies.ai is a capable, integration-heavy meeting assistant — unlimited transcription and summaries, an action-item feature, AskFred search, and a deep catalog of integrations that push tasks into tools like Asana, Jira, and Trello. The structural difference is where the work lives. Fireflies extracts items and hands them off to other systems; Native Intelligence keeps the whole loop in one place — tracked tasks with identifiers and boards, live projects, a native CRM that updates from calls, and agents that execute the work.',
    startingPrice: 'Free, then Pro at $10/user/mo (billed annually), per their published pricing (July 2026)',
    platforms: 'macOS, Windows, web, iOS, Android, and a Chrome extension',
    capture: 'Uses the Fred bot to auto-join calendar meetings',
    matrix: [
      row('botFree', 'Uses the Fred bot to join calls'),
      row('transcription', true),
      row('summaries', true),
      row('taskTracker', 'Action items pushed to Asana/Jira/Trello — no native tracker'),
      row('liveProjects', false),
      row('crm', 'CRM integrations — not a native CRM'),
      row('executingAgents', 'AskFred / voice agents answer; do not execute work'),
      row('mcp', false),
      row('emailDrafting', 'Via AI outputs and integrations'),
      row('knowledgeGraph', false),
      row('platforms', 'Mac, Windows, web, iOS, Android'),
      row('price', 'Free, then $10/user/mo (billed annually; more month-to-month)'),
    ],
    theirStrengths: [
      {
        title: 'A deep integration catalog',
        body: 'Fireflies connects to an enormous range of tools and can push action items into Asana, Jira, Trello, Monday, and more. If your work already lives in those tools, that breadth is a real advantage.',
      },
      {
        title: 'Broad platform and conferencing coverage',
        body: 'Fireflies works across Zoom, Meet, Teams, and Webex, with mobile apps and a Chrome extension. Its reach across meeting platforms is wide.',
      },
      {
        title: 'Search and analytics across meetings',
        body: 'AskFred search, smart topics, and conversation intelligence on higher tiers give sales and research teams strong ways to mine past calls.',
      },
    ],
    faqs: [
      {
        q: 'Does Fireflies.ai create tasks from meetings?',
        a: 'Fireflies extracts action items and can push them into external tools like Asana, Jira, and Trello, but it does not have a built-in task tracker with identifiers, boards, and cycles. Native Intelligence keeps the tracked task system inside the same product.',
      },
      {
        q: 'Does Fireflies use a meeting bot?',
        a: 'Yes. Fireflies uses the Fred bot, which auto-joins your calendar meetings as a participant. Native Intelligence is bot-free — its desktop app captures audio locally and nothing joins the call.',
      },
      {
        q: 'Fireflies integrates with my PM tools — why would I want Native Intelligence’s tracker?',
        a: 'Integrations move an item into another system where it lives separately from the meeting. Native Intelligence keeps the task, the meeting that created it, the project it belongs to, and the agent that can execute it in one connected workspace.',
      },
      {
        q: 'Which should I choose?',
        a: 'If you want the widest set of integrations and to keep work in your existing PM tools, Fireflies is a strong fit. If you want meetings to become tracked work, live projects, a CRM, and executed output in one system, choose Native Intelligence.',
      },
    ],
  },
}

export function getCompetitor(slug: string): Competitor | undefined {
  return (COMPETITORS as Record<string, Competitor>)[slug]
}
