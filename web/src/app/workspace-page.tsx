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
 * THE ORDER IS THE ONE WELL-KNOWN PRODUCT PAGES SHARE: the words, then the
 * real product at once (the app's own screens, changing on a clock:
 * components/landing/product-showcase.tsx), then what makes it different
 * (the agent, with a day of its work: components/landing/hero-day.tsx), then
 * what it replaces, then each thing it does with a scene of it doing it, then
 * how to move in, the questions, what is being built, and the ask.
 *
 * EVERY SECTION SHOWS SOMETHING HAPPENING: the agent's day plays, its texts
 * arrive one at a time, the apps a team pays for add up beside our one price, each feature's
 * scene plays its workflow, and the lists arrive in turn. They share one motion personality
 * (components/landing/motion.ts), and each scene runs only while it is on
 * screen.
 *
 * Deliberately light, and one column down the middle: every feature is a
 * heading, a sentence or two, sometimes a teammate's message that sets the
 * scene, and then the product doing it. EVERY FEATURE IS SHOWN WITH THE APP
 * ITSELF, never a drawing of it: the product's own components, loaded only as
 * they near the viewport (components/landing/lazy-demos.tsx), or a real
 * screen of the app (public/screens). Nothing is tied to the scroll
 * position. Entrance fades run once per element.
 *
 * NOTHING HERE CLAIMS WHAT THE PRODUCT LACKS. Every section maps to an area
 * that is live in production; Windows capture is named as coming, not here.
 *
 * The page sits in the site's frame (components/site/site-shell.tsx): the
 * side panel that lists every page, and the right rail with this page's
 * sections. There is no bar across the top.
 *
 * SECTION IDS ARE A PUBLIC CONTRACT. The navbar's Features dropdown on the
 * other public pages links to `/#workspace`, `/#memory`, `/#agents`,
 * `/#desktop` and `/#integrations` (components/navbar.tsx), the side panel
 * links to some of them (lib/marketing/site-nav.ts), and the right rail is
 * built from `sections` below. Renaming an id silently breaks all three.
 */

import { Footer } from '@/components/footer'
import { useSignupHref } from '@/components/signup-href'
import { SiteShell } from '@/components/site/site-shell'
import { FaqList } from '@/components/site/faq'
import { SWITCHING_GUIDE } from '@/lib/marketing/site-nav'
import { DEFAULT_SELECTION, NI_PRICE_PER_SEAT, stackCost } from '@/lib/marketing/replace-apps'
import type { Section } from '@/components/page-layout'
import { ExecutionDemo, LiveAgentDemo } from '@/components/landing/lazy-demos'
import type { LiveAgentScenario } from '@/components/landing/live-agent-demo'
import { WorkspaceHub } from '@/components/landing/workspace-grid'
import { AppScreen } from '@/components/demo/app-screen'
import { HeroDay } from '@/components/landing/hero-day'
import { AgentTextThread } from '@/components/landing/agent-text-thread'
import { StackCalculator } from '@/components/site/stack-calculator'
import { ProductShowcase } from '@/components/landing/product-showcase'
import { GROUP, IN, MEMBER } from '@/components/landing/motion'
import { isDesktopApp } from '@/lib/platform'
import { hasDownload } from '@/lib/app-download'
import { clsx } from 'clsx'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { ArrowRight, AudioLines, Building2, Calendar, CalendarCheck, Mail, Map, Plug, ShieldCheck, Table2 } from 'lucide-react'

export const sections: Section[] = [
  { id: 'hero', label: 'Native Intelligence' },
  { id: 'always-on', label: 'Always-on Agent' },
  { id: 'workspace', label: 'One Workspace' },
  { id: 'memory', label: 'Shared Memory' },
  { id: 'agents', label: 'Agents' },
  { id: 'desktop', label: 'Desktop App' },
  { id: 'integrations', label: 'Moving In' },
  { id: 'faq', label: 'FAQ' },
  { id: 'cta', label: 'Get Started' },
]

