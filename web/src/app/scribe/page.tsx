import { Footer } from '@/components/footer'
import { Link } from '@/components/link'
import { Navbar } from '@/components/navbar'
import { PageLayout } from '@/components/page-layout'
import { GitHubStars } from '@/components/github-stars'
import { StructuredData, scribeSoftwareApplicationSchema } from '@/components/structured-data'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: { absolute: 'Native Intelligence Scribe - Open Source Speech to Text for macOS' },
  description:
    'Hold a hotkey, speak, release. Your words appear as text anywhere on your Mac. Powered by Whisper. Free and open source.',
  alternates: { canonical: '/scribe' },
  openGraph: {
    title: 'Native Intelligence Scribe - Open Source Speech to Text for macOS',
    description:
      'Hold a hotkey, speak, release. Your words appear as text anywhere on your Mac. Powered by Whisper. Free and open source.',
    url: 'https://dial8.ai/scribe',
    type: 'website',
  },
}

function GitHubIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

const FEATURES = [
  {
    title: 'Powered by Whisper',
    description: 'Uses OpenAI Whisper for accurate, fast transcription. Runs locally on your Mac for complete privacy.',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
  },
  {
    title: 'Works everywhere',
    description: 'Types into any app — Slack, your IDE, browser, email. Anywhere you can type, Scribe types for you.',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 01-9 9m9-14.25v.002" />
      </svg>
    ),
  },
  {
    title: 'Native macOS',
    description: 'Lives in your menu bar, uses minimal resources, starts on login. Built as a true native app.',
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
      </svg>
    ),
  },
  {
    title: 'Customizable hotkey',
    description: 'Choose any key combination. Hold to record, release to transcribe — or toggle mode for longer dictation.',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    title: 'Two modes',
    description: 'Hold-to-record for quick messages. Toggle mode — press once to start, press again to stop — for longer dictation.',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
      </svg>
    ),
  },
  {
    title: 'Fully open source',
    description: 'MIT licensed. Inspect the code, contribute, or fork it. No telemetry, no accounts, no strings attached.',
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
      </svg>
    ),
  },
]

