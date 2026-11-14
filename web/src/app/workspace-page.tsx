'use client'

/**
 * THE landing page, served at `/`: Native Intelligence as one workspace for a
 * whole company, where meetings, mail, chat, docs, tasks and customers share
 * one memory and agents act on it.
 *
 * It replaced the sales pitch (and the PostHog A/B switch that served it with
 * three other arms) on 2026-11-14, when the product stopped being positioned
 * as an AI sales platform. /meeting-notes and /company-brain still serve their
 * own pitches at their own routes.
 *
 * Deliberately light: every section is a heading plus a sentence or two, the
 * demos are the product's own components loaded only as they near the
 * viewport (components/landing/lazy-demos.tsx), and nothing is tied to the
 * scroll position. Entrance fades run once per element.
 *
 * NOTHING HERE CLAIMS WHAT THE PRODUCT LACKS. Every section maps to an area
 * that is live in production; Windows capture is named as coming, not here.
 *
 * SECTION IDS ARE A PUBLIC CONTRACT. The navbar's Features dropdown links to
 * `/#workspace`, `/#memory`, `/#agents`, `/#desktop` and `/#integrations`
 * (components/navbar.tsx), and PageLayout builds its rail from `sections`
 * below. Renaming an id silently breaks both.
 */

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { useSignupHref } from '@/components/signup-href'
import { PageLayout, type Section } from '@/components/page-layout'
import type { ChatDemoExchange } from '@/components/landing/chat-demo'
import type { StreamAction } from '@/components/landing/action-stream-demo'
import type { LiveAgentScenario } from '@/components/landing/live-agent-demo'
import {
  ActionStreamDemo,
  ChatDemo,
  CrmAutologDemo,
  ExecutionDemo,
  LiveAgentDemo,
} from '@/components/landing/lazy-demos'
import { IntelligenceLoopDemo } from '@/components/landing/intelligence-loop-demo'
import { WorkspaceGrid } from '@/components/landing/workspace-grid'
import {
  AffinityIcon,
  AttioIcon,
  GmailIcon,
  GoogleCalendarIcon,
  HubSpotIcon,
  OutlookIcon,
  SlackIcon,
} from '@/components/brand-icons'
import { isDesktopApp } from '@/lib/platform'
import { hasDownload } from '@/lib/app-download'
import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ChevronDown, Plug } from 'lucide-react'

export const sections: Section[] = [
  { id: 'hero', label: 'Native Intelligence' },
  { id: 'workspace', label: 'One Workspace' },
  { id: 'memory', label: 'Shared Memory' },
  { id: 'agents', label: 'Agents' },
  { id: 'desktop', label: 'Desktop App' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'faq', label: 'FAQ' },
  { id: 'cta', label: 'Get Started' },
]

// ─── Demo content (all FICTIONAL: made-up people and companies) ─────────────

// Questions answered from calls, mail, chat and docs at once: the point is
// that the answer cites where it came from, across places.
export const WORKSPACE_CHAT_EXCHANGES: ChatDemoExchange[] = [
  {
    ask: 'What did we agree with Northwind about the March delivery?',
    answer:
      'From Tuesday’s call with Lena Park and her email on Wednesday:\n\n- **Delivery moves to March 18**, a week later than planned\n- **200 units ship early**, on March 4\n- Lena wants **a revised invoice** before Friday\n\nPriya has the invoice on her task list, due Thursday.',
  },
  {
    ask: 'Where did we land on the new onboarding flow?',
    answer:
      'From Monday’s design review and the #product thread:\n\n- **Decided:** three steps instead of five, with the team invite last\n- **Open:** whether to ask for a calendar connection up front\n- **Spec:** Sarah updated *Onboarding v3* yesterday',
  },
]

