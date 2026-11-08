import type { Metadata } from 'next'
import { ArrowUpRight } from 'lucide-react'
import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { PageLayout } from '@/components/page-layout'
import { RoadmapTimeline } from '@/components/roadmap/roadmap-timeline'
import { ROADMAP_ISSUES_URL, ROADMAP_PROJECT_URL, ROADMAP_SUGGEST_URL } from '@/lib/roadmap/constants'
import { getRoadmap } from '@/lib/roadmap/fetch'

// Rebuilt at most every five minutes, like the GitHub fetch it shows
// (ROADMAP_REVALIDATE_SECONDS; segment config must be a literal).
export const revalidate = 300

const DESCRIPTION =
  'See what we are building for Native Intelligence, vote on what matters to you, and suggest what is missing.'

export const metadata: Metadata = {
  // Absolute: the root template appends the old product name.
  title: { absolute: 'Roadmap - Native Intelligence' },
  description: DESCRIPTION,
  alternates: { canonical: '/roadmap' },
  openGraph: {
    title: 'Roadmap - Native Intelligence',
    description: DESCRIPTION,
    url: 'https://dial8.ai/roadmap',
    type: 'website',
  },
}

export default async function RoadmapPage() {
  const data = await getRoadmap()

  return (
    <PageLayout>
      <Navbar />
      <main>
        {/* Intro */}
        <div className="pt-36 pb-12 px-6 lg:px-8">
          <div className="mx-auto max-w-4xl text-center">
            <span className="inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Roadmap
            </span>
            <h1 className="mt-4 text-4xl font-medium tracking-tight text-foreground sm:text-5xl">
              What we are building.
            </h1>
            <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
              The Native Intelligence roadmap is public. Vote on what matters to you. Suggest
              what is missing. The votes help us decide what comes next.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href={ROADMAP_SUGGEST_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Suggest a feature
              </a>
              <a
                href={ROADMAP_ISSUES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
              >
                View on GitHub
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </a>
              <a
                href={ROADMAP_PROJECT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
              >
                Timeline on GitHub
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </a>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <section className="px-6 lg:px-8 pb-24 relative">
          <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
            <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
          </div>
          <div className="mx-auto max-w-5xl pt-16">
            <RoadmapTimeline data={data} />
            <p className="mt-12 text-center text-sm text-muted-foreground">
              Vote with a 👍 or 👎 on any item&apos;s GitHub issue. Each column is sorted by votes.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </PageLayout>
  )
}