export default function ScribePage() {
  return (
    <PageLayout>
      <StructuredData id="scribe-software-schema" data={scribeSoftwareApplicationSchema} />
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative min-h-[80vh] flex items-center pt-40 pb-20 px-6 lg:px-8">
          <div className="mx-auto max-w-5xl w-full">
            <div className="text-center">
              <span className="inline-block rounded-full bg-foreground/10 backdrop-blur-xs border border-foreground/20 px-4 py-1.5 text-sm font-medium text-foreground mb-6">
                Open Source &middot; Free Forever
              </span>
              <h1 className="text-4xl font-medium tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                Your voice, instantly
                <br />
                <span className="text-muted-foreground">turned into text.</span>
              </h1>
              <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
                Hold a hotkey, speak naturally, release. Your words appear as text wherever
                your cursor is. No switching apps, no transcription windows. Just talk.
              </p>

              <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
                <a
                  href="https://pub-7af480975f634f5cae24da512cfb7e1b.r2.dev/Dial8-Scribe.dmg"
                  className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                  Download for macOS
                </a>
                <a
                  href="https://github.com/liamadsr/dial8-open-source"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
                >
                  <GitHubIcon />
                  View on GitHub
                  <span className="text-foreground/30">&middot;</span>
                  <GitHubStars />
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* How it works — simple diagram */}
        <section className="px-6 lg:px-8 pb-24 relative">
          <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
            <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
          </div>
          <div className="mx-auto max-w-5xl pt-24">
            <div className="text-center mb-12">
              <span className="inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                How It Works
              </span>
              <h2 className="mt-4 text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
                Three steps. Zero friction.
              </h2>
            </div>

            {/* System diagram — matching main page style */}
            <div className="relative rounded-2xl border-[1.5px] border-border p-6 sm:p-8 lg:p-10">
              <div className="absolute -top-3 left-6 sm:left-8 lg:left-10 px-3 bg-background">
                <span className="text-sm font-medium tracking-wide text-foreground">DIAL8 SCRIBE</span>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-8">
                {/* Step 1: Input */}
                <div className="flex flex-col items-center text-center shrink-0 sm:w-36">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl border-[1.5px] border-border bg-muted">
                    <svg className="h-6 w-6 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                    </svg>
                  </div>
                  <p className="mt-3 text-sm font-medium text-foreground">Press &amp; hold</p>
                  <p className="mt-1 text-xs text-muted-foreground">Any hotkey you choose</p>
                </div>

                {/* Arrow */}
                <div className="hidden sm:flex items-center shrink-0 gap-0">
                  <div className="w-10 h-[2px] bg-muted-foreground/50" />
                  <div className="w-0 h-0 border-t-[4px] border-t-transparent border-b-[4px] border-b-transparent border-l-[6px] border-l-muted-foreground/50" />
                </div>
                <div className="flex sm:hidden flex-col items-center justify-center py-1 gap-0">
                  <div className="h-8 w-[2px] bg-muted-foreground/50" />
                  <div className="w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[6px] border-t-muted-foreground/50" />
                </div>

                {/* Step 2: Processing */}
                <div className="relative flex-1 w-full rounded-xl border-[1.5px] border-border p-6">
                  <div className="absolute -top-2.5 left-4 px-2 bg-background">
                    <span className="text-xs font-medium tracking-wide text-muted-foreground">Whisper — local transcription</span>
                  </div>

                  <div className="flex flex-col items-center text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border-[1.5px] border-border bg-muted">
                      <svg className="h-6 w-6 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                      </svg>
                    </div>
                    <p className="mt-3 text-sm font-medium text-foreground">Speak</p>
                    <p className="mt-1 text-xs text-muted-foreground">Whisper listens &amp; extracts text</p>
                  </div>
                </div>

                {/* Arrow */}
                <div className="hidden sm:flex items-center shrink-0 gap-0">
                  <div className="w-10 h-[2px] bg-muted-foreground/50" />
                  <div className="w-0 h-0 border-t-[4px] border-t-transparent border-b-[4px] border-b-transparent border-l-[6px] border-l-muted-foreground/50" />
                </div>
                <div className="flex sm:hidden flex-col items-center justify-center py-1 gap-0">
                  <div className="h-8 w-[2px] bg-muted-foreground/50" />
                  <div className="w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-t-[6px] border-t-muted-foreground/50" />
                </div>

                {/* Step 3: Output */}
                <div className="flex flex-col items-center text-center shrink-0 sm:w-36">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl border-[1.5px] border-border bg-muted">
                    <svg className="h-6 w-6 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                  </div>
                  <p className="mt-3 text-sm font-medium text-foreground">Text appears</p>
                  <p className="mt-1 text-xs text-muted-foreground">Right where your cursor is</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="px-6 lg:px-8 pb-24 relative">
          <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
            <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
          </div>
          <div className="mx-auto max-w-5xl pt-24">
            <div className="text-center mb-12">
              <span className="inline-block rounded-full bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Features
              </span>
              <h2 className="mt-4 text-3xl font-medium tracking-tight text-foreground sm:text-4xl">
                Simple tool. Thoughtful details.
              </h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="rounded-2xl border border-border p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
                    {feature.icon}
                  </div>
                  <h3 className="mt-4 text-sm font-medium text-foreground">{feature.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Scribe + Native Intelligence cross-sell */}
        <section className="px-6 lg:px-8 pb-24 relative">
          <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
            <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
          </div>
          <div className="mx-auto max-w-4xl pt-24 text-center">
            <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
              Use Scribe alongside Native Intelligence
            </h2>
            <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
              Scribe handles quick dictation — typing messages, writing emails, jotting notes.
              Native Intelligence handles the bigger picture — capturing meetings, managing projects, and executing work with AI.
              They work great together.
            </p>
            <div className="mt-8">
              <Link
                href="/"
                className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
              >
                Learn about Native Intelligence
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </PageLayout>
  )
}