// The right rail's "On this page": every section but the hero it starts on.
const OUTLINE = sections.filter((section) => section.id !== 'hero')

// ─── Demo content (FICTIONAL: made-up people and companies) ────────────────

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
    <section id={id} className={clsx('py-28 lg:py-40 relative', className)}>
      {showDivider && (
        <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
          <div className="h-px bg-linear-to-r from-transparent via-foreground/20 to-transparent" />
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
      <h2 className="text-4xl/[1.1] font-heading font-light tracking-[-0.02em] text-foreground sm:text-5xl/[1.08] lg:text-[3.5rem]/[1.06] text-balance">{title}</h2>
      <p className="mt-6 mx-auto max-w-2xl text-lg text-muted-foreground sm:text-xl text-pretty">{lead}</p>
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

/** A group's name and its one-line promise, above the features that deliver it. */
function GroupIntro({ label, promise }: { label: string; promise: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      className="text-center"
    >
      {/* The group's name on a rule across the page, so a new group reads as a new chapter. */}
      <div className="mx-auto flex max-w-3xl items-center gap-4">
        <span className="h-px flex-1 bg-linear-to-r from-transparent to-foreground/30" />
        <p className="rounded-full border border-foreground/20 bg-foreground/[0.05] px-4 py-1.5 font-mono text-xs/5 font-semibold uppercase tracking-widest text-foreground backdrop-blur-md">
          {label}
        </p>
        <span className="h-px flex-1 bg-linear-to-l from-transparent to-foreground/30" />
      </div>
      <p className="mt-6 mx-auto max-w-2xl font-heading text-2xl/9 font-light text-foreground text-balance sm:text-3xl/10">{promise}</p>
    </motion.div>
  )
}

interface TeammateAsk {
  /** A made-up teammate, like everyone else in the demos. */
  name: string
  text: string
}

/**
 * One feature, stacked down the middle of the page: the heading, a sentence or
 * two, optionally a teammate's message that sets the scene, the product doing
 * it, and where to read more.
 */
function FeatureStage({
  title,
  description,
  ask,
  visual,
  links = [],
}: {
  title: string
  description: string
  ask?: TeammateAsk
  visual: React.ReactNode
  links?: { label: string; href: string }[]
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      className="mx-auto max-w-2xl"
    >
      <div className="text-center">
        <h2 className="text-3xl/[1.12] font-heading font-light tracking-[-0.02em] text-foreground sm:text-4xl/[1.1] lg:text-[2.75rem]/[1.08] text-balance">{title}</h2>
        <p className="mt-4 mx-auto max-w-xl text-lg text-muted-foreground text-pretty">{description}</p>
      </div>

      {ask && (
        <div className="mt-10 flex items-end justify-end gap-3">
          <div className="max-w-md text-right">
            <p className="mb-1.5 text-xs text-muted-foreground">{ask.name}</p>
            <p className="inline-block rounded-2xl rounded-br-md border border-border bg-secondary/60 px-4 py-2.5 text-left text-[15px]/6 text-foreground">
              {ask.text}
            </p>
          </div>
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground"
          >
            {ask.name.split(' ').map((part) => part[0]).join('')}
          </span>
        </div>
      )}

      <div className={clsx('min-w-0', ask ? 'mt-5' : 'mt-10')}>{visual}</div>

      {links.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
              <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
      )}
    </motion.div>
  )
}

/** Small cards in a row: a title and one line each. */
function PointGrid({ points }: { points: { title: string; body: string }[] }) {
  return (
    <motion.div
      variants={GROUP}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: '-100px' }}
      className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {points.map((point) => (
        <motion.div key={point.title} variants={MEMBER} className="rounded-2xl border border-border bg-secondary/30 p-6 text-left">
          <h3 className="font-medium text-foreground">{point.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{point.body}</p>
        </motion.div>
      ))}
    </motion.div>
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────

// What a visitor can check for themselves before signing up. Facts about the
// product and the company, each true today; no customer logos, counts or
// quotes until there are real ones to show.
const HERO_FACTS = [
  { icon: AudioLines, text: 'Captures every call on your Mac' },
  { icon: ShieldCheck, text: 'Your data never trains AI' },
  { icon: Map, text: 'Public roadmap' },
  { icon: CalendarCheck, text: `7 days free, then $${NI_PRICE_PER_SEAT} a seat` },
]

// THE HERO IS THE WORDS AND THEN THE PRODUCT. A short headline, one sentence,
// the two buttons, and directly under them the real app, large enough to cut
// the fold, so the first screen already shows what this is. The picture of
// the agent's day (components/landing/hero-day.tsx) explains the agent, so it
// leads the section about the agent instead.
function Hero() {
  return (
    <section id="hero" className="relative flex flex-col">
      <div className="relative z-10 flex flex-col items-center px-6 lg:px-8 pt-14 sm:pt-20 pb-24 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: IN }}
          className="text-[2.75rem]/[1.08] font-heading font-light tracking-[-0.02em] text-foreground sm:text-6xl/[1.06] lg:text-[4.25rem]/[1.05] max-w-4xl text-balance"
        >
          An agent that drafts your replies, writes up your calls and updates your CRM
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: IN }}
          className="mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl text-pretty"
        >
          It can, because Native Intelligence is the app that work lives in: your team’s mail, chat,
          meetings, docs, tasks and customers. It works day and night, and nothing is sent until you say yes, in the app or by text.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.16, ease: IN }}
          className="mt-9 flex flex-col sm:flex-row items-center gap-3"
        >
          <PrimaryCta location="home_hero" />
          <DownloadCta location="home_hero" />
        </motion.div>

        <motion.ul
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
        >
          {HERO_FACTS.map(({ icon: Icon, text }) => (
            <li key={text} className="inline-flex items-center gap-1.5">
              <Icon aria-hidden className="h-3.5 w-3.5" />
              {text}
            </li>
          ))}
        </motion.ul>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.3, ease: IN }}
          className="mt-10 w-full max-w-5xl"
        >
          <ProductShowcase />
        </motion.div>
      </div>
    </section>
  )
}

