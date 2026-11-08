'use client'

/**
 * "Meeting notes" landing variant — Circleback-inspired structure: one
 * plain-terms headline, short feature panels, a desktop-app section, an
 * integrations list, FAQ, and a single repeated CTA. Deliberately light on
 * copy — every section is a heading plus one or two sentences, never a
 * paragraph block.
 *
 * Lives alongside the other two variants (landing-page.tsx, company-brain/
 * company-brain-page.tsx) and shares their section scaffolding. Served at
 * /meeting-notes directly and at / via the PostHog `landing-page-variant`
 * flag (variant key: 'note-taker') — see src/app/landing-variant-switch.tsx.
 */

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { useSignupHref } from '@/components/signup-href'
import { PageLayout, type Section } from '@/components/page-layout'
import { EarlyAccessForm } from '@/components/early-access-form'
import { CaptureDemo, ChatDemo, NotesDocDemo, SpeakerIdDemo } from '@/components/landing/lazy-demos'
import {
  GoogleCalendarIcon,
  GmailIcon,
  OutlookIcon,
  SlackIcon,
  LinearIcon,
  JiraIcon,
  AsanaIcon,
  HubSpotIcon,
} from '@/components/brand-icons'
import { isDesktopApp } from '@/lib/platform'
import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ChevronDown, Plug } from 'lucide-react'

const sections: Section[] = [
  { id: 'hero', label: 'Native Intelligence' },
  { id: 'features', label: 'Features' },
  { id: 'desktop', label: 'Desktop App' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'faq', label: 'FAQ' },
  { id: 'cta', label: 'Get Started' },
]

// Reusable section container (cloned from landing-page.tsx — see the caveat
// there about the three-way fork of these helpers)
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
// The href carries `&edition=notes` at the /meeting-notes route (by pathname)
// and whatever the homepage switch declares when this component is its
// `note-taker` A/B bucket — see components/signup-href.ts for why that comes
// from those two sources rather than being hardcoded here.
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
// Circleback-style: one giant plain-terms headline, a one-line sub, one CTA.
function Hero() {
  const posthog = usePostHog()

  return (
    <section id="hero" className="relative flex flex-col">
      {/* Navbar self-positions as a `fixed z-50` header — don't wrap it in a
          `relative z-10` div (see company-brain-page.tsx). */}
      <Navbar />

      <div className="relative z-10 flex flex-col items-center px-6 lg:px-8 pt-44 sm:pt-52 pb-24 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="font-display text-5xl/[1.05] font-medium tracking-tight text-foreground sm:text-6xl/[1.02] md:text-7xl/[1.0] max-w-4xl"
        >
          Remarkably good
          <br />
          meeting notes
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mt-6 max-w-xl text-lg text-muted-foreground sm:text-xl"
        >
          AI notes, action items, automations, and answers — from every
          conversation you have.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-10 flex flex-col sm:flex-row items-center gap-3"
        >
          <PrimaryCta location="meeting_notes_hero" />
          <a
            href="/api/download"
            onClick={() => {
              posthog?.capture('cta_clicked', { location: 'meeting_notes_hero', type: 'download_macos' })
            }}
            className="inline-flex items-center justify-center gap-2 py-3 px-7 text-base rounded-full border border-border bg-background shadow-sm whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
          >
            Download for macOS
          </a>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.45 }}
          className="mt-6 text-sm text-muted-foreground"
        >
          Free to start · No meeting bots · Works on Mac and web
        </motion.p>
      </div>
    </section>
  )
}

// ─── Section 2: Feature panels ───────────────────────────────
// Five alternating panels, each a heading + one or two sentences + a mockup.
// The mockups are the live demo widgets the other variants already use, so
// this page shows the real product instead of screenshots.

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
  const signupHref = useSignupHref()
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5 }}
      // No overflow-hidden and no `isolate` here: the demo widgets open
      // absolutely-positioned popovers (assignee picker, context) that must be
      // able to escape the panel and paint above neighboring sections. Either
      // one traps/clips them below the next section's background.
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
          Get the most out of every meeting
        </h2>
        <p className="mt-6 mx-auto max-w-2xl text-lg text-muted-foreground">
          Native Intelligence captures and organizes everything from your conversations, so
          you can focus on the conversation instead of the note-taking.
        </p>
      </motion.div>

      <div className="space-y-8">
        <FeaturePanel
          title="Meticulous, organized notes"
          description="Structured notes a perfectionist would be proud of — written for you automatically the moment the meeting ends."
          visual={<NotesDocDemo />}
        />
        <FeaturePanel
          flip
          title="Turn meetings into action"
          description="Action items are captured, assigned, and tracked after every meeting — and sent to Linear, Jira, or Asana automatically. Nothing you said you’d do gets dropped."
          visual={<CaptureDemo variant="actions" />}
        />
        <FeaturePanel
          title="Ask anything, across every meeting"
          description="Ask questions and get answers drawn from every conversation you’ve ever had."
          visual={<ChatDemo />}
        />
        <FeaturePanel
          flip
          title="Accurate, speaker-by-speaker transcription"
          description="Every speaker identified by name — Native Intelligence recognizes voices it has met before. Technical terms handled, recording kept alongside the notes."
          visual={<SpeakerIdDemo />}
        />
      </div>
    </SectionContainer>
  )
}

