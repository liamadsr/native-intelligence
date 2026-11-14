import { Fragment } from 'react'
import { CompareLinks } from '@/components/compare-links'
import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { PageLayout } from '@/components/page-layout'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Metadata } from 'next'
import { appUrl } from '@/lib/app-url'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    '7-day free trial, then $99 per user per month for the whole workspace — mail, chat, meetings, docs, tasks, customers and the agents that work across them. Teams and enterprises, talk to us about volume pricing.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Pricing – Native Intelligence',
    description:
      '7-day free trial, then $99 per user per month for the whole workspace — mail, chat, meetings, docs, tasks, customers and the agents that work across them. Teams and enterprises, talk to us about volume pricing.',
    url: `${appUrl()}/pricing`,
    type: 'website',
  },
}

/* ── Feature comparison data (mirrors billing-view.tsx) ── */

type FeatureValue = true | false | string

interface FeatureRow {
  name: string
  free: FeatureValue
  pro: FeatureValue
  enterprise: FeatureValue
}

interface FeatureSection {
  title: string
  rows: FeatureRow[]
}

const FEATURE_SECTIONS: FeatureSection[] = [
  {
    title: 'Usage',
    rows: [
      { name: 'Team members',         free: '2',         pro: '$99 per seat', enterprise: 'Volume pricing' },
      { name: 'Workspaces',           free: '1',         pro: '5',         enterprise: 'Unlimited' },
    ],
  },
  {
    title: 'Capture',
    rows: [
      { name: 'Meeting capture',      free: true,  pro: true,  enterprise: true },
      { name: 'Transcription',        free: true,  pro: true,  enterprise: true },
      { name: 'Action extraction',    free: true,  pro: true,  enterprise: true },
      { name: 'Voice identification', free: false, pro: true,  enterprise: true },
    ],
  },
  {
    title: 'AI',
    rows: [
      { name: 'AI assistant',         free: true,  pro: true,  enterprise: true },
      { name: 'Advanced AI models',   free: false, pro: true,  enterprise: true },
      { name: 'AI email drafts',      free: false, pro: true,  enterprise: true },
      { name: 'Custom agents & skills', free: false, pro: true,  enterprise: true },
    ],
  },
  {
    title: 'Productivity',
    rows: [
      { name: 'Actions & projects',   free: true,  pro: true,  enterprise: true },
      { name: 'CRM & contacts',       free: true,  pro: true,  enterprise: true },
      { name: 'Custom views',         free: false, pro: true,  enterprise: true },
      { name: 'Workflows',            free: false, pro: true,  enterprise: true },
      { name: 'Outreach sequences',   free: false, pro: true,  enterprise: true },
    ],
  },
  {
    title: 'Integrations',
    rows: [
      { name: 'Calendar sync',        free: true,  pro: true,  enterprise: true },
      { name: 'Email integration',    free: false, pro: true,  enterprise: true },
      { name: 'GitHub integration',   free: false, pro: true,  enterprise: true },
      { name: 'MCP server',           free: false, pro: true,  enterprise: true },
      { name: 'Custom integrations',  free: false, pro: false, enterprise: true },
    ],
  },
  {
    title: 'Administration',
    rows: [
      { name: 'Team management',      free: true,  pro: true,  enterprise: true },
      { name: 'SSO & advanced auth',  free: false, pro: false, enterprise: true },
      { name: 'Dedicated support',    free: false, pro: false, enterprise: true },
      { name: 'SLA guarantees',       free: false, pro: false, enterprise: true },
      { name: 'Priority support',     free: false, pro: true,  enterprise: true },
    ],
  },
]

function FeatureCell({ value }: { value: FeatureValue }) {
  if (value === true) {
    return <Check className="mx-auto h-4 w-4 text-foreground/70" />
  }
  if (value === false) {
    return <span className="block text-center text-muted-foreground/40">&mdash;</span>
  }
  return <span className="block text-center text-sm">{value}</span>
}

