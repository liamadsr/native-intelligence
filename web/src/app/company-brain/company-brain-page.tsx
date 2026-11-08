'use client'

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { PageLayout, type Section } from '@/components/page-layout'
import { EarlyAccessForm } from '@/components/early-access-form'
import { useSignupHref } from '@/components/signup-href'
import { IntegrationsDemo } from '@/components/landing/integrations-demo'
import { ActionStreamDemo, CaptureDemo, ChatDemo, LiveAgentDemo } from '@/components/landing/lazy-demos'
import { SlackIcon, JiraIcon, LinearIcon, AsanaIcon } from '@/components/brand-icons'
import { isDesktopApp } from '@/lib/platform'
import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { hasDownload } from '@/lib/app-download'

const sections: Section[] = [
  { id: 'hero', label: 'Dial8' },
  { id: 'problem', label: 'The Problem' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'system-of-record', label: 'System of Record' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'knowledge-graph', label: 'Knowledge Graph' },
  { id: 'agents', label: 'Agents' },
  // Social proof hidden until we have customer logos/testimonials — re-add
  // alongside <SocialProofSection /> below.
  // { id: 'social-proof', label: 'Teams' },
  { id: 'cta', label: 'Get Started' },
]

// Reusable section container (cloned from landing-page.tsx)
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
      className={clsx('min-h-screen flex items-center py-24 lg:py-32 relative', className)}
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

// Section header component (cloned from landing-page.tsx)
function SectionHeader({
  badge,
  title,
  description,
  align = 'left',
}: {
  badge?: string
  title: string
  description?: string | React.ReactNode
  align?: 'left' | 'center'
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      className={clsx('mb-12', align === 'center' && 'text-center')}
    >
      {badge && (
        <span className="inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {badge}
        </span>
      )}
      <h2 className="mt-4 text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
        {title}
      </h2>
      {description && (
        <div
          className={clsx(
            'mt-6 text-lg text-muted-foreground space-y-4',
            align === 'center' ? 'mx-auto max-w-2xl' : 'max-w-xl'
          )}
        >
          {typeof description === 'string' ? <p>{description}</p> : description}
        </div>
      )}
    </motion.div>
  )
}

// Checkmark list item (cloned from landing-page.tsx)
function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary">
        <svg className="h-3 w-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  )
}

// Section 1: Hero
function Hero() {
  const posthog = usePostHog()
  // `&edition=brain` at /company-brain, and whatever the homepage switch
  // declares when this component is its `company-brain` A/B bucket. See
  // components/signup-href.ts.
  const signupHref = useSignupHref()

  return (
    <section id="hero" className="relative min-h-[85vh] flex flex-col">
      {/* Navbar self-positions as a `fixed z-50` header — don't wrap it in a
          `relative z-10` div, that traps its z-50 inside a lower stacking context
          and the hero content (also z-10) ends up painting over it. */}
      <Navbar />

      <div className="relative z-10 flex-1 flex flex-col px-6 lg:px-8 pt-48 sm:pt-44 pb-8">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex flex-col lg:flex-row lg:items-center lg:gap-10">
            {/* Left: text content */}
            <div className="flex-1 min-w-0 text-center lg:text-left items-center lg:items-start flex flex-col">
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
              >
                <span className="inline-block rounded-full bg-foreground/10 backdrop-blur-xs border border-foreground/20 px-3 py-1 text-xs sm:text-sm sm:px-4 sm:py-1.5 font-medium text-foreground mb-4 sm:mb-6">
                  Captures live · Pushes to your tools · Stays in sync
                </span>
                {/* TODO: finalize headline — alternatives: "The brain your team works out of." */}
                <h1 className="font-display text-4xl/[1.08] font-medium tracking-tight text-foreground sm:text-5xl/[1.05] md:text-6xl/[1.02]">
                  One brain. Every tool.{' '}
                  <span className="text-muted-foreground">Always in sync.</span>
                </h1>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.2 }}
                className="mt-5 sm:mt-8"
              >
                <p className="max-w-lg text-sm/6 text-muted-foreground sm:text-lg/7">
                  Dial8 captures your meetings, turns them into action items, and pushes them
                  into Slack, Jira, Linear, or Asana &mdash; while staying the one place that
                  always knows what&rsquo;s true.
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.35 }}
                className="mt-6 sm:mt-8 flex flex-col sm:flex-row items-center lg:items-start gap-2 sm:gap-3"
              >
                {hasDownload() && (
                  <a
                    href="/api/download"
                    onClick={() => {
                      posthog?.capture('cta_clicked', { location: 'company_brain_hero', type: 'download_macos' })
                    }}
                    className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm sm:py-3 sm:px-6 sm:text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <svg className="h-4 w-4 sm:h-5 sm:w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    Download for macOS
                  </a>
                )}
                <a
                  href={signupHref}
                  onClick={() => {
                    posthog?.capture('cta_clicked', { location: 'company_brain_hero', type: 'sign_up' })
                  }}
                  className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm sm:py-3 sm:px-6 sm:text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
                >
                  Sign up free
                </a>
                <a
                  href="#cta"
                  onClick={() => {
                    posthog?.capture('cta_clicked', { location: 'company_brain_hero', type: 'waitlist' })
                  }}
                  className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm sm:py-3 sm:px-6 sm:text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
                >
                  Join the Waitlist
                </a>
              </motion.div>
            </div>

            {/* Right: action-stream demo — captured live and stacks in, mirroring
                the main landing page's hero visual exactly. `isolate` gives it its
                own stacking context; the compositing-layer promotion lives on the
                ActionStreamDemo root, not this motion.div. */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.5 }}
              className="mt-16 lg:mt-12 flex-1 min-w-0 isolate"
            >
              <ActionStreamDemo />
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}

