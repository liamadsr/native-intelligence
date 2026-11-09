'use client'

/**
 * THE landing page — Native Intelligence's lead marketing pitch, served at `/`.
 *
 * One plain-terms headline, short feature panels, a desktop-app section,
 * integrations, FAQ, one repeated CTA, framed around the intelligence layer
 * for a sales organization: what the team knows becomes shared context, the
 * live agent brings it into the call, and every call feeds new knowledge back.
 * Deliberately light on copy — every section is a heading plus one or two
 * sentences.
 *
 * It is one of four landing variants behind the `landing-page-variant` flag at
 * `/` (alongside meeting-notes, company-brain, and the original classic page).
 * The sales pivot retired the other three and they were later restored from
 * git history, but the flag holds them at 0%, so `/` renders this page for
 * everyone, and it is the fallback for every unresolved flag state. See
 * ./landing-variant-switch.tsx.
 *
 * SECTION IDS ARE A PUBLIC CONTRACT. The navbar's Features dropdown links to
 * `/#features`, `/#team`, `/#integrations`, and `/#desktop` (see
 * components/navbar.tsx), and PageLayout builds its rail from `sections`
 * below. Renaming an id silently breaks both.
 */

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { useSignupHref } from '@/components/signup-href'
import { PageLayout, type Section } from '@/components/page-layout'
import { EarlyAccessForm } from '@/components/early-access-form'
import type { ChatDemoExchange } from '@/components/landing/chat-demo'
import { ChatDemo, ContextPackageDemo, CrmAutologDemo, HudTipsDemo, LiveAgentDemo } from '@/components/landing/lazy-demos'
import { IntelligenceLoopDemo } from '@/components/landing/intelligence-loop-demo'
import type { LiveAgentScenario } from '@/components/landing/live-agent-demo'
import {
  GoogleCalendarIcon,
  GmailIcon,
  OutlookIcon,
  SlackIcon,
  HubSpotIcon,
  AttioIcon,
  AffinityIcon,
} from '@/components/brand-icons'
import { isDesktopApp } from '@/lib/platform'
import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ChevronDown, Plug } from 'lucide-react'
import { hasDownload } from '@/lib/app-download'

const sections: Section[] = [
  { id: 'hero', label: 'NI for Sales' },
  { id: 'features', label: 'Features' },
  { id: 'team', label: 'For Teams' },
  { id: 'desktop', label: 'Desktop App' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'faq', label: 'FAQ' },
  { id: 'cta', label: 'Get Started' },
]

// The live-agent widget aimed at a sales call: the agent draws on the team's
// shared context to work a price objection, pull the SOC 2 answer mid-call,
// and set the next step. Content is FICTIONAL.
const SALES_AGENT_SCENARIO: LiveAgentScenario = {
  agentName: 'Sales Agent',
  conversation: [
    { speaker: 'Dana', text: "Honestly, price is going to be the deciding factor for us.", isLocal: false },
    { speaker: 'You', text: "Totally fair. What are you comparing us against?", isLocal: true },
    { speaker: 'Dana', text: "Mostly BridgeCRM. And legal will want SOC 2 before we sign anything.", isLocal: false },
    { speaker: 'You', text: "We're SOC 2 Type II — I'll share the report before we hang up.", isLocal: true },
    { speaker: 'Dana', text: "Okay, that helps. How fast could a 40-person team get going?", isLocal: false },
    { speaker: 'You', text: "Two weeks, with a dedicated onboarding manager. Let's book the pilot kickoff.", isLocal: true },
  ],
  toolCalls: [
    { label: 'Playbook', detail: 'Price objection → lead with ROI, not discount' },
    { label: 'Nudge', detail: 'Ask which tools they’re comparing' },
    { label: 'Search docs', detail: 'query: "SOC 2 report"' },
    { label: 'Get account', detail: 'Acme Corp — 40 seats, Evaluation' },
    { label: 'Propose change', detail: 'Next step: schedule pilot kickoff' },
  ],
  speakerPills: [
    { name: 'alex rivera', isLocal: true },
    { name: 'dana whitfield', isLocal: false },
  ],
  title: 'Acme Corp · Discovery call',
  notes: [
    'Price is the deciding factor; comparing us with BridgeCRM.',
    'Legal needs SOC 2 before signing. We’re Type II.',
    'A 40-seat team, live in two weeks with onboarding.',
  ],
  proposals: [
    { title: 'Send Dana the SOC 2 Type II report', kind: 'action', afterCall: 2 },
    { title: 'Lead with ROI on price; no discount before the pilot', kind: 'decision', afterCall: 3 },
    { title: 'Schedule the pilot kickoff with Acme', kind: 'action', afterCall: 4 },
  ],
}

