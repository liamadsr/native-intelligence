// Serves /llms.txt — the emerging standard for giving LLMs and AI crawlers a
// concise, structured map of the site (https://llmstxt.org). The positioning
// prose is curated here; the Documentation and Blog sections are generated from
// the same Fumadocs loaders that feed the sitemap, so new content appears
// automatically instead of drifting out of date.

import { hasDownload } from '@/lib/app-download'
import { blog, source } from '@/lib/source'

const BASE = 'https://dial8.ai'

function docsSection(): string {
  return source
    .getPages()
    .slice()
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((page) => {
      const desc = page.data.description ? `: ${page.data.description}` : ''
      return `- [${page.data.title}](${BASE}${page.url})${desc}`
    })
    .join('\n')
}

function blogSection(): string {
  return blog
    .getPages()
    .slice()
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime())
    .map((page) => {
      const desc = page.data.description ? `: ${page.data.description}` : ''
      return `- [${page.data.title}](${BASE}${page.url})${desc}`
    })
    .join('\n')
}

function buildLlmsTxt(): string {
  return `# Dial8

> Dial8 is the end-to-end AI sales platform. It turns everything a sales team knows — playbooks, product knowledge, competitors, pricing, deal history — into intelligence every rep can use live on the call, in a heads-up display only their side can see. No bot joins the meeting. Afterwards the CRM updates itself, follow-ups are queued, and what the call taught goes back into the team's shared context.

Dial8 combines live call intelligence, a self-updating CRM (contacts, companies, deals, interaction history), email sequences, meeting capture, Linear-style project management, and AI execution in one workspace (web app + native macOS and iOS apps, Windows waitlist). Live agents listen to calls and update deals, actions, and the knowledge base in real time. Every action item carries the full context of why it exists — the call it came from, the decision behind it, and who is responsible — so agents can execute with no prompt engineering. Syncs two-way with HubSpot, Attio, and Affinity for teams keeping their existing CRM. The entire workspace is exposed over the Model Context Protocol (MCP), so external agents and tools can read and act on your work. Free 7-day trial (card required); Pro is $99 per user/month; every teammate gets their own 7-day trial, then their seat is paid. Teams and enterprises via sales for volume pricing.

## Key concepts

- **Live Call Intelligence**: A live agent listens with the team's full shared context — playbooks, product knowledge, competitors, deal history — and surfaces the right piece during the call in a heads-up display only the rep can see.
- **Shared Context Packages**: Product knowledge, pricing, objection plays, battlecards, demo scripts, and playbooks packaged and shared across the team, so every rep sells with the same knowledge behind them.
- **Workspaces & Teams**: Multi-tenant workspaces with roles and team-scoped workflows.
- **Captures**: Call and meeting recordings with AI transcription, automatic action-item extraction, and decision tracking. No bot joins the call — the desktop app records from the rep's side.
- **Live Agents**: Agents that listen to conversations and update deals, projects, actions, and the knowledge base in real time.
- **Actions**: Tasks and issues with team-scoped identifiers (like ENG-42), custom workflow states, priorities, and assignees — including AI team members.
- **Projects & Initiatives**: Work organized into projects with milestones, rolled up under strategic initiatives.
- **AI Execution**: Action items can be handed to AI coding agents that start with full meeting context, write code, and open pull requests.
- **CRM & Sequences**: Contacts, companies, deals, interaction history, and voice identification — populated from your actual calls, with notes and deal stages updating themselves after each one. Email sequences for outbound. Two-way sync with HubSpot, Attio, and Affinity, or use the built-in CRM outright.
- **Email & Calendar**: Gmail/Outlook sync with AI-drafted replies; multi-provider calendar with meeting-to-capture linking.
- **MCP & Integrations**: Connect existing tools or bring your own agents; the full workspace is available via the Model Context Protocol.

## Documentation

${docsSection()}

## Pages

- [Home](${BASE}): The sales platform pitch — live call intelligence, self-updating CRM, and the team knowledge loop.
- [Pricing](${BASE}/pricing): 7-day free trial (card required), Pro, and Enterprise plans.
- [AI Work Environment](${BASE}/ai-work-environment): What an AI work environment is and how Dial8 implements one.
- [Blog](${BASE}/blog): Product updates and writing.
- [Release Notes](${BASE}/release-notes): What's new in Dial8.

## Comparisons

- [Dial8 vs Granola](${BASE}/vs/granola): How Dial8 compares to Granola for meeting notes.
- [Dial8 vs Fathom](${BASE}/vs/fathom): How Dial8 compares to Fathom for meeting recording.
- [Dial8 vs Otter](${BASE}/vs/otter): How Dial8 compares to Otter for transcription.
- [Dial8 vs Fireflies](${BASE}/vs/fireflies): How Dial8 compares to Fireflies for meeting capture.

## Blog posts

${blogSection()}

## Get started

${hasDownload() ? `- [Download for macOS](${BASE}/api/download): Native desktop app.\n` : ''}- [Sign up](${BASE}): Create a workspace and start capturing meetings.

## Links

- Website: ${BASE}
- Discord: https://discord.gg/sHtYGtkWga
- X/Twitter: https://x.com/Dial8_ai
`
}

export const dynamic = 'force-static'

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  })
}
