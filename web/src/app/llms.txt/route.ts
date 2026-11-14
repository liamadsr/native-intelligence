// Serves /llms.txt — the emerging standard for giving LLMs and AI crawlers a
// concise, structured map of the site (https://llmstxt.org). The positioning
// prose is curated here; the Documentation and Blog sections are generated from
// the same Fumadocs loaders that feed the sitemap, so new content appears
// automatically instead of drifting out of date.

import { COMPETITORS, VS_COMPETITOR_SLUGS } from '@/data/vs-competitors'
import { hasDownload } from '@/lib/app-download'
import { blog, source } from '@/lib/source'
import { appUrl } from '@/lib/app-url'

const BASE = appUrl()

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

// The /vs pages, from the same data that builds them and the sitemap.
function comparisonsSection(): string {
  return VS_COMPETITOR_SLUGS.map((slug) => {
    const c = COMPETITORS[slug]
    return `- [${c.name} alternative for ${c.audience}](${BASE}/vs/${slug}): ${c.metaDescription}`
  }).join('\n')
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
  return `# Native Intelligence

> Native Intelligence is one workspace for a whole company, where meetings, mail, chat, docs, tasks and customers share one memory, and agents use that memory to do the busywork. Calls are captured by a desktop app, so no bot joins the meeting.

Native Intelligence brings a team's everyday tools into one app: email (Gmail and Outlook), team chat and calls, calendar and booking links, bot-free meeting capture with a live agent, tasks, projects and initiatives, docs, tables and files, and a CRM (companies, contacts, deals). Everything the team says and writes feeds a shared knowledge graph of decisions, commitments and facts, each with its source, so anyone can ask a question and get an answer drawn from calls, threads and documents at once. Agents act on that memory: they turn commitments into tasks, keep projects and customer records current, run flows on triggers (a new email, a channel message, a new document, a finished meeting, a schedule), and take on tasks such as writing code and opening a pull request. The workspace also includes a Studio for videos and ads and an SEO area, and the whole workspace is exposed over the Model Context Protocol (MCP). Web app plus a native macOS app for capture (Windows coming). Free 7-day trial (card required); Pro is $99 per user/month; every teammate gets their own 7-day trial, then their seat is paid. Teams and enterprises via sales for volume pricing.

## Key concepts

- **One workspace**: Mail, chat and calls, calendar, meetings, tasks and projects, docs and tables, and customers in one app, organized into workspaces and teams with roles.
- **Shared memory**: A knowledge graph built from the team's conversations and documents: decisions, commitments, open questions and facts, each with provenance.
- **Captures**: Call and meeting recordings with transcription, notes, and the tasks and decisions they produced. No bot joins the call; the desktop app records from the user's side.
- **Live agent**: An agent that listens during a call, looks things up in the workspace, answers questions in a heads-up display only the user sees, and stages next steps.
- **Tasks and projects**: Tasks with team-scoped identifiers (like ENG-42), custom workflow states, priorities and assignees, organized into projects and initiatives. Tasks can come from calls, email threads and chat messages.
- **Mail**: Gmail and Outlook in the workspace, with drafted replies, send later, and tasks from a thread.
- **Team chat and calls**: Channels, direct messages and calls for the team, with agents taking part.
- **Docs, tables and files**: Rich-text documents, user tables and files in one drive that agents can read and edit.
- **CRM**: Companies, contacts, deals and interaction history, filled in from calls. Two-way sync with HubSpot, Attio and Affinity, or use the built-in CRM.
- **Agents, skills and flows**: Agents with teachable skills, flows that run on triggers or schedules, and evals to test an agent before relying on it. Coding agents start with the full context of a task and open pull requests.
- **MCP and integrations**: Connect Gmail, Outlook, Google Calendar and Slack, or bring your own AI tools (Claude, ChatGPT, Cursor) to the workspace over MCP.

## Documentation

${docsSection()}

## Pages

- [Home](${BASE}): One workspace for the whole company: shared memory across meetings, mail, chat, docs, tasks and customers, and agents that do the busywork.
- [Pricing](${BASE}/pricing): 7-day free trial (card required), Pro, and Enterprise plans.
- [AI Work Environment](${BASE}/ai-work-environment): What an AI work environment is and how Native Intelligence implements one.
- [Blog](${BASE}/blog): Product updates and writing.
- [Release Notes](${BASE}/release-notes): What's new in Native Intelligence.

## Comparisons

${comparisonsSection()}

## Blog posts

${blogSection()}

## Get started

${hasDownload() ? `- [Download for macOS](${BASE}/api/download): Native desktop app.\n` : ''}- [Sign up](${BASE}): Create a workspace for your team.

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