// The four things that make the agent more than a chat box. Each sentence is
// how the product behaves today (lib/work/agent-memory.ts, lib/work/
// auto-attempt.ts, lib/kept-up-to-date, lib/reach, lib/sms/approvals.ts).
const ALWAYS_ON_POINTS = [
  {
    title: 'Learns your work',
    body: 'After each call, thread and finished task it writes down what it learned, like a customer’s new deadline or how you word a follow-up. You can read the list and delete anything that’s wrong.',
  },
  {
    title: 'Does the first pass',
    body: 'The reply is drafted when the email arrives. The notes are written when the call ends. Tasks and customer records change when the work does.',
  },
  {
    title: 'Texts you',
    body: 'When you’re away from the app, it texts your phone. Routine things wait until morning. Text it back, or call its number and talk it through.',
  },
  {
    title: 'Asks before it sends',
    body: 'A change inside your workspace comes with an undo. Sending an email, deleting something or acting outside the workspace waits for your yes, in the app or by text.',
  },
]

function AlwaysOnSection() {
  return (
    <SectionContainer id="always-on">
      <SectionIntro
        title="An always-on agent"
        lead="At 07:50 a customer emails to move a delivery. The reply is drafted before you open your laptop. Here is one day of its work, on a made-up team."
      />
      {/* One of its days, from the first email to the night shift. */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5, ease: IN }}
        className="mt-20 sm:mt-24"
      >
        <HeroDay />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="mt-24"
      >
        <AgentTextThread />
        <motion.ul
          variants={GROUP}
          initial="hidden"
          whileInView="shown"
          viewport={{ once: true, margin: '-100px' }}
          className="mx-auto mt-20 grid max-w-4xl gap-x-14 gap-y-10 text-left sm:grid-cols-2"
        >
          {ALWAYS_ON_POINTS.map((point) => (
            <motion.li key={point.title} variants={MEMBER}>
              <h3 className="text-xl font-medium text-foreground">{point.title}</h3>
              <p className="mt-2 text-lg text-muted-foreground text-pretty">{point.body}</p>
            </motion.li>
          ))}
        </motion.ul>
      </motion.div>
      <div className="mt-12 flex justify-center">
        <Link href="/features/agents" className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Learn about agents
          <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </SectionContainer>
  )
}