// A planning call inside the company, not a sales call: the agent reads mail,
// a project and a doc, and stages the changes the call decided.
export const PLANNING_CALL_SCENARIO: LiveAgentScenario = {
  // The demo's footer reads "{agentName} agent".
  agentName: 'Meeting',
  title: 'Spring launch · weekly planning',
  conversation: [
    { speaker: 'Priya', text: 'Northwind just pushed their delivery to March 18.', isLocal: false },
    { speaker: 'You', text: 'Then the launch email can’t go out on the 10th.', isLocal: true },
    { speaker: 'Priya', text: 'Can we still get the first 200 units on the 4th?', isLocal: false },
    { speaker: 'You', text: 'That’s what Lena offered. I’ll confirm with her today.', isLocal: true },
    { speaker: 'Priya', text: 'Then let’s move the launch to the 20th.', isLocal: false },
    { speaker: 'You', text: 'Agreed. The onboarding doc needs the new dates too.', isLocal: true },
  ],
  toolCalls: [
    { label: 'Search mail', detail: 'query: "Northwind delivery"' },
    { label: 'Get project', detail: 'Spring launch · 6 open tasks' },
    { label: 'Propose change', detail: 'Create task: confirm the March 4 shipment' },
    { label: 'Propose change', detail: 'Launch date: Mar 10 → Mar 20' },
    { label: 'Read doc', detail: 'Onboarding v3 · 2 dates to update' },
  ],
  speakerPills: [
    { name: 'alex rivera', isLocal: true },
    { name: 'priya mehta', isLocal: false },
  ],
  notes: [
    'Northwind’s delivery moved to March 18; 200 units on March 4.',
    'Launch moves from March 10 to March 20.',
    'Onboarding v3 needs the new dates.',
  ],
  proposals: [
    { title: 'Confirm the March 4 partial shipment with Lena', kind: 'action', afterCall: 2 },
    { title: 'Move the spring launch to March 20', kind: 'decision', afterCall: 3 },
    { title: 'Update the dates in Onboarding v3', kind: 'action', afterCall: 4 },
  ],
}

// Tasks staged from every place work arrives, not only meetings. Assignees and
// due dates come from the demo's fixed set (see action-stream-demo.tsx).
export const WORKSPACE_TASKS: readonly StreamAction[] = [
  { id: 'w1', text: 'Send Northwind the revised invoice', project: 'Northwind', assignee: 'priya m.', priority: 'High', dueDate: 'Apr 17', source: { via: 'your inbox', title: 'Re: March delivery' } },
  { id: 'w2', text: 'Move the spring launch email to March 20', project: 'Spring launch', assignee: 'alex r.', priority: 'Medium', dueDate: 'Apr 18', source: { via: 'the meeting agent', title: 'Weekly planning' } },
  { id: 'w3', text: 'Write the help article for the new onboarding', project: 'Onboarding', assignee: 'sarah c.', priority: 'Medium', dueDate: 'Apr 22', source: { via: 'team chat', title: '#product' } },
  { id: 'w4', text: 'Book the venue walkthrough for the customer day', project: 'Customer day', assignee: 'jordan k.', priority: 'Low', dueDate: 'Apr 24', source: { via: 'your inbox', title: 'Venue options' } },
  { id: 'w5', text: 'Fix the export timeout Lena reported', project: 'Platform', assignee: 'marcus t.', priority: 'High', dueDate: 'Apr 19', source: { via: 'the meeting agent', title: 'Northwind check-in' } },
  { id: 'w6', text: 'Share the Q2 hiring plan with the leads', project: 'Hiring', assignee: 'alex r.', priority: 'Medium', dueDate: 'Apr 21', source: { via: 'team chat', title: '#leads' } },
]

// ─── Building blocks ────────────────────────────────────────────────────────

function SectionContainer({
  id,
  children,
  className,
  showDivider = true,
}: {
  id: string
  children: React.ReactNode
  className?: string
  showDivider?: boolean
}) {
  return (
    <section id={id} className={clsx('py-24 lg:py-32 relative', className)}>
      {showDivider && (
        <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
          <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
        </div>
      )}
      <div className="w-full px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </div>
    </section>
  )
}

/** A section's heading and lead, faded in once. */
function SectionIntro({ title, lead }: { title: React.ReactNode; lead: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      className="text-center"
    >
      <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl text-balance">{title}</h2>
      <p className="mt-6 mx-auto max-w-2xl text-lg text-muted-foreground">{lead}</p>
    </motion.div>
  )
}