// The chat widget aimed at deal questions: each one typed, sent, and
// answered from the team's calls and email. Content is FICTIONAL.
const SALES_CHAT_EXCHANGES: ChatDemoExchange[] = [
  {
    ask: 'What did we promise Acme on pricing in last week’s call?',
    answer:
      'On Thursday’s call with Dana Whitfield you offered:\n\n- **12% off list** on a two-year term, signed by Nov 15\n- **Free onboarding** for the first 40 seats\n- A **pilot kickoff** within two weeks\n\nThe SOC 2 report you promised hasn’t gone out yet.',
  },
  {
    ask: 'What’s blocking the Meridian renewal?',
    answer:
      'From the last three calls:\n\n- **Budget**: their CFO wants it under last year’s spend\n- **New owner**: Priya moved teams; Jordan took over\n- **Open ask**: an SSO audit log, promised for Q1',
  },
]

// Reusable section container. Originally cloned from the classic landing page
// and kept in sync by hand across the four variants; now that this is the only
// landing page, it is simply this file's own helper.
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
    <section
      id={id}
      className={clsx('py-24 lg:py-32 relative', className)}
    >
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

// Copy + destination deliberately mirror the navbar's signup CTA ("Sign up
// free" → /login?mode=signup) so the page never shows two names for the same
// action.
//
// The href carries `&edition=sales` so the workspace this signup creates is
// stamped with the sales persona — see components/signup-href.tsx for the
// chain. It is still resolved through the hook rather than hardcoded: at `/`
// the enclosing SignupEditionProvider supplies `sales`, and at `/sales`
// (a redirect to `/`, kept for in-flight links) the pathname does.
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

// ─── Section 1: Hero ─────────────────────────────────────────
function Hero() {
  const posthog = usePostHog()

  return (
    <section id="hero" className="relative flex flex-col">
      {/* Navbar self-positions as a `fixed z-50` header — don't wrap it in a
          `relative z-10` div, which would trap it in this section's stacking
          context and let later sections paint over it. */}
      <Navbar />

      <div className="relative z-10 flex flex-col items-center px-6 lg:px-8 pt-44 sm:pt-52 pb-24 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="font-display text-5xl/[1.05] font-medium tracking-tight text-foreground sm:text-6xl/[1.02] md:text-7xl/[1.0] max-w-4xl"
        >
          Imagine your best rep,
          <br />
          on every call
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mt-6 max-w-xl text-lg text-muted-foreground sm:text-xl"
        >
          Turn everything your sales team knows into intelligence every rep can
          use — live, while they sell.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-10 flex flex-col sm:flex-row items-center gap-3"
        >
          <PrimaryCta location="sales_hero" />
          {hasDownload() && (
            <a
              href="/api/download"
              onClick={() => {
                posthog?.capture('cta_clicked', { location: 'sales_hero', type: 'download_macos' })
              }}
              className="inline-flex items-center justify-center gap-2 py-3 px-7 text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
            >
              Download for macOS
            </a>
          )}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.45 }}
          className="mt-6 text-sm text-muted-foreground"
        >
          Free to start · No bots on customer calls
        </motion.p>
      </div>
    </section>
  )
}

// ─── Section 2: Feature panels ───────────────────────────────
// Five alternating panels, each a heading + one or two sentences + a mockup.
// The mockups are live demo widgets, so the page shows the real product
// instead of screenshots.

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
  const posthog = usePostHog()
  const signupHref = useSignupHref()
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      // No overflow-hidden and no `isolate` here: the demo widgets open
      // absolutely-positioned popovers that must be able to escape the panel
      // and paint above neighboring sections.
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
          <h3 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            {title}
          </h3>
          <p className="mt-4 text-lg text-muted-foreground">{description}</p>
          <a
            href={signupHref}
            onClick={() => {
              // `feature` carries the panel title so per-panel conversion is
              // separable in insights without a new location per panel.
              posthog?.capture('cta_clicked', {
                location: 'sales_feature_panel',
                type: 'sign_up',
                feature: title,
              })
            }}
            className="mt-6 inline-flex items-center gap-1.5 text-base font-medium text-foreground hover:opacity-70 transition-opacity"
          >
            Try now
            <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </motion.div>
  )
}