export default function PricingPage() {
  return (
    <PageLayout>
      <Navbar />
      <main>
        {/* Header */}
        <div className="pt-36 pb-12 px-6 lg:px-8">
          <div className="mx-auto max-w-4xl text-center">
            <h1 className="text-4xl font-medium tracking-tight text-foreground sm:text-5xl">
              Simple pricing for your whole team.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
              Try everything free for 7 days, then $99 per seat. Add a card to start;
              cancel before the trial ends and you pay nothing. Every seat gets the whole
              workspace: mail, chat, bot-free meeting capture, docs, tasks, customers, and
              the agents that work across them.
            </p>
          </div>
        </div>

        {/* Comparison table */}
        <div className="px-6 lg:px-8 pb-24">
          <div className="mx-auto max-w-4xl">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                {/* Plan headers */}
                <thead>
                  <tr className="border-b border-border">
                    <th className="w-[40%] p-4 text-left font-normal text-muted-foreground" />
                    <th className="w-[20%] p-4 text-center">
                      <div className="space-y-1">
                        <div className="font-semibold text-foreground">Free trial</div>
                        <div className="text-2xl font-semibold text-foreground">$0</div>
                        <div className="text-xs text-muted-foreground">7 days &middot; card required</div>
                      </div>
                    </th>
                    <th className="w-[20%] border-x border-border bg-primary/5 p-4 text-center">
                      <div className="space-y-1">
                        <div className="font-semibold text-foreground">Pro</div>
                        <div className="text-2xl font-semibold text-foreground">$99</div>
                        <div className="text-xs text-muted-foreground">per user / month</div>
                      </div>
                    </th>
                    <th className="w-[20%] p-4 text-center">
                      <div className="space-y-1">
                        <div className="font-semibold text-foreground">Teams &amp; Enterprise</div>
                        <div className="text-lg font-semibold text-foreground">Reach out</div>
                        <div className="text-xs text-muted-foreground">for your team</div>
                      </div>
                    </th>
                  </tr>

                  {/* CTA row */}
                  <tr className="border-b border-border">
                    <th className="p-4" />
                    <td className="p-4 text-center">
                      <a
                        href="/login?mode=signup"
                        className="inline-flex items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                      >
                        Start free trial
                      </a>
                    </td>
                    <td className="border-x border-border bg-primary/5 p-4 text-center">
                      <a
                        href="/login?mode=signup"
                        className="inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
                      >
                        Get started
                      </a>
                    </td>
                    <td className="p-4 text-center">
                      <a
                        href="mailto:liam@dial8.ai"
                        className="inline-flex items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                      >
                        Contact us
                      </a>
                    </td>
                  </tr>
                </thead>

                {/* Feature sections */}
                <tbody>
                  {FEATURE_SECTIONS.map((section) => (
                    <Fragment key={section.title}>
                      {/* Section header */}
                      <tr>
                        <td colSpan={4} className="px-4 pb-1 pt-5">
                          <span className="text-sm font-semibold text-foreground">{section.title}</span>
                        </td>
                      </tr>

                      {/* Feature rows */}
                      {section.rows.map((row, i) => (
                        <tr
                          key={row.name}
                          className={cn(
                            i < section.rows.length - 1 && 'border-b border-border/50',
                          )}
                        >
                          <td className="px-4 py-2.5 text-muted-foreground">{row.name}</td>
                          <td className="px-4 py-2.5">
                            <FeatureCell value={row.free} />
                          </td>
                          <td className="border-x border-border/50 bg-primary/5 px-4 py-2.5">
                            <FeatureCell value={row.pro} />
                          </td>
                          <td className="px-4 py-2.5">
                            <FeatureCell value={row.enterprise} />
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Every comparison one click from pricing (the home page links here). */}
            <div className="mt-12">
              <CompareLinks label="Switching tools? See how Native Intelligence compares with" centered />
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </PageLayout>
  )
}