// Copy and destination mirror the navbar's signup CTA ("Sign up free" →
// /login?mode=signup), so the page never shows two names for one action. At
// `/` the href carries no edition, so the new workspace gets the default one
// (DEFAULT_SIGNUP_EDITION in lib/editions/attribution.ts: the whole app).
function PrimaryCta({
  location,
  children = 'Sign up free',
  className,
}: {
  location: string
  children?: React.ReactNode
  className?: string
}) {
  const posthog = usePostHog()
  const signupHref = useSignupHref()
  return (
    <a
      href={signupHref}
      onClick={() => {
        posthog?.capture('cta_clicked', { location, type: 'sign_up' })
      }}
      className={clsx(
        'inline-flex items-center justify-center gap-2 py-3 px-7 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors',
        className
      )}
    >
      {children}
    </a>
  )
}

function DownloadCta({ location, primary = false }: { location: string; primary?: boolean }) {
  const posthog = usePostHog()
  if (!hasDownload()) return null
  return (
    <a
      href="/api/download"
      onClick={() => {
        posthog?.capture('cta_clicked', { location, type: 'download_macos' })
      }}
      className={clsx(
        'inline-flex items-center justify-center gap-2 py-3 px-7 text-base rounded-full whitespace-nowrap font-medium transition-colors',
        primary
          ? 'border border-transparent bg-primary shadow-md text-primary-foreground hover:bg-primary/90'
          : 'border border-border bg-background shadow-sm text-foreground hover:bg-accent'
      )}
    >
      Download for macOS
    </a>
  )
}

/** A heading, a sentence or two and a live demo, side by side on wide screens. */
function FeaturePanel({
  title,
  description,
  visual,
  flip = false,
}: {
  title: string
  description: string
  visual: React.ReactNode
  flip?: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      // No overflow-hidden and no `isolate`: the demos open absolutely
      // positioned popovers that must be able to escape the panel.
      className="rounded-3xl border border-border bg-secondary/50"
    >
      <div
        className={clsx(
          'grid items-center gap-8 lg:gap-12 p-6 sm:p-10 lg:grid-cols-2',
          flip && 'lg:[&>*:first-child]:order-2'
        )}
      >
        <div className="min-w-0">{visual}</div>
        <div className="max-w-md">
          <h3 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">{title}</h3>
          <p className="mt-4 text-lg text-muted-foreground">{description}</p>
        </div>
      </div>
    </motion.div>
  )
}

/** Small cards in a row: a title and one line each. */
function PointGrid({ points }: { points: { title: string; body: string }[] }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {points.map((point) => (
        <div key={point.title} className="rounded-2xl border border-border bg-secondary/30 p-6 text-left">
          <h3 className="font-medium text-foreground">{point.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{point.body}</p>
        </div>
      ))}
    </motion.div>
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section id="hero" className="relative flex flex-col">
      {/* Navbar positions itself (`fixed z-50`); wrapping it in a `relative
          z-10` div would trap it in this section's stacking context. */}
      <Navbar />

      <div className="relative z-10 flex flex-col items-center px-6 lg:px-8 pt-44 sm:pt-52 pb-24 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="font-display text-4xl/[1.08] font-medium tracking-tight text-foreground sm:text-6xl/[1.04] md:text-7xl/[1.0] max-w-5xl text-balance"
        >
          The workspace that remembers everything and does the busywork
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl text-pretty"
        >
          Meetings, mail, chat, docs, tasks and your customers share one memory.
          Agents read it, keep it tidy and take work off your plate.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-10 flex flex-col sm:flex-row items-center gap-3"
        >
          <PrimaryCta location="home_hero" />
          <DownloadCta location="home_hero" />
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.45 }}
          className="mt-6 text-sm text-muted-foreground"
        >
          For your whole team · No bots on your calls
        </motion.p>
      </div>
    </section>
  )
}

function WorkspaceSection() {
  return (
    <SectionContainer id="workspace">
      <SectionIntro
        title="One place for the whole company’s work"
        lead="The tools your team switches between all day, in one app that shares one memory, so nothing you learn in one place is lost to the others."
      />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="mt-14"
      >
        <WorkspaceGrid />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Also inside: a Studio for videos and ads, an SEO area for your website, and an MCP server for your own AI tools.
        </p>
      </motion.div>
    </SectionContainer>
  )
}

