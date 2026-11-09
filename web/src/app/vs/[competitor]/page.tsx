import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Check, Minus } from 'lucide-react'
import { Footer } from '@/components/footer'
import { Link } from '@/components/link'
import { Navbar } from '@/components/navbar'
import { PageLayout } from '@/components/page-layout'
import { StructuredData } from '@/components/structured-data'
import {
  COMPETITORS,
  VS_COMPETITOR_SLUGS,
  DIAL8_STRENGTHS,
  getCompetitor,
  type Cell,
  type Competitor,
} from '@/data/vs-competitors'
import { hasDownload } from '@/lib/app-download'

const BASE_URL = 'https://dial8.ai'

// Only the listed competitors: any other slug is a 404, including ones that
// would hit an inherited property on COMPETITORS ('constructor', 'toString').
export const dynamicParams = false

export function generateStaticParams() {
  return VS_COMPETITOR_SLUGS.map((competitor) => ({ competitor }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ competitor: string }>
}): Promise<Metadata> {
  const { competitor: slug } = await params
  const competitor = getCompetitor(slug)
  if (!competitor) return {}

  const canonical = `/vs/${competitor.slug}`
  return {
    // metaTitle already leads with "Native Intelligence", so bypass the root "%s - Native Intelligence"
    // template to avoid a doubled brand name in the rendered <title>.
    title: { absolute: competitor.metaTitle },
    description: competitor.metaDescription,
    alternates: { canonical },
    openGraph: {
      title: competitor.metaTitle,
      description: competitor.metaDescription,
      url: `${BASE_URL}${canonical}`,
      type: 'website',
    },
  }
}

/* ── Cell renderers ── */

function CellContent({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <Check className="h-4 w-4 text-foreground" aria-hidden />
        <span className="sr-only">Yes</span>
      </span>
    )
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground/50">
        <Minus className="h-4 w-4" aria-hidden />
        <span className="sr-only">No</span>
      </span>
    )
  }
  return <span className="text-sm text-muted-foreground">{value}</span>
}

/* ── Sections ── */

function Hero({ competitor }: { competitor: Competitor }) {
  return (
    <section className="relative flex items-center pt-40 pb-16 px-6 lg:px-8">
      <div className="mx-auto max-w-4xl w-full">
        <p className="font-mono text-xs/5 font-semibold uppercase tracking-widest text-muted-foreground">
          Comparison
        </p>
        <h1 className="mt-2 text-pretty text-4xl font-medium tracking-tight text-foreground sm:text-5xl lg:text-6xl">
          Native Intelligence vs {competitor.name}
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl leading-relaxed">
          {competitor.name} is {competitor.tagline}. Native Intelligence takes the meeting
          further — turning it into tracked work, live projects, a self-updating
          CRM, and agents that execute. Here is an honest, side-by-side look.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-start sm:items-center gap-3">
          {hasDownload() && (
            <a
              href="/api/download"
              className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              Download for macOS
            </a>
          )}
          <Link
            href="/pricing"
            className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
          >
            See pricing
          </Link>
        </div>
      </div>
    </section>
  )
}

function SectionDivider() {
  return (
    <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
      <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
    </div>
  )
}

function Verdict({ competitor }: { competitor: Competitor }) {
  return (
    <section className="px-6 lg:px-8 py-20 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <div className="rounded-2xl border-[1.5px] border-border p-6 sm:p-8 relative">
          <div className="absolute -top-3 left-6 sm:left-8 px-3 bg-background">
            <span className="text-sm font-medium tracking-wide text-foreground">THE SHORT VERSION</span>
          </div>
          <p className="text-lg leading-relaxed text-foreground/80">{competitor.verdict}</p>
        </div>
      </div>
    </section>
  )
}