function FeaturesSection() {
  return (
    <SectionContainer id="features">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5 }}
        className="text-center mb-16"
      >
        <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          Everything between hello and closed
        </h2>
        <p className="mt-6 mx-auto max-w-2xl text-lg text-muted-foreground">
          Native Intelligence captures what your team learns, combines it with your playbooks
          and product knowledge, and gives every rep the right context while
          they sell.
        </p>
      </motion.div>

      <div className="space-y-8">
        <FeaturePanel
          title="Your company’s knowledge, live on the call"
          description="A live agent listens with everything Native Intelligence knows — your product, playbook, pricing, competitors, and this customer’s history — and surfaces the right piece in a heads-up display only you can see."
          visual={<HudTipsDemo />}
        />
        <FeaturePanel
          flip
          title="Your team gets smarter with every call"
          description="Your best reps learn something every day — how customers describe the problem, which objections actually matter, what moves deals forward. Native Intelligence captures it and makes it available to everyone."
          visual={<IntelligenceLoopDemo />}
        />
        <FeaturePanel
          title="Your whole pitch in one shared package"
          description="Product knowledge, pricing, objection plays, battlecards, demo scripts, playbooks, deal history — packaged and shared with your team. The live agent doesn’t just listen to the call; it knows what your company knows and brings the right part into the conversation."
          visual={<ContextPackageDemo />}
        />
        <FeaturePanel
          flip
          title="Every deal’s history, one question away"
          description="New rep on the account? Ask what was promised, what’s blocking, and what happens next — drawn from every call and email your team has had."
          visual={<ChatDemo exchanges={SALES_CHAT_EXCHANGES} />}
        />
        <FeaturePanel
          title="Follow-ups queued before you hang up"
          description="The live agent pulls account context, checks your playbook, and creates next steps in your workspace while you talk. What the call taught the team goes back into the shared context."
          visual={<LiveAgentDemo scenario={SALES_AGENT_SCENARIO} />}
        />
        <FeaturePanel
          flip
          title="A CRM that manages itself"
          description="Notes, next steps, and deal stages update themselves the moment you hang up. Your pipeline stays current because your team is already talking to customers."
          visual={<CrmAutologDemo />}
        />
      </div>
    </SectionContainer>
  )
}

// ─── Section 3: Built for teams ──────────────────────────────
function TeamSection() {
  const points = [
    {
      title: 'Shared accounts and contacts',
      body: 'Every account, contact, and conversation in one place — no more asking who owns what.',
    },
    {
      title: 'Full history on every deal',
      body: 'Anyone can pick up an account and see every call, promise, and open question in seconds.',
    },
    {
      title: 'One playbook, every call',
      body: 'Your playbook lives in the shared context, so every rep sells with the same knowledge behind them.',
    },
    {
      title: 'Always in sync',
      body: 'Stages, next steps, and what the team learned update as calls happen. Pipeline reviews become about selling, not status.',
    },
  ]

  return (
    <SectionContainer id="team">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          Your entire sales organization, on the same intelligence
        </h2>
        <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
          What one rep learns, every rep knows.
        </p>
      </motion.div>

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
    </SectionContainer>
  )
}

// ─── Section 4: Desktop app ──────────────────────────────────
function DesktopSection() {
  const posthog = usePostHog()

  const points = [
    {
      title: 'No meeting bots',
      body: 'Capture customer calls automatically — no bot joins the meeting.',
    },
    {
      title: 'Notifications',
      body: 'Get notified about upcoming calls, with one-click record.',
    },
    {
      title: 'Easy access',
      body: 'Start a recording, check today’s calls, or jot down notes from your desktop.',
    },
    {
      title: 'Every platform you sell on',
      body: 'Works with any call you take on your computer — Zoom, Google Meet, Microsoft Teams, Webex, phone calls, and more.',
    },
  ]

  return (
    <SectionContainer id="desktop">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          Nothing joins your customer’s call
        </h2>
        <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
          The desktop app records from your side of the conversation.
        </p>
        {hasDownload() && (
          <a
            href="/api/download"
            onClick={() => {
              posthog?.capture('cta_clicked', { location: 'sales_desktop', type: 'download_macos' })
            }}
            className="mt-8 inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
            Download for macOS
          </a>
        )}
      </motion.div>

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
    </SectionContainer>
  )
}