function MemorySection() {
  return (
    <SectionContainer id="memory">
      <div className="mb-16">
        <SectionIntro
          title="Everything your team says becomes something it knows"
          lead="Calls, threads, messages and docs feed one memory of what was decided, promised and learned, each fact with the place it came from."
        />
      </div>
      <div className="space-y-8">
        <FeaturePanel
          title="Ask your company anything"
          description="What did we promise Northwind? Where did the onboarding plan land? Get the answer from the call, the thread and the doc at once, with the sources."
          visual={<ChatDemo exchanges={WORKSPACE_CHAT_EXCHANGES} />}
        />
        <FeaturePanel
          flip
          title="Meetings that write themselves down"
          description="The desktop app captures your calls without a bot joining. An agent listens along, looks things up while you talk, and stages the tasks and decisions the call made."
          visual={<LiveAgentDemo scenario={PLANNING_CALL_SCENARIO} />}
        />
        <FeaturePanel
          title="A memory that keeps itself current"
          description="Nobody files anything. What your team says in calls, mail and chat becomes shared knowledge, and the work agents finish goes back in."
          visual={<IntelligenceLoopDemo />}
        />
      </div>
    </SectionContainer>
  )
}

function AgentsSection() {
  return (
    <SectionContainer id="agents">
      <div className="mb-16">
        <SectionIntro
          title="Agents that take work off your plate"
          lead="They start with everything your team knows, so you hand over the work, not a long explanation."
        />
      </div>
      <div className="space-y-8">
        <FeaturePanel
          title="Tasks that write themselves"
          description="Commitments made on a call, in an email or in a channel turn into tasks with an owner and a date. You glance at them instead of typing them up."
          visual={<ActionStreamDemo pool={WORKSPACE_TASKS} />}
        />
        <FeaturePanel
          flip
          title="Hand a task to an agent"
          description="Assign it like you would a teammate. The agent reads the meeting, the project and the code, does the work, and opens a pull request for review."
          visual={<ExecutionDemo />}
        />
        <FeaturePanel
          title="Customer records that fill themselves in"
          description="Notes, follow-ups and deal stages update after every call, so anyone can pick up an account and see what happened."
          visual={<CrmAutologDemo />}
        />
      </div>
      <PointGrid
        points={[
          {
            title: 'Flows on triggers',
            body: 'Run steps when mail arrives, a message lands in a channel, a doc is created, a meeting ends, or on a schedule.',
          },
          {
            title: 'Skills you can teach',
            body: 'Write down how your team does something once, and every agent can do it that way.',
          },
          {
            title: 'Tested before you trust them',
            body: 'Check an agent against saved examples before it runs on its own.',
          },
          {
            title: 'Bring your own AI',
            body: 'Claude, ChatGPT and Cursor can read and act on your workspace over MCP.',
          },
        ]}
      />
    </SectionContainer>
  )
}

function DesktopSection() {
  return (
    <SectionContainer id="desktop">
      <div className="text-center">
        <SectionIntro
          title="Nothing joins your calls"
          lead="The Mac app records from your side of the conversation, on any call you take on your computer."
        />
        <div className="mt-8 flex justify-center">
          <DownloadCta location="home_desktop" primary />
        </div>
      </div>
      <PointGrid
        points={[
          { title: 'No meeting bots', body: 'Zoom, Google Meet, Microsoft Teams, Webex, phone calls: nothing visible joins.' },
          { title: 'A heads-up when it starts', body: 'Get notified before a meeting, and start capturing in one click.' },
          { title: 'An agent on the call', body: 'Ask it something mid-call, and it answers from what your team knows.' },
          { title: 'Mac today, Windows next', body: 'The web app works anywhere. Windows capture is on the way.' },
        ]}
      />
    </SectionContainer>
  )
}

