'use client'

/**
 * /replace-apps: pick the apps a team pays for today, set the number of
 * seats, and see the yearly bill beside Native Intelligence's.
 *
 * THE SUM IS SHOWN AS IT COMES OUT. The apps' prices are their vendors'
 * published list prices (lib/marketing/replace-apps.ts, each with the page it
 * was read from and the day it was read), ours is the pricing page's, and
 * when the apps picked cost less than we do the page says so in the same
 * place it would have shown a saving.
 */
import Link from 'next/link'
import { motion } from 'framer-motion'
import { usePostHog } from 'posthog-js/react'
import { ArrowRight, Check, Layers } from 'lucide-react'
import { Footer } from '@/components/footer'
import { useSignupHref } from '@/components/signup-href'
import { SiteShell } from '@/components/site/site-shell'
import { REPLACED_APPS } from '@/lib/marketing/replace-apps'
import { StackCalculator } from '@/components/site/stack-calculator'
import { SWITCHING_GUIDE } from '@/lib/marketing/site-nav'

const cents = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const OUTLINE = [
  { id: 'calculator', label: 'Your stack' },
  { id: 'moving', label: 'Moving in' },
  { id: 'more', label: 'More than the sum' },
]

export function ReplaceAppsView() {
  const posthog = usePostHog()
  const signupHref = useSignupHref()
  return (
    <SiteShell outline={OUTLINE}>
      <main className="px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <header className="pt-14 text-center sm:pt-20">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
              <p className="inline-flex items-center gap-2 font-mono text-xs/5 font-semibold uppercase tracking-widest text-muted-foreground">
                <Layers aria-hidden className="h-4 w-4" />
                One workspace
              </p>
              <h1 className="mt-5 text-4xl/[1.1] font-heading font-light tracking-[-0.02em] text-foreground sm:text-5xl/[1.08] text-balance">Replace the stack.</h1>
              <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground text-pretty">
                Chat, tasks, docs, meeting notes, scheduling and a CRM, in one app with one bill and an agent that works across all of it.
              </p>
              <div className="mt-8">
                <a
                  href={signupHref}
                  onClick={() => posthog?.capture('cta_clicked', { location: 'replace_apps_hero', type: 'sign_up' })}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-primary px-6 py-2.5 text-base font-medium whitespace-nowrap text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
                >
                  Sign up free
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </header>

          <div className="mx-auto max-w-2xl">
            <div className="mt-16 space-y-5">
              <p className="text-lg/8 text-foreground/80 text-pretty">
                A growing team ends up paying for a dozen tools that each hold a piece of the same work. The email is in one, the task it became is in another, the call about it is in a third, and the customer it belongs to is in a fourth.
              </p>
              <p className="text-lg/8 text-foreground/80 text-pretty">
                Native Intelligence puts those pieces in one workspace. You pay for one thing, and the work stays joined up: a thread becomes a task, a call updates the customer, and your agent can act on all of it because it can see all of it.
              </p>
            </div>

            <section id="calculator" className="mt-20 scroll-mt-20 lg:scroll-mt-10">
              <h2 className="text-2xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-3xl">Add up your stack.</h2>
              <p className="mt-4 text-lg/8 text-muted-foreground">Pick what your team pays for today, and set your seats.</p>

              <div className="mt-10">
                <StackCalculator />
              </div>

              <details className="mt-8 text-sm text-muted-foreground">
                <summary className="cursor-pointer text-foreground/80 hover:text-foreground">The plans and where each price comes from</summary>
                <ul className="mt-3 space-y-1.5">
                  {REPLACED_APPS.map((app) => (
                    <li key={app.name}>
                      {app.name} {app.plan}: {cents(app.price)}
                      {app.billing === 'annual' ? ', billed annually' : app.billing === 'monthly' ? ', billed monthly' : ''} (
                      <a href={app.source} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-4 hover:text-foreground">
                        source
                      </a>
                      )
                    </li>
                  ))}
                </ul>
              </details>
            </section>

            <section id="moving" className="mt-24 scroll-mt-20 lg:scroll-mt-10">
              <h2 className="text-2xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-3xl">Moving in.</h2>
              <p className="mt-4 text-lg/8 text-muted-foreground text-pretty">
                Sign in with Google or Microsoft and your email and calendar are here: the addresses stay yours, and this becomes the app you use them in. Bring your companies and contacts over from HubSpot or a spreadsheet, and import your CSV and Excel files into tables. Then cancel what you no longer open.
              </p>
              <p className="mt-5">
                <Link href={SWITCHING_GUIDE} className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
                  Read the switching guide
                  <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </p>
            </section>

            <section id="more" className="mt-24 scroll-mt-20 lg:scroll-mt-10">
              <h2 className="text-2xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-3xl">More than the sum.</h2>
              <p className="mt-4 text-lg/8 text-muted-foreground text-pretty">
                The saving is the smaller half. Twenty apps cannot share what they know, so people carry it between them. In one workspace an always-on agent can read the call, the thread and the record together, do the follow-up, and text you when it needs a yes.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  'One memory across mail, chat, meetings, docs, tasks and customers',
                  'An agent that learns how you work and acts on it',
                  'One bill, one login, one place to look',
                ].map((point) => (
                  <li key={point} className="flex items-start gap-3 text-foreground/90">
                    <Check aria-hidden className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="py-28 text-center">
            <h2 className="text-3xl font-heading font-light tracking-[-0.02em] text-foreground sm:text-4xl text-balance">
              Bring your team into one workspace.
              <br />
              <span className="text-muted-foreground">Try it free for 7 days.</span>
            </h2>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={signupHref}
                onClick={() => posthog?.capture('cta_clicked', { location: 'replace_apps_cta', type: 'sign_up' })}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-primary px-6 py-2.5 text-base font-medium whitespace-nowrap text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
              >
                Sign up free
                <ArrowRight aria-hidden className="h-4 w-4" />
              </a>
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