// ─── Section 5: Integrations ─────────────────────────────────
function IntegrationsSection() {
  const integrations = [
    {
      icon: <HubSpotIcon className="h-6 w-6" />,
      name: 'HubSpot',
      body: 'Two-way sync — contacts, companies, and deals update after every call.',
    },
    {
      icon: <AttioIcon className="h-6 w-6" />,
      name: 'Attio',
      body: 'Keep your Attio workspace current without the data entry.',
    },
    {
      icon: <AffinityIcon className="h-6 w-6" />,
      name: 'Affinity',
      body: 'Log interactions and keep relationship intelligence fresh.',
    },
    {
      icon: <GmailIcon className="h-6 w-6" />,
      name: 'Gmail',
      body: 'See the email thread next to the deal, with AI-drafted follow-ups.',
    },
    {
      icon: <OutlookIcon className="h-6 w-6" />,
      name: 'Outlook',
      body: 'Connect your Microsoft calendar and email.',
    },
    {
      icon: <GoogleCalendarIcon className="h-6 w-6" />,
      name: 'Google Calendar',
      body: 'Every scheduled call captured with full context.',
    },
    {
      icon: <SlackIcon className="h-6 w-6" />,
      name: 'Slack',
      body: 'Deal updates and call recaps in your channels.',
    },
    {
      icon: <Plug className="h-6 w-6 text-muted-foreground" />,
      name: 'MCP',
      body: 'Connect AI apps like ChatGPT, Claude, and Cursor to your pipeline.',
    },
  ]

  return (
    <SectionContainer id="integrations">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <h2 className="text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          Works with your stack
        </h2>
        <p className="mt-6 mx-auto max-w-2xl text-lg text-muted-foreground">
          Already on HubSpot? Keep it — Native Intelligence syncs both ways. Ready to
          consolidate? The CRM is built in.
        </p>
      </motion.div>

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

// ─── Section 6: FAQ ──────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: 'Will a bot join my customer calls?',
    a: 'No. The desktop app records from your computer — nothing visible ever joins the call.',
  },
  {
    q: 'How does the live agent work?',
    a: 'Your playbooks, product knowledge, and deal history live in Native Intelligence as shared context. On a call the agent draws on it and surfaces what’s relevant — in a heads-up display only your side can see.',
  },
  {
    q: 'Can Native Intelligence replace our CRM?',
    a: 'It can. Contacts, companies, deals, and interaction history are built in. If you’re staying on HubSpot, sync two-way instead of switching.',
  },
  {
    q: 'Does it work for phone calls and in-person meetings?',
    a: 'Yes. Record from the desktop app or your browser microphone — any conversation, not just video calls.',
  },
  {
    q: 'Is my customer data used to train AI models?',
    a: 'No. Your conversations, contacts, and notes are never used to train AI models.',
  },
  {
    q: 'Is there a free plan?',
    a: 'Yes — start for free, no credit card required. Upgrade when your team is ready.',
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
          className={clsx(
            'h-5 w-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
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
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
          className="text-center text-3xl font-medium tracking-tight text-foreground sm:text-4xl"
        >
          Frequently asked questions
        </motion.h2>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mt-10"
        >
          {FAQ_ITEMS.map((item) => (
            <FaqItem key={item.q} q={item.q} a={item.a} />
          ))}
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// ─── Section 7: Closing CTA ──────────────────────────────────
function CTASection() {
  return (
    <SectionContainer id="cta">
      <div className="text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <h2 className="text-4xl font-medium tracking-tight text-foreground sm:text-5xl">
            Try it on your next call.
            <br />
            <span className="text-muted-foreground">Free to start.</span>
          </h2>
          <div className="mt-10 flex flex-col items-center gap-6">
            <PrimaryCta location="sales_cta" />
            <div className="w-full max-w-md">
              <p className="mb-3 text-sm text-muted-foreground">
                Rolling it out to a whole sales team? Join the waitlist.
              </p>
              <EarlyAccessForm
                source="sales_waitlist"
                buttonText="Join Waitlist"
                successMessage="You're on the list!"
                successDetail="We'll be in touch soon with early access details."
              />
            </div>
          </div>
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// `roadmap` is the "What we're building" section, rendered on the server by
// page.tsx and passed down through LandingVariantSwitch. It sits after the FAQ,
// just before the closing CTA, and renders nothing when there is nothing to show.
export default function SalesPage({ roadmap }: { roadmap?: React.ReactNode }) {
  const router = useRouter()

  // Desktop-shell users get redirected into the app — identical to the other
  // variants. Pure side effect: the page always renders (including SSR) so
  // crawlers get the full marketing HTML.
  useEffect(() => {
    if (isDesktopApp()) {
      router.replace('/login')
    }
  }, [router])

  return (
    <PageLayout sections={sections}>
      <Hero />
      <main>
        <FeaturesSection />
        <TeamSection />
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
