'use client'

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { PageLayout, type Section } from '@/components/page-layout'
import { Screenshot } from '@/components/screenshot'
import { EarlyAccessForm } from '@/components/early-access-form'
// HeroWaveform is intentionally not rendered in the hero anymore (replaced by the
// hero image), but the component is kept at @/components/landing/hero-waveform for
// reuse elsewhere. Re-import and render it when needed.
import { IntegrationsDemo } from '@/components/landing/integrations-demo'
import { ActionStreamDemo, CaptureDemo, ChatDemo, ExecutionDemo, LiveAgentDemo } from '@/components/landing/lazy-demos'
import { isDesktopApp } from '@/lib/platform'
import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { hasDownload } from '@/lib/app-download'

const sections: Section[] = [
  { id: 'hero', label: 'Native Intelligence' },
  { id: 'problem', label: 'The Problem' },
  { id: 'how-it-works', label: 'How It Works' },
  { id: 'live-agents', label: 'Live Agents' },
  { id: 'project-management', label: 'Projects & Actions' },
  { id: 'execution', label: 'AI Execution' },
  { id: 'integrations', label: 'Integrations & MCP' },
  { id: 'cta', label: 'Get Started' },
]

// Reusable section container
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

// Section header component
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

// Checkmark list item
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

// Screenshot placeholder for sections without images yet
function ScreenshotPlaceholder({ label }: { label: string }) {
  return (
    <div className="w-full aspect-[16/10] rounded-xl bg-muted border border-border flex items-center justify-center">
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  )
}

// Floating chat demo — part of the hero section layout
function FloatingChatDemo() {
  return null
}

