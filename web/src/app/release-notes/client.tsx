'use client'

import { Footer } from '@/components/footer'
import { Navbar } from '@/components/navbar'
import { ContentSection, PageHeader, PageLayout, type Section } from '@/components/page-layout'
import { releases } from '@/data/releases'
import dayjs from 'dayjs'

const sections: Section[] = releases.map((release) => ({
  id: `v${release.version.replace(/\./g, '-')}`,
  label: `v${release.version}`,
}))

export default function ReleaseNotes() {
  return (
    <PageLayout sections={sections}>
      <div>
        <Navbar />
        <PageHeader
          eyebrow="Product Updates"
          title="Release Notes"
          description="Stay up to date with the latest features, improvements, and fixes to Native Intelligence."
        />

        <main className="pb-24">
          {releases.map((release, index) => (
            <ContentSection
              key={release.version}
              id={`v${release.version.replace(/\./g, '-')}`}
              isFirst={index === 0}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
                <h2 className="text-2xl font-medium tracking-tight text-gray-950 dark:text-white">
                  Version {release.version}
                </h2>
                <time className="text-sm text-muted-foreground">
                  {dayjs(release.date).format('MMMM D, YYYY')}
                </time>
              </div>

              {release.warning && (
                <div className="mt-6 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/30 dark:text-amber-300">
                  <span className="shrink-0">⚠️</span>
                  <span>{release.warning}</span>
                </div>
              )}

              <div className="mt-8 space-y-8">
                {release.changes.features && release.changes.features.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      New Features
                    </h3>
                    <ul className="mt-4 space-y-3 text-gray-700 dark:text-gray-300">
                      {release.changes.features.map((feature, idx) => (
                        <li key={idx} className="flex gap-3">
                          <span className="text-gray-400 dark:text-gray-600">-</span>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {release.changes.improvements && release.changes.improvements.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      Improvements
                    </h3>
                    <ul className="mt-4 space-y-3 text-gray-700 dark:text-gray-300">
                      {release.changes.improvements.map((improvement, idx) => (
                        <li key={idx} className="flex gap-3">
                          <span className="text-gray-400 dark:text-gray-600">-</span>
                          <span>{improvement}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {release.changes.fixes && release.changes.fixes.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      Bug Fixes
                    </h3>
                    <ul className="mt-4 space-y-3 text-gray-700 dark:text-gray-300">
                      {release.changes.fixes.map((fix, idx) => (
                        <li key={idx} className="flex gap-3">
                          <span className="text-gray-400 dark:text-gray-600">-</span>
                          <span>{fix}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </ContentSection>
          ))}
        </main>
      </div>
      <Footer />
    </PageLayout>
  )
}