function IntegrationsSection() {
  const integrations = [
    { icon: <GmailIcon className="h-6 w-6" />, name: 'Gmail', body: 'Your mail in the workspace, with drafts written for you.' },
    { icon: <OutlookIcon className="h-6 w-6" />, name: 'Outlook', body: 'Microsoft mail and calendar, side by side with Google.' },
    { icon: <GoogleCalendarIcon className="h-6 w-6" />, name: 'Google Calendar', body: 'Every meeting linked to its notes and its people.' },
    { icon: <SlackIcon className="h-6 w-6" />, name: 'Slack', body: 'Talk to your agent and get its updates where your team already is.' },
    { icon: <HubSpotIcon className="h-6 w-6" />, name: 'HubSpot', body: 'Keep HubSpot, synced both ways, or use the built-in CRM.' },
    { icon: <AttioIcon className="h-6 w-6" />, name: 'Attio', body: 'Your Attio records kept current without data entry.' },
    { icon: <AffinityIcon className="h-6 w-6" />, name: 'Affinity', body: 'Interactions logged and relationships kept fresh.' },
    { icon: <Plug className="h-6 w-6 text-muted-foreground" />, name: 'MCP', body: 'Connect Claude, ChatGPT, Cursor and other AI tools to your workspace.' },
  ]

  return (
    <SectionContainer id="integrations">
      <SectionIntro
        title="Works with what you already use"
        lead="Move over all at once or one tool at a time. Native Intelligence connects to the apps your team keeps."
      />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="mt-14 mx-auto max-w-3xl divide-y divide-border"
      >
        {integrations.map((integration) => (
          <div key={integration.name} className="flex items-center gap-5 py-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
              {integration.icon}
            </span>
            <div className="min-w-0">
              <p className="font-medium text-foreground">{integration.name}</p>
              <p className="text-sm text-muted-foreground">{integration.body}</p>
            </div>
          </div>
        ))}
      </motion.div>
    </SectionContainer>
  )
}

export const FAQ_ITEMS = [
  {
    q: 'Do we have to move everything over at once?',
    a: 'No. Start with meetings or mail and add the rest when you’re ready. Mail, calendars, Slack and your CRM connect to what you already use.',
  },
  {
    q: 'Will a bot join our calls?',
    a: 'No. The Mac app records from your computer, so nothing visible ever joins the call. You can also record in the browser.',
  },
  {
    q: 'What can the agents do on their own?',
    a: 'Draft replies, turn commitments into tasks, keep projects and customer records current, run your flows, and take on tasks like writing code, which ends in a pull request for your team to review.',
  },
  {
    q: 'Who is it for?',
    a: 'Teams that run on meetings, mail and chat and are tired of copying what they learn from one tool into another: founders, operators, product and engineering teams, and the people who talk to customers.',
  },
  {
    q: 'Is our data used to train AI models?',
    a: 'No. Your conversations, documents, contacts and notes are never used to train AI models.',
  },
  {
    q: 'How much does it cost?',
    a: 'Start with a 7-day free trial (you add a card to begin, and pay nothing if you cancel before it ends), then pay per seat. The pricing page has the details.',
  },
]

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-5 text-left"
      >
        <span className="font-medium text-foreground">{q}</span>
        <ChevronDown
          className={clsx('h-5 w-5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && <p className="pb-5 text-muted-foreground">{a}</p>}
    </div>
  )
}

function FaqSection() {
  return (
    <SectionContainer id="faq">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-center text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
          Frequently asked questions
        </h2>
        <div className="mt-10">
          {FAQ_ITEMS.map((item) => (
            <FaqItem key={item.q} q={item.q} a={item.a} />
          ))}
        </div>
      </div>
    </SectionContainer>
  )
}

function CTASection() {
  return (
    <SectionContainer id="cta">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <h2 className="text-4xl font-medium tracking-tight text-foreground sm:text-5xl">
          Bring your team into one workspace.
          <br />
          <span className="text-muted-foreground">Try it free for 7 days.</span>
        </h2>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
          <PrimaryCta location="home_cta" />
          <a
            href="/pricing"
            className="inline-flex items-center justify-center gap-2 py-3 px-7 text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
          >
            See pricing
          </a>
        </div>
      </motion.div>
    </SectionContainer>
  )
}

/**
 * `roadmap` is the "What we're building" section, rendered on the server by
 * page.tsx (it reads GitHub) and passed in as a ready node. It sits after the
 * FAQ, just before the closing CTA, and renders nothing when there is nothing
 * to show.
 */
export default function WorkspacePage({ roadmap }: { roadmap?: React.ReactNode }) {
  const router = useRouter()

  // The desktop app's shell goes straight into the app. A pure side effect:
  // the page always renders (SSR included), so crawlers get the full HTML.
  useEffect(() => {
    if (isDesktopApp()) {
      router.replace('/login')
    }
  }, [router])

  return (
    <PageLayout sections={sections}>
      <Hero />
      <main>
        <WorkspaceSection />
        <MemorySection />
        <AgentsSection />
        <DesktopSection />
        <IntegrationsSection />
        <FaqSection />
        {roadmap}
        <CTASection />
      </main>
      <Footer />
    </PageLayout>
  )
}
