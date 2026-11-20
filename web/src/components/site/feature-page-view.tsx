'use client'

/**
 * The one template every feature deep dive is drawn with (/features/<slug>):
 * the opening (name, headline, a sentence, the signup button), the recorded
 * walkthrough when the feature has one and its live demo when it does not,
 * two paragraphs of why, the sections, the questions, and where to go next.
 *
 * It takes the slug, not the content: the content holds nothing a client
 * component cannot import, and the side panel's icon for the feature is
 * looked up the same way.
 */
import Link from 'next/link'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { ArrowRight, Check } from 'lucide-react'
import { Footer } from '@/components/footer'
import { useSignupHref } from '@/components/signup-href'
import { SiteShell } from '@/components/site/site-shell'
import { FaqList } from '@/components/site/faq'
import { FeatureVideo } from '@/components/site/feature-video'
import { AppScreen } from '@/components/demo/app-screen'
import { ContextPackageDemo, ExecutionDemo, HudTipsDemo, IntelligenceLoopDemo, LiveAgentDemo } from '@/components/landing/lazy-demos'
import { getFeature, type FeatureDemoKey, type FeatureSection } from '@/lib/marketing/features'
import { FEATURE_NAV } from '@/lib/marketing/site-nav'

// Where the feature is a screen of the app, the demo is the app itself on a made-up
// workspace (components/demo/app-screen.tsx). The rest (the desktop window beside a
// call, an agent's run) are the product's own components on written content
// (components/landing/lazy-demos.tsx). Never a drawing of the app.
function Demo({ name }: { name: FeatureDemoKey }) {
  switch (name) {
    case 'chat':
      return <AppScreen screen="chat" />
    case 'live-agent':
      return <LiveAgentDemo tools={false} />
    case 'action-stream':
      return <AppScreen screen="list" />
    case 'execution':
      return <ExecutionDemo />
    case 'crm-autolog':
      return <AppScreen screen="contact" />
    case 'intelligence-loop':
      return <IntelligenceLoopDemo />
    case 'capture':
      return <AppScreen screen="notes" />
    case 'notes-doc':
      return <AppScreen screen="notes" />
    case 'speaker-id':
      return <AppScreen screen="transcript" />
    case 'hud-tips':
      return <HudTipsDemo />
    case 'context-package':
      return <ContextPackageDemo />
  }
}

function SignupCta({ location }: { location: string }) {
  const posthog = usePostHog()
  const signupHref = useSignupHref()
  return (
    <a
      href={signupHref}
      onClick={() => posthog?.capture('cta_clicked', { location, type: 'sign_up' })}
      className="inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-primary px-6 py-2.5 text-base font-medium whitespace-nowrap text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
    >
      Sign up free
      <ArrowRight aria-hidden className="h-4 w-4" />
    </a>
  )
}

function Section({ section }: { section: FeatureSection }) {
  return (
    <motion.section
      id={section.id}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5 }}
      className="scroll-mt-20 lg:scroll-mt-10"
    >
      <h2 className="text-2xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-3xl text-balance">{section.title}</h2>
      <p className="mt-4 text-lg/8 text-muted-foreground text-pretty">{section.body}</p>
      {section.points && section.points.length > 0 && (
        <ul className="mt-6 space-y-3">
          {section.points.map((point) => (
            <li key={point} className="flex items-start gap-3 text-foreground/90">
              <Check aria-hidden className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      )}
      {section.demo && (
        <div className="mt-8 min-w-0">
          <Demo name={section.demo} />
        </div>
      )}
    </motion.section>
  )
}

export function FeaturePageView({ slug }: { slug: string }) {
  const feature = getFeature(slug)
  if (!feature) return null

  const Icon = FEATURE_NAV.find((item) => item.href === `/features/${feature.slug}`)?.icon
  const related = feature.related
    .map((other) => FEATURE_NAV.find((item) => item.href === `/features/${other}`))
    .filter((item) => item !== undefined)
  const outline = [
    ...feature.sections.map((section) => ({ id: section.id, label: section.nav })),
    ...(feature.faq.length > 0 ? [{ id: 'faq', label: 'FAQ' }] : []),
  ]

  return (
    <SiteShell outline={outline}>
      <main className="px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <header className="pt-14 text-center sm:pt-20">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
              <p className="inline-flex items-center gap-2 font-mono text-xs/5 font-semibold uppercase tracking-widest text-muted-foreground">
                {Icon && <Icon aria-hidden className="h-4 w-4" />}
                {feature.name}
              </p>
              <h1 className="mt-5 text-4xl/[1.1] font-heading font-light tracking-[-0.02em] text-foreground sm:text-5xl/[1.08] text-balance">
                {feature.title}
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground text-pretty">{feature.lead}</p>
              <div className="mt-8">
                <SignupCta location={`feature_${feature.slug}_hero`} />
              </div>
              {feature.worksWith && <p className="mt-5 text-sm text-muted-foreground">{feature.worksWith}</p>}
            </motion.div>
          </header>

          {(feature.video || feature.demo) && (
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.15 }}
              className="mt-14 min-w-0"
            >
              {feature.video ? <FeatureVideo video={feature.video} name={feature.name} /> : feature.demo && <Demo name={feature.demo} />}
            </motion.div>
          )}

          <div className="mx-auto max-w-2xl">
            <div className="mt-16 space-y-5">
              {feature.intro.map((paragraph) => (
                <p key={paragraph} className="text-lg/8 text-foreground/80 text-pretty">
                  {paragraph}
                </p>
              ))}
            </div>

            <div className="mt-24 space-y-24">
              {feature.sections.map((section) => (
                <Section key={section.id} section={section} />
              ))}
            </div>

            {feature.faq.length > 0 && (
              <section id="faq" className="mt-28 scroll-mt-20 lg:scroll-mt-10">
                <h2 className="text-2xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-3xl">Questions</h2>
                <div className="mt-4">
                  <FaqList items={feature.faq} />
                </div>
              </section>
            )}

            {related.length > 0 && (
              <section className="mt-24">
                <h2 className="text-sm font-medium text-muted-foreground">Works with</h2>
                <ul className="mt-4 grid gap-3 sm:grid-cols-3">
                  {related.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="group flex items-center justify-between gap-3 rounded-2xl border border-border bg-secondary/30 px-4 py-3.5 transition-colors hover:bg-secondary/60"
                      >
                        <span className="flex items-center gap-2.5 font-medium text-foreground">
                          <item.icon aria-hidden className="h-4 w-4 text-muted-foreground" />
                          {item.name}
                        </span>
                        <ArrowRight aria-hidden className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <section className="py-28 text-center">
            <h2 className="text-3xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-4xl text-balance">
              Bring your team into one workspace.
              <br />
              <span className="text-muted-foreground">Try it free for 7 days.</span>
            </h2>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <SignupCta location={`feature_${feature.slug}_cta`} />
              <Link
                href="/pricing"
                className="inline-flex items-center justify-center rounded-full border border-border bg-background px-6 py-2.5 text-base font-medium whitespace-nowrap text-foreground shadow-sm transition-colors hover:bg-accent"
              >
                See pricing
              </Link>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </SiteShell>
  )
}