// Section 1: Hero
function Hero() {
  const posthog = usePostHog()

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
                  Records meetings · Tracks the work · Agents execute
                </span>
                <h1 className="font-display text-4xl/[1.08] font-medium tracking-tight text-foreground sm:text-5xl/[1.05] md:text-6xl/[1.02]">
                  Meetings create work.{' '}
                  <span className="text-muted-foreground">Native Intelligence gets it done.</span>
                </h1>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.2 }}
                className="mt-5 sm:mt-8"
              >
                <p className="max-w-lg text-sm/6 text-muted-foreground sm:text-lg/7">
                  Native Intelligence records your meetings, turns decisions into tracked action items with
                  full context &mdash; and hands them to AI agents that write the code, draft the
                  docs, and open the PRs.
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
                      posthog?.capture('cta_clicked', { location: 'hero', type: 'download_macos' })
                    }}
                    className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm sm:py-3 sm:px-6 sm:text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <svg className="h-4 w-4 sm:h-5 sm:w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    Download for macOS
                  </a>
                )}
                <a
                  href="#cta"
                  onClick={() => {
                    posthog?.capture('cta_clicked', { location: 'hero', type: 'windows_waitlist' })
                  }}
                  className="inline-flex items-center justify-center gap-2 py-2.5 px-5 text-sm sm:py-3 sm:px-6 sm:text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
                >
                  <svg className="h-4 w-4 sm:h-5 sm:w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/></svg>
                  Join Windows Waitlist
                </a>
              </motion.div>
            </div>

            {/* Right: action-stream demo — fills the right column so the hero
                reads as a balanced two-column layout instead of a content-heavy
                left with empty space on the right. Action items are captured live
                and stack in. `isolate` gives it its own stacking context; the
                compositing-layer promotion (transform-gpu) lives on the
                ActionStreamDemo root so its frequent animation repaints don't
                invalidate the fixed navbar's backdrop-filter region (white
                flicker). It's not on this motion.div because framer controls its
                transform (settles to none after the entrance animation). */}
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
            The meeting ends. The work disappears.
          </h2>
          <p className="mt-6 text-lg text-muted-foreground leading-relaxed">
            Every meeting produces commitments &mdash; decisions, follow-ups, action items. Then
            they scatter: half in someone&rsquo;s notes, half in memory, none in your task tracker.
            Three weeks later, you&rsquo;re having the same conversation again.
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
              tool: 'AI notetakers',
              problem: 'Write summaries nobody opens again',
            },
            {
              tool: 'Task trackers',
              problem: 'Sit empty until you type the tickets in yourself',
            },
            {
              tool: 'AI assistants',
              problem: 'Answer questions about the work. Don’t do it.',
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
            Native Intelligence closes the loop.
          </p>
          <p className="mt-3 text-lg text-muted-foreground">
            Meetings become tracked actions. Actions carry their context. Agents execute them.
          </p>
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 3: How It Works — system diagram
function HowItWorksSection() {
  return (
    <SectionContainer id="how-it-works">
      <SectionHeader
        badge="How It Works"
        title="From conversation to shipped work."
        align="center"
        description="Your meetings flow in. Action items come out — owned, prioritized, and linked to why they exist. Agents pick them up and finish them."
      />

      {/* From-conversation-to-shipped-work image — theme-aware (light/dark variants) */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        <img
          src="/screenshots/dial8-conversation-shipped-work-light.png"
          alt="From conversation to shipped work: meetings flow into Native Intelligence, become owned and prioritized action items linked to their context, and agents pick them up and finish them."
          className="w-full rounded-2xl dark:hidden"
        />
        <img
          src="/screenshots/dial8-conversation-shipped-work-dark.png"
          alt="From conversation to shipped work: meetings flow into Native Intelligence, become owned and prioritized action items linked to their context, and agents pick them up and finish them."
          className="hidden w-full rounded-2xl dark:block"
        />
      </motion.div>
    </SectionContainer>
  )
}

// Section 4: Live Agents
function LiveAgentsSection() {
  return (
    <SectionContainer id="live-agents">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
        <div>
          <SectionHeader
            badge="Live Agents"
            title="Your meetings update your workspace. Automatically."
            description={
              <>
                <p>
                  Other tools transcribe and summarize. Native Intelligence listens for the work: live agents
                  act during the conversation &mdash; a PM agent hears a status update and moves
                  the project forward before the call ends.
                </p>
                <ul className="space-y-3 mt-4">
                  <CheckItem>Detects project mentions and links them to your workspace</CheckItem>
                  <CheckItem>Extracts action items with owners, context, and priority</CheckItem>
                  <CheckItem>Suggests status changes, decisions, and follow-ups as they happen</CheckItem>
                  <CheckItem>Every conversation enriches your company&rsquo;s knowledge base automatically</CheckItem>
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
          <LiveAgentDemo />
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 5: Project Management
function ProjectManagementSection() {
  return (
    <SectionContainer id="project-management">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="order-2 lg:order-1 space-y-6"
        >
          <CaptureDemo />
          {/* Chat panel lives here so it's clear you can drive projects & actions
              from chat. Moved out of the hero, which now shows the action stream. */}
          <ChatDemo />
        </motion.div>
        <div className="order-1 lg:order-2">
          <SectionHeader
            badge="Projects & Actions"
            title="A task tracker that fills itself in."
            description={
              <>
                <p>
                  Initiatives, projects, actions with identifiers, boards, custom views &mdash;
                  everything you&rsquo;d expect from a Linear-style tracker. The difference: you
                  don&rsquo;t feed it. Context flows in from your conversations. The system stays
                  current because your team already talks about the work.
                </p>
                <ul className="space-y-3 mt-4">
                  <CheckItem>Projects update their status when your team discusses them</CheckItem>
                  <CheckItem>Action items arrive pre-filled with context, owners, and priority</CheckItem>
                  <CheckItem>Board views, list views, and custom filters for any workflow</CheckItem>
                  <CheckItem>Every meeting, decision, and commitment is linked and searchable</CheckItem>
                </ul>
              </>
            }
          />
        </div>
      </div>
    </SectionContainer>
  )
}

// Section 6: AI Execution
function ExecutionSection() {
  return (
    <SectionContainer id="execution">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 items-center">
        <div>
          <SectionHeader
            badge="AI Execution"
            title="Collapsing the distance between idea and implementation."
            description={
              <>
                <p>
                  Every action item in Native Intelligence carries the full context of why it exists — the
                  meeting it came from, the decision behind it, and who&rsquo;s responsible.
                  When it&rsquo;s time to execute, press &ldquo;Work on this&rdquo; and an AI agent
                  picks it up with complete understanding.
                </p>
                <ul className="space-y-3 mt-4">
                  <CheckItem>AI agents start with full meeting context — no prompt engineering</CheckItem>
                  <CheckItem>Writes code, creates pull requests, drafts documents</CheckItem>
                  <CheckItem>Links results back to the action item automatically</CheckItem>
                  <CheckItem>Built-in MCP servers connect to your tools and codebase</CheckItem>
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
          <ExecutionDemo />
        </motion.div>
      </div>
    </SectionContainer>
  )
}

// Section 7: Integrations & MCP
function IntegrationsSection() {
  return (
    <SectionContainer id="integrations">
      <SectionHeader
        badge="Integrations & MCP"
        title="Your tools, fully connected."
        align="center"
        description="Connect your existing tools or bring your own agents. Native Intelligence integrates with the services you already use — and exposes its full workspace via the Model Context Protocol."
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

// Section: CTA
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
          <h2 className="text-4xl font-medium tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Stop documenting work.
            <br />
            <span className="text-muted-foreground">Start getting it done.</span>
          </h2>
          <p className="mt-6 text-xl text-muted-foreground max-w-2xl mx-auto">
            Your meetings already contain the context. Your projects should update themselves.
            Your action items should come with everything an agent needs to execute.
            That&rsquo;s Native Intelligence.
          </p>
          <div className="mt-10 flex flex-col items-center gap-6">
            {hasDownload() && (
              <a
                href="/api/download"
                className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                Download for macOS
              </a>
            )}
            <div className="w-full max-w-md">
              <div className="flex items-center gap-2 justify-center mb-3">
                <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/></svg>
                <p className="text-sm text-muted-foreground">
                  Windows coming soon — join the waitlist
                </p>
              </div>
              <EarlyAccessForm
                source="windows_waitlist"
                buttonText="Join Waitlist"
                successMessage="You're on the Windows waitlist!"
                successDetail="We'll notify you as soon as the Windows app is ready."
              />
            </div>
          </div>
        </motion.div>
      </div>
    </SectionContainer>
  )
}

export default function LandingPage() {
  const router = useRouter()

  // Desktop-shell users get redirected into the app. This is a pure side
  // effect — the page content ALWAYS renders (including during SSR) so
  // crawlers get the full marketing HTML. Desktop users briefly see the
  // landing page before the client-side redirect fires; that's acceptable.
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
        <LiveAgentsSection />
        <ProjectManagementSection />
        <ExecutionSection />
        <IntegrationsSection />
        <CTASection />
      </main>
      <Footer />
    </PageLayout>
  )
}