// Section 2: The Problem
function ProblemSection() {
  return (
    <SectionContainer id="problem">
      <div className="max-w-3xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
        >
          <span className="inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            The Problem
          </span>
          <h2 className="mt-6 text-3xl font-medium tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            The decisions are made. Then they scatter.
          </h2>
          <p className="mt-6 text-lg text-muted-foreground leading-relaxed">
            Every meeting settles something &mdash; a decision, an owner, a next step. Minutes
            later it&rsquo;s spread across a doc, a thread, and someone&rsquo;s memory. No single
            place stays true. So the team re-decides what it already decided, and the knowledge
            quietly evaporates.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-16 grid gap-6 md:grid-cols-3"
        >
          {[
            {
              tool: 'Notes and docs',
              problem: 'Capture the meeting, then go stale the moment work moves elsewhere.',
            },
            {
              tool: 'Search tools',
              problem: 'Vacuum up everything after the fact — and still can’t say what’s current.',
            },
            {
              tool: 'Task trackers',
              problem: 'Hold the work, but forget why it exists and who decided it.',
            },
          ].map((item, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border p-6 text-left"
            >
              <p className="text-sm font-medium text-foreground">{item.tool}</p>
              <p className="mt-2 text-sm text-muted-foreground">{item.problem}</p>
            </div>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-16"
        >
          <p className="text-xl font-medium text-foreground">
            Dial8 stays the source of truth.
          </p>
          <p className="mt-3 text-lg text-muted-foreground">
            Captured live. Pushed to where work happens. Kept current by two-way sync.
          </p>
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 3: How It Works — 4-step verb chain, CaptureDemo as the visual
function HowItWorksSection() {
  return (
    <SectionContainer id="how-it-works">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
        <div>
          <SectionHeader
            badge="How It Works"
            title="Capture. Surface. Push. Sync."
            description={
              <>
                <p>
                  The work is built live from the meeting &mdash; not scraped together after the
                  fact. Then it lands where your team already works, and stays in step no matter
                  where it moves.
                </p>
                <ul className="space-y-3 mt-4">
                  <CheckItem>
                    <span className="font-medium text-foreground">Capture</span> &mdash; live from
                    the meeting, as it happens.
                  </CheckItem>
                  <CheckItem>
                    <span className="font-medium text-foreground">Surface</span> &mdash; action
                    items with owners and the context behind them.
                  </CheckItem>
                  <CheckItem>
                    <span className="font-medium text-foreground">Push</span> &mdash; one dropdown
                    to Slack, Jira, Linear, or Asana.
                  </CheckItem>
                  <CheckItem>
                    <span className="font-medium text-foreground">Sync</span> &mdash; two-way;
                    complete it in Jira and Dial8 updates automatically.
                  </CheckItem>
                </ul>
              </>
            }
          />
        </div>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6 }}
        >
          <CaptureDemo />
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 4: Keystone — system of record, theme-aware app rendering
function SystemOfRecordSection() {
  return (
    <SectionContainer id="system-of-record">
      <SectionHeader
        badge="System of Record"
        title="Work lives everywhere. Your brain stays in sync."
        align="center"
        description="Push work out to wherever it gets done. Dial8 stays the master copy — the one place that always knows the current state, because two-way sync pulls every change back the moment it happens elsewhere."
      />

      {/* App rendering — theme-aware (light/dark variants) */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        <img
          src="/screenshots/dial8-conversation-shipped-work-light.png"
          alt="Dial8 as the source of truth: an action item pushed out to a connected tool, kept current by two-way sync as it moves through to shipped work."
          className="w-full rounded-2xl dark:hidden"
        />
        <img
          src="/screenshots/dial8-conversation-shipped-work-dark.png"
          alt="Dial8 as the source of truth: an action item pushed out to a connected tool, kept current by two-way sync as it moves through to shipped work."
          className="hidden w-full rounded-2xl dark:block"
        />
      </motion.div>
    </SectionContainer>
  )
}

// Section 5: Integrations — push + two-way sync framing
function IntegrationsSection() {
  return (
    <SectionContainer id="integrations">
      {/* TODO: copy review — headline candidates: "Push work out. Dial8 stays the
          source of truth." / "Work anywhere. Stay in sync." */}
      <SectionHeader
        badge="Integrations"
        title="Push work out. Dial8 stays the source of truth."
        align="center"
        description="Send any action to Jira, Linear, or Asana in one click and keep working there. Dial8 stays connected to everything it pushes — as work moves in your tools, the record updates automatically, so one place always holds the current state."
      />
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        <IntegrationsDemo />
      </motion.div>
    </SectionContainer>
  )
}

// Section 6: Knowledge graph / provenance
function KnowledgeGraphSection() {
  const brands = [
    { label: 'Slack', Icon: SlackIcon },
    { label: 'Jira', Icon: JiraIcon },
    { label: 'Linear', Icon: LinearIcon },
    { label: 'Asana', Icon: AsanaIcon },
  ]

  return (
    <SectionContainer id="knowledge-graph">
      <SectionHeader
        badge="Provenance"
        title="Every fact knows where it came from."
        align="center"
        description="This is an operational brain, not an archive. Nothing floats free — and the more a thing is discussed, the more certain the record gets."
      />

      <div className="grid gap-6 md:grid-cols-2">
        {/* Card A: full provenance */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
          className="rounded-2xl border border-border p-8"
        >
          <h3 className="text-xl font-medium text-foreground">Full provenance</h3>
          <p className="mt-3 text-muted-foreground">
            Every item traces back to the meeting it came from &mdash; and the exact moment it was
            said. Click any decision and see who made it, when, and in what conversation.
          </p>
          <ul className="space-y-3 mt-6 text-muted-foreground">
            <CheckItem>Every action links to the meeting that created it</CheckItem>
            <CheckItem>Every decision carries its owner and its moment</CheckItem>
            <CheckItem>Where it lives now &mdash; Slack, Jira, Linear, or Asana &mdash; stays linked</CheckItem>
          </ul>
          {/* Small brand row reinforcing that pushed work keeps its trail */}
          <div className="mt-6 flex items-center gap-3">
            {brands.map(({ label, Icon }) => (
              <span
                key={label}
                title={label}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-muted"
              >
                <Icon className="h-4 w-4" />
              </span>
            ))}
          </div>
        </motion.div>

        {/* Card B: reiteration strengthens */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="rounded-2xl border border-border p-8"
        >
          <h3 className="text-xl font-medium text-foreground">Repetition makes it stronger</h3>
          <p className="mt-3 text-muted-foreground">
            Say something once and it&rsquo;s a claim. Say it in five meetings and it&rsquo;s
            established. The 50th mention makes the record more certain &mdash; not more cluttered.
          </p>
          <ul className="space-y-3 mt-6 text-muted-foreground">
            <CheckItem>Repeated points reinforce a single claim instead of piling up duplicates</CheckItem>
            <CheckItem>Confidence rises as the same fact recurs across conversations</CheckItem>
            <CheckItem>When something changes, the record updates &mdash; the old version stays traceable</CheckItem>
          </ul>
          {/* TODO: copy review — confirm "the old version stays traceable" matches how supersede/versioning is surfaced in-product */}
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 7: Agents + shared context
function AgentsSection() {
  return (
    <SectionContainer id="agents">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="order-2 lg:order-1 space-y-6"
        >
          <LiveAgentDemo />
          <ChatDemo />
        </motion.div>
        <div className="order-1 lg:order-2">
          <SectionHeader
            badge="Agents & Shared Context"
            title="One living context. For the whole team — and their agents."
            description={
              <>
                <p>
                  Ask a question and get the answer instantly &mdash; pulled straight from the
                  brain, with the meeting behind it. Everyone works from the same current context,
                  and so do the agents you point at it.
                </p>
                <ul className="space-y-3 mt-4">
                  <CheckItem>Agents retrieve anything the team has discussed, in seconds</CheckItem>
                  <CheckItem>Every teammate sees the same source of truth, kept live</CheckItem>
                  <CheckItem>Agents act with full provenance &mdash; not a guess at what was decided</CheckItem>
                  <CheckItem>One shared brain across people, tools, and agents</CheckItem>
                </ul>
              </>
            }
          />
        </div>
      </div>
    </SectionContainer>
  )
}

// Section 8: Social proof placeholder
function SocialProofSection() {
  return (
    <SectionContainer id="social-proof">
      <div className="text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
        >
          <span className="inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Teams
          </span>
          <h2 className="mt-4 text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
            Trusted by teams that run on what was decided.
          </h2>
        </motion.div>

        {/* TODO: add logos/testimonials — replace this placeholder block with real
            customer logos and quotes once available. */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mt-10 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-12"
        >
          <p className="text-sm text-muted-foreground">
            Customer logos and testimonials coming soon.
          </p>
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 9: Closing CTA — cloned from CTASection in landing-page.tsx
function CTASection() {
  const signupHref = useSignupHref()
  return (
    <SectionContainer id="cta">
      <div className="text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <h2 className="text-4xl font-medium tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Give your team one brain.
            <br />
            <span className="text-muted-foreground">Keep every tool in sync.</span>
          </h2>
          <p className="mt-6 text-xl text-muted-foreground max-w-2xl mx-auto">
            Captured live from the meeting. Pushed into the tools you already use. Kept true by
            two-way sync. That&rsquo;s Dial8 &mdash; the one place that always knows what&rsquo;s
            current.
          </p>
          <div className="mt-10 flex flex-col items-center gap-6">
            <div className="flex flex-col sm:flex-row items-center gap-3">
              {hasDownload() && (
                <a
                  href="/api/download"
                  className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                  Download for macOS
                </a>
              )}
              <a
                href={signupHref}
                className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
              >
                Sign up free
              </a>
            </div>
            <div className="w-full max-w-md">
              <div className="flex items-center gap-2 justify-center mb-3">
                <p className="text-sm text-muted-foreground">
                  Want it for your whole team? Join the waitlist.
                </p>
              </div>
              <EarlyAccessForm
                source="company_brain_waitlist"
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

export default function CompanyBrainPage() {
  const router = useRouter()

  // Desktop-shell users get redirected into the app — kept identical to
  // landing-page.tsx for behavioral parity. Pure side effect: the page content
  // ALWAYS renders (including during SSR) so crawlers get the full marketing HTML.
  useEffect(() => {
    if (isDesktopApp()) {
      router.replace('/login')
    }
  }, [router])

  return (
    <PageLayout sections={sections}>
      <Hero />
      <main>
        <ProblemSection />
        <HowItWorksSection />
        <SystemOfRecordSection />
        <IntegrationsSection />
        <KnowledgeGraphSection />
        <AgentsSection />
        {/* Hidden until we have customer logos/testimonials — restore this and
            its `sections` entry above to bring the section back. */}
        {/* <SocialProofSection /> */}
        <CTASection />
      </main>
      <Footer />
    </PageLayout>
  )
}