function Matrix({ competitor }: { competitor: Competitor }) {
  return (
    <section className="px-6 lg:px-8 py-20 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
          Feature-by-feature
        </h2>
        <p className="mt-3 text-muted-foreground">
          Both tools capture, transcribe, and summarize meetings well. The
          differences start after the summary.
        </p>

        <div className="mt-8 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <caption className="sr-only">
              Feature comparison between Native Intelligence and {competitor.name}
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th
                  scope="col"
                  className="px-4 py-4 text-sm font-medium text-muted-foreground"
                >
                  Capability
                </th>
                <th
                  scope="col"
                  className="px-4 py-4 text-sm font-semibold text-foreground w-[26%]"
                >
                  Native Intelligence
                </th>
                <th
                  scope="col"
                  className="px-4 py-4 text-sm font-semibold text-foreground w-[26%]"
                >
                  {competitor.name}
                </th>
              </tr>
            </thead>
            <tbody>
              {competitor.matrix.map((r) => (
                <tr key={r.feature} className="border-b border-border last:border-0 align-top">
                  <th scope="row" className="px-4 py-4 text-left font-normal">
                    <span className="text-sm font-medium text-foreground">{r.feature}</span>
                    {r.detail && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {r.detail}
                      </span>
                    )}
                  </th>
                  <td className="px-4 py-4">
                    <CellContent value={r.dial8} />
                  </td>
                  <td className="px-4 py-4">
                    <CellContent value={r.competitor} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {competitor.name} details reflect their published material as of July
          2026 and may change. Both products transcribe and summarize meetings —
          this table highlights where they diverge.
        </p>
      </div>
    </section>
  )
}

function TheirStrengths({ competitor }: { competitor: Competitor }) {
  return (
    <section className="px-6 lg:px-8 py-20 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
          Where {competitor.name} wins
        </h2>
        <p className="mt-3 text-muted-foreground">
          A comparison is only useful if it is honest. Here is what {competitor.name}{' '}
          genuinely does well.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {competitor.theirStrengths.map((s) => (
            <div key={s.title} className="rounded-2xl border border-border p-6">
              <h3 className="text-sm font-medium text-foreground">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function DialWins({ competitor }: { competitor: Competitor }) {
  return (
    <section className="px-6 lg:px-8 py-20 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
          Where Native Intelligence wins
        </h2>
        <p className="mt-3 text-muted-foreground">
          {competitor.name}&rsquo;s output lives in notes and hands off to other
          tools. With Native Intelligence, the meeting output is the tracker — the work gets
          done in the same system.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {DIAL8_STRENGTHS.map((s) => (
            <div key={s.title} className="rounded-2xl border border-border p-6">
              <h3 className="text-sm font-medium text-foreground">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Faqs({ competitor }: { competitor: Competitor }) {
  return (
    <section className="px-6 lg:px-8 py-20 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
          Frequently asked
        </h2>
        <dl className="mt-8 divide-y divide-border rounded-2xl border border-border">
          {competitor.faqs.map((f) => (
            <div key={f.q} className="px-6 py-5">
              <dt className="text-base font-medium text-foreground">{f.q}</dt>
              <dd className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function Cta() {
  return (
    <section className="px-6 lg:px-8 py-20 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
          Turn your meetings into work that ships
        </h2>
        <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
          Bot-free capture, a real task system, live projects, a self-updating
          CRM, and agents that execute — in one workspace.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          {hasDownload() && (
            <a
              href="/api/download"
              className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              Download for macOS
            </a>
          )}
          <Link
            href="/pricing"
            className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
          >
            See pricing
          </Link>
        </div>
      </div>
    </section>
  )
}

function CompareNav({ current }: { current: string }) {
  return (
    <section className="px-6 lg:px-8 py-16 relative">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-medium text-muted-foreground">Compare Native Intelligence with</p>
        <nav className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          {VS_COMPETITOR_SLUGS.map((slug, i) => {
            const c = COMPETITORS[slug]
            const isCurrent = slug === current
            return (
              <span key={slug} className="flex items-center gap-2">
                {i > 0 && <span className="text-border">·</span>}
                {isCurrent ? (
                  <span className="font-medium text-foreground">{c.name}</span>
                ) : (
                  <Link
                    href={`/vs/${slug}`}
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {c.name}
                  </Link>
                )}
              </span>
            )
          })}
          <span className="text-border">·</span>
          <Link
            href="/ai-work-environment"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            What is an AI work environment?
          </Link>
        </nav>
      </div>
    </section>
  )
}

/* ── FAQPage JSON-LD ── */

function faqSchema(competitor: Competitor) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: competitor.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.a,
      },
    })),
  }
}

export default async function VsCompetitorPage({
  params,
}: {
  params: Promise<{ competitor: string }>
}) {
  const { competitor: slug } = await params
  const competitor = getCompetitor(slug)
  if (!competitor) notFound()

  return (
    <PageLayout>
      <Navbar />
      <StructuredData
        id={`faq-vs-${competitor.slug}`}
        data={faqSchema(competitor)}
      />
      <main>
        <Hero competitor={competitor} />
        <Verdict competitor={competitor} />
        <Matrix competitor={competitor} />
        <TheirStrengths competitor={competitor} />
        <DialWins competitor={competitor} />
        <Faqs competitor={competitor} />
        <Cta />
        <CompareNav current={competitor.slug} />
      </main>
      <Footer />
    </PageLayout>
  )
}