// The calculator's opening selection, as one sentence: what those apps cost a
// seat, from the same table the calculator reads (lib/marketing/replace-apps.ts).
const DEFAULT_STACK_PER_SEAT = Math.round(stackCost(new Set(DEFAULT_SELECTION), 1).appsPerSeat)
const DEFAULT_STACK_COUNT = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][DEFAULT_SELECTION.length] ?? String(DEFAULT_SELECTION.length)
const DEFAULT_STACK_NAMES = `${DEFAULT_SELECTION.slice(0, -1).join(', ')} and ${DEFAULT_SELECTION[DEFAULT_SELECTION.length - 1]}`

function WorkspaceSection() {
  return (
    <SectionContainer id="workspace">
      <SectionIntro
        title={`One subscription instead of ${DEFAULT_STACK_COUNT}`}
        lead={`${DEFAULT_STACK_NAMES} come to $${DEFAULT_STACK_PER_SEAT} a seat each month. Native Intelligence does those jobs for $${NI_PRICE_PER_SEAT}. Pick the apps you pay for and see your own number.`}
      />
      <div className="mt-14">
        <StackCalculator />
      </div>

      <div className="mt-24 lg:mt-32">
        <WorkspaceHub />
        <p className="mt-12 text-center text-sm text-muted-foreground">
          Also inside: a Studio for videos and ads, an SEO area for your website, and an MCP server for your own AI tools.
        </p>
      </div>
    </SectionContainer>
  )
}

function MemorySection() {
  return (
    <SectionContainer id="memory">
      <GroupIntro
        label="Shared memory"
        promise="What’s said on a call, in an email, in chat or in a doc goes into one memory. Every fact links back to where it was said."
      />
      <div className="mt-20 space-y-28 lg:space-y-36">
        <FeatureStage
          title="Search and ask"
          description="Ask what you agreed with a customer about March. The answer names the call and the email it came from."
          visual={<AppScreen screen="chat" />}
          links={[{ label: 'Learn about agents', href: '/features/agents' }]}
        />
        <FeatureStage
          title="Meeting notes"
          description="Record any call from your Mac: Zoom, Meet, Teams or the phone. The notes, the decisions and the next steps are written when you hang up."
          ask={{ name: 'Priya Mehta', text: 'Did anyone take notes on the planning call? I need the new launch date.' }}
          visual={<LiveAgentDemo scenario={PLANNING_CALL_SCENARIO} tools={false} />}
          links={[
            { label: 'Learn about meetings', href: '/features/meetings' },
            { label: 'Learn about the desktop app', href: '/features/desktop-app' },
          ]}
        />
        <FeatureStage
          title="Knowledge graph"
          description="Every customer, person, call, doc and task is linked to the others. Agents read those links before they act, so you don’t have to brief them."
          visual={
            // The app's own Knowledge map, as it looks on a made-up studio's workspace.
            <img
              src="/screens/knowledge-graph-window.webp"
              alt="The knowledge graph: what the workspace knows, clustered around its clients, people, meetings, documents and tasks"
              width={1256}
              height={783}
              loading="lazy"
              decoding="async"
              className="h-auto w-full rounded-2xl shadow-2xl ring-1 ring-foreground/10"
            />
          }
        />
      </div>
    </SectionContainer>
  )
}