// ─── Section 3: Desktop app ──────────────────────────────────
function DesktopSection() {
  const posthog = usePostHog()

  const points = [
    {
      title: 'No meeting bots',
      body: 'Capture meetings automatically without a bot joining the call.',
    },
    {
      title: 'Notifications',
      body: 'Get notified about upcoming meetings, with one-click record.',
    },
    {
      title: 'Easy access',
      body: 'Quickly start a recording, view upcoming meetings, or jot down notes from your desktop.',
    },
    {
      title: 'Support for all meeting platforms',
      body: 'Works with any meeting you join on your computer — Zoom, Google Meet, Microsoft Teams, Webex, Slack huddles, and more.',
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
          Why use the desktop app?
        </h2>
        <p className="mt-6 text-lg text-muted-foreground sm:text-xl">
          All the functionality of the web app and more.
        </p>
        <a
          href="/api/download"
          onClick={() => {
            posthog?.capture('cta_clicked', { location: 'meeting_notes_desktop', type: 'download_macos' })
          }}
          className="mt-8 inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
          Download for macOS
        </a>
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

// ─── Section 4: Integrations ─────────────────────────────────
function IntegrationsSection() {
  const integrations = [
    {
      icon: <GoogleCalendarIcon className="h-6 w-6" />,
      name: 'Google Calendar',
      body: 'Connect your calendar so meetings are captured with full context.',
    },
    {
      icon: <GmailIcon className="h-6 w-6" />,
      name: 'Gmail',
      body: 'See email context alongside your meetings, with AI-drafted replies.',
    },
    {
      icon: <OutlookIcon className="h-6 w-6" />,
      name: 'Outlook',
      body: 'Connect your Microsoft calendar and email.',
    },
    {
      icon: <SlackIcon className="h-6 w-6" />,
      name: 'Slack',
      body: 'Send notes and action items to your channels.',
    },
    {
      icon: <LinearIcon className="h-6 w-6" />,
      name: 'Linear',
      body: 'Push action items from meetings straight into issues — two-way.',
    },
    {
      icon: <JiraIcon className="h-6 w-6" />,
      name: 'Jira',
      body: 'Create and sync issues from meeting action items.',
    },
    {
      icon: <AsanaIcon className="h-6 w-6" />,
      name: 'Asana',
      body: 'Turn decisions into Asana tasks automatically.',
    },
    {
      icon: <HubSpotIcon className="h-6 w-6" />,
      name: 'HubSpot',
      body: 'Update contacts and deals after every customer call.',
    },
    {
      icon: <Plug className="h-6 w-6 text-muted-foreground" />,
      name: 'MCP',
      body: 'Connect AI apps like ChatGPT, Claude, and Cursor to your Native Intelligence workspace.',
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
          Connect your favorite apps
        </h2>
        <p className="mt-6 mx-auto max-w-2xl text-lg text-muted-foreground">
          Send action items where work happens, assign them automatically, and
          keep everything in sync.
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

// ─── Section 5: FAQ ──────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: 'Does Native Intelligence work for in-person meetings?',
    a: 'Yes. Record from the desktop app or your browser microphone — no video call required.',
  },
  {
    q: 'Can I use Native Intelligence without a bot joining my calls?',
    a: 'Yes — that’s the default. The desktop app records from your computer, so nothing ever joins the meeting.',
  },
  {
    q: 'What meeting platforms does Native Intelligence work with?',
    a: 'Any meeting you join from your computer: Zoom, Google Meet, Microsoft Teams, Webex, Slack huddles, phone calls, and more.',
  },
  {
    q: 'Is my data used to train AI models?',
    a: 'No. Your conversations and notes are never used to train AI models.',
  },
  {
    q: 'Does Native Intelligence do more than meeting notes?',
    a: 'Yes. Notes flow into a full workspace: task tracking with sprints, a CRM with interaction history, email, and an AI assistant that knows your work.',
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

// ─── Section 6: Closing CTA ──────────────────────────────────
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
            Try it free.
            <br />
            <span className="text-muted-foreground">Keep it if you love it.</span>
          </h2>
          <div className="mt-10 flex flex-col items-center gap-6">
            <PrimaryCta location="meeting_notes_cta" />
            <div className="w-full max-w-md">
              <p className="mb-3 text-sm text-muted-foreground">
                Want it for your whole team? Join the waitlist.
              </p>
              <EarlyAccessForm
                source="meeting_notes_waitlist"
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

export default function MeetingNotesPage() {
  const router = useRouter()

  // Desktop-shell users get redirected into the app — identical to the other
  // two variants. Pure side effect: the page always renders (including SSR)
  // so crawlers get the full marketing HTML.
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
        <DesktopSection />
        <IntegrationsSection />
        <FaqSection />
        <CTASection />
      </main>
      <Footer />
    </PageLayout>
  )
}