function AgentsSection() {
  return (
    <SectionContainer id="agents">
      <GroupIntro
        label="Agents"
        promise="Hand an agent a task the way you’d hand it to a teammate who sat in on every call."
      />
      <div className="mt-20 space-y-28 lg:space-y-36">
        <FeatureStage
          title="Tasks from conversations"
          description="When someone says “I’ll have it by Tuesday” on a call, in mail or in chat, it becomes a task with their name and the date on it. Plan the tasks in projects and cycles."
          ask={{ name: 'Sarah Chen', text: 'I’ll write the help article for the new onboarding by Tuesday.' }}
          visual={<AppScreen screen="list" />}
          links={[
            { label: 'Learn about tasks', href: '/features/tasks' },
            { label: 'Learn about flows', href: '/features/flows' },
          ]}
        />
        <FeatureStage
          title="Coding agent"
          description="Assign a bug to the coding agent. It reads the task and your code, writes the fix and opens a pull request for your team to review."
          ask={{ name: 'Marcus Tran', text: 'Can an agent take the export timeout Lena reported? I’ll review the pull request.' }}
          visual={<ExecutionDemo />}
          links={[{ label: 'Learn about coding', href: '/features/coding' }]}
        />
        <FeatureStage
          title="CRM without data entry"
          description="A company or contact is added the first time they email or call. After each conversation the notes and the deal stage are updated, and you can undo any change."
          ask={{ name: 'Jordan Kim', text: 'I’m picking up Larkspur Coffee next week. What do we know about Maya?' }}
          visual={
            // The app itself, opened on a made-up customer's record (components/demo/app-screen.tsx).
            <AppScreen screen="contact" />
          }
          links={[{ label: 'Learn about the CRM', href: '/features/crm' }]}
        />
      </div>
      <PointGrid
        points={[
          {
            title: 'Flows on triggers',
            body: 'Run steps when mail arrives, a message lands in a channel, a doc is created, a meeting ends, or on a schedule.',
          },
          {
            title: 'Skills',
            body: 'Write down once how your team does something, like a weekly report. Every agent then does it that way.',
          },
          {
            title: 'Evals',
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
  const points = [
    { title: 'Every call app', body: 'Zoom, Google Meet, Microsoft Teams, Webex and phone calls are all recorded the same way.' },
    { title: 'Meeting alerts', body: 'A reminder before each meeting, with a button that starts recording.' },
    { title: 'Live agent', body: 'Ask it something mid-call, and it answers from what your team knows.' },
    { title: 'Mac today, Windows next', body: 'The web app works anywhere. Windows capture is on the way.' },
  ]
  return (
    <SectionContainer id="desktop">
      <div className="text-center">
        <SectionIntro
          title="Desktop app"
          lead="The Mac app records any call from your own computer. Ask it a question during the call and it answers from what your team knows."
        />
        <div className="mt-8 flex justify-center">
          <DownloadCta location="home_desktop" primary />
        </div>
      </div>
      <div className="mt-16 grid items-center gap-12 lg:grid-cols-2">
        {/* The real call window, from the app. */}
        <motion.img
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5, ease: IN }}
          src="/screens/live-call.webp"
          alt="The call window during a meeting: the speakers, the meeting’s goal, three items it captured with an Add button, and the live assistant answering a question"
          width={954}
          height={1069}
          loading="lazy"
          decoding="async"
          className="mx-auto h-auto w-full max-w-md"
        />
        <motion.ul variants={GROUP} initial="hidden" whileInView="shown" viewport={{ once: true, margin: '-100px' }} className="space-y-8 text-left">
          {points.map((point) => (
            <motion.li key={point.title} variants={MEMBER}>
              <h3 className="text-lg font-medium text-foreground">{point.title}</h3>
              <p className="mt-2 text-muted-foreground text-pretty">{point.body}</p>
            </motion.li>
          ))}
        </motion.ul>
      </div>
    </SectionContainer>
  )
}

// The section keeps the id `integrations` (the navbar and the side panel link
// to it), but it is about moving IN, not plugging in: the page's claim is
// that this is the one app, so nothing here says "keep your other tools".
function IntegrationsSection() {
  const integrations = [
    { icon: <Mail className="h-5 w-5 text-foreground" />, name: 'Your email', body: 'Sign in with Google or Microsoft and every account is in one inbox.' },
    { icon: <Calendar className="h-5 w-5 text-foreground" />, name: 'Your calendar', body: 'It comes with the same sign-in, every meeting linked to its notes and its people.' },
    { icon: <Building2 className="h-5 w-5 text-foreground" />, name: 'Your customers', body: 'Bring companies and contacts over from HubSpot or a spreadsheet.' },
    { icon: <Table2 className="h-5 w-5 text-foreground" />, name: 'Your spreadsheets', body: 'Import CSV and Excel files into tables your agents can read and keep current.' },
    { icon: <Plug className="h-5 w-5 text-foreground" />, name: 'Your AI tools', body: 'Claude, ChatGPT and Cursor connect over MCP and work on the same workspace.' },
  ]

  return (
    <SectionContainer id="integrations">
      <SectionIntro
        title="Switch from your stack"
        lead="Sign in with Google or Microsoft and your mail and calendar are there. Import your customers from HubSpot or a spreadsheet. Start with one piece and move the rest when you’re ready."
      />
      <motion.div
        variants={GROUP}
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, margin: '-100px' }}
        className="mt-14 mx-auto max-w-3xl divide-y divide-border"
      >
        {integrations.map((integration) => (
          <motion.div key={integration.name} variants={MEMBER} className="flex items-center gap-5 py-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
              {integration.icon}
            </span>
            <div className="min-w-0">
              <p className="text-lg font-medium text-foreground">{integration.name}</p>
              <p className="text-muted-foreground">{integration.body}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>
      <div className="mt-10 flex justify-center">
        <Link href={SWITCHING_GUIDE} className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Read the switching guide
          <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </SectionContainer>
  )
}

export const FAQ_ITEMS = [
  {
    q: 'Do we have to move everything over at once?',
    a: 'No. Start with mail or meetings and bring the rest over as you go. Your email and calendar come with you when you sign in with Google or Microsoft, and your customers and spreadsheets import in a few minutes.',
  },
  {
    q: 'Will a bot join our calls?',
    a: 'No. The Mac app records from your own computer, so the call looks the same to everyone on it. You can also record in the browser.',
  },
  {
    q: 'What can the agents do on their own?',
    a: 'They draft replies, turn what people promise into tasks, update projects and customer records, and run your flows. They also take on whole tasks, like a code fix that ends in a pull request for your team to review. Sending an email or deleting something waits for your yes.',
  },
  {
    q: 'Who is it for?',
    a: 'Small teams that spend the day in meetings, mail and chat, then copy what was said into a tracker and a CRM. That’s founders, operators, product and engineering teams, and anyone who talks to customers.',
  },
  {
    q: 'Is our data used to train AI models?',
    a: 'No. Your conversations, documents, contacts and notes are never used to train AI models.',
  },
  {
    q: 'How much does it cost?',
    a: `$${NI_PRICE_PER_SEAT} per seat per month, after a 7-day free trial. You add a card to start, and pay nothing if you cancel before the trial ends. The pricing page has the details.`,
  },
]

function FaqSection() {
  return (
    <SectionContainer id="faq">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-center text-4xl/[1.08] font-heading font-light tracking-[-0.02em] text-foreground sm:text-5xl/[1.06]">
          Questions
        </h2>
        <div className="mt-10">
          <FaqList items={FAQ_ITEMS} />
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
        <h2 className="text-4xl/[1.1] font-heading font-light tracking-[-0.02em] text-foreground sm:text-5xl/[1.08] lg:text-6xl/[1.06] text-balance">
          Try it on tomorrow’s inbox and calls.
          <br />
          <span className="text-muted-foreground">7 days free, then ${NI_PRICE_PER_SEAT} a seat.</span>
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
    <SiteShell outline={OUTLINE}>
      <Hero />
      <main>
        <AlwaysOnSection />
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
    </SiteShell>
  )
}
