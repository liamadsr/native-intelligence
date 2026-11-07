import type { Metadata } from 'next'
import { Footer } from '@/components/footer'
import { Link } from '@/components/link'
import { Navbar } from '@/components/navbar'
import { PageLayout } from '@/components/page-layout'
import { StructuredData } from '@/components/structured-data'

const BASE_URL = 'https://dial8.ai'
const TITLE = 'What is an AI work environment?'
const DESCRIPTION =
  'An AI work environment is one system where capture, context, and execution meet — meetings feed a knowledge graph, work tracks itself, and agents act on it.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/ai-work-environment' },
  openGraph: {
    title: `${TITLE} — Dial8`,
    description: DESCRIPTION,
    url: `${BASE_URL}/ai-work-environment`,
    type: 'article',
  },
}

const articleSchema = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: TITLE,
  description: DESCRIPTION,
  mainEntityOfPage: {
    '@type': 'WebPage',
    '@id': `${BASE_URL}/ai-work-environment`,
  },
  author: { '@type': 'Organization', name: 'Dial8', url: BASE_URL },
  publisher: {
    '@type': 'Organization',
    name: 'Dial8',
    url: BASE_URL,
    logo: {
      '@type': 'ImageObject',
      url: `${BASE_URL}/screenshots/Icon-macOS-Dark-1024x1024@2x-dark.png`,
    },
  },
}

function SectionDivider() {
  return (
    <div className="absolute top-0 left-6 right-6 lg:left-8 lg:right-8">
      <div className="h-px bg-linear-to-r from-transparent via-border to-transparent" />
    </div>
  )
}

export default function AiWorkEnvironmentPage() {
  return (
    <PageLayout>
      <Navbar />
      <StructuredData id="article-ai-work-environment" data={articleSchema} />
      <main>
        {/* Hero / definition */}
        <section className="relative pt-40 pb-16 px-6 lg:px-8">
          <div className="mx-auto max-w-3xl w-full">
            <p className="font-mono text-xs/5 font-semibold uppercase tracking-widest text-muted-foreground">
              Category
            </p>
            <h1 className="mt-2 text-pretty text-4xl font-medium tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              What is an AI work environment?
            </h1>
            <p className="mt-6 text-xl text-foreground/80 leading-relaxed">
              An <strong className="font-medium text-foreground">AI work environment</strong> is a
              single system where capture, context, and execution are one loop —
              not three tools stitched together. Meetings, documents, and email
              feed a shared knowledge graph; work is tracked automatically as it
              is discussed; and AI agents act on that work with the full context
              behind it.
            </p>
          </div>
        </section>

        {/* Body */}
        <article className="px-6 lg:px-8 pb-8">
          <div className="mx-auto max-w-3xl text-base leading-7 text-foreground/80">
            {/* The definition, expanded */}
            <section className="relative py-16">
              <SectionDivider />
              <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
                A definition
              </h2>
              <p className="mt-6">
                For most teams, work happens across a stack of disconnected
                tools. A notetaker records the meeting. A project tracker holds
                the tasks. A CRM holds the relationships. A chat assistant
                answers questions. Email lives somewhere else entirely. Each is
                good at its job, and the person is the integration layer —
                copying an action item out of the summary, pasting it into the
                tracker, updating the CRM by hand, and remembering what was
                decided three meetings ago.
              </p>
              <p className="mt-4">
                An AI work environment collapses that stack. It treats the
                meeting, the task, the project, the contact, and the agent as
                parts of one system that share the same memory. When you finish a
                call, the environment does not just hand you notes — it knows
                which project the call was about, updates that project&rsquo;s
                status, files the follow-ups as tracked work, records what was
                decided, and can hand the next step to an agent. The human stops
                being the glue.
              </p>
            </section>

            {/* Why the categories are converging */}
            <section className="relative py-16">
              <SectionDivider />
              <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
                Why the categories are converging
              </h2>
              <p className="mt-6">
                Three product categories that used to be separate are collapsing
                into one. AI notetakers proved that meetings can be captured and
                understood without effort. Task trackers proved that work needs a
                durable home with structure — identifiers, states, cycles.
                And a new generation of AI agents proved that models can not only
                answer questions but take actions: write code, open pull
                requests, draft documents. Independently, each of these is a
                feature. Together, they are a workflow.
              </p>
              <p className="mt-4">
                The reason they are converging is simple: the seams between them
                are where work leaks out. An action item that lives only in a
                meeting summary is a task that no one owns. A CRM that depends on
                a human to log the call is a CRM that is always stale. An agent
                with no memory of the meeting that created the task is an agent
                guessing at intent. Teams are tired of being the connective
                tissue between tools that refuse to talk to each other. The
                environment that removes those seams wins.
              </p>

              <h3 className="mt-10 text-lg font-medium text-foreground">
                From recording to knowledge
              </h3>
              <p className="mt-4">
                A transcript is raw material; knowledge is what you can act on
                later. In an AI work environment, every conversation contributes
                durable facts — decisions, commitments, open questions — to a
                knowledge graph with provenance, so the answer to &ldquo;what did
                we decide about pricing?&rdquo; is one search away, not buried in
                the ninth recording from last quarter.
              </p>

              <h3 className="mt-10 text-lg font-medium text-foreground">
                From answers to actions
              </h3>
              <p className="mt-4">
                The last generation of AI meeting tools could summarize and chat.
                The current generation can execute. The difference between an
                assistant that tells you what to do and an agent that does it is
                the difference between a smarter notepad and an actual coworker.
                An AI work environment is built around the second one.
              </p>
            </section>

            {/* What qualifies */}
            <section className="relative py-16">
              <SectionDivider />
              <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
                What qualifies as an AI work environment
              </h2>
              <p className="mt-6">
                Not every tool with an AI feature is a work environment. A useful
                test is three properties, all present at once:
              </p>

              <h3 className="mt-10 text-lg font-medium text-foreground">
                1. Capture without friction
              </h3>
              <p className="mt-4">
                Context has to get in without anyone doing data entry. That means
                capturing meetings without a bot dialing into the call, pulling
                in email and calendar, and reading documents — so the raw
                material of work accumulates on its own. If capturing context is
                a chore, the environment stays empty.
              </p>

              <h3 className="mt-10 text-lg font-medium text-foreground">
                2. Context that accumulates
              </h3>
              <p className="mt-4">
                A work environment has memory. Facts, decisions, projects, and
                relationships build up over time and stay connected, so today&rsquo;s
                conversation is understood in light of everything that came
                before it. Tools without accumulating context restart from zero
                every session — they can summarize, but they cannot reason about
                your work.
              </p>

              <h3 className="mt-10 text-lg font-medium text-foreground">
                3. Agents with hands, not just answers
              </h3>
              <p className="mt-4">
                Finally, the environment has to be able to <em>do</em> things.
                Not only surface an action item, but track it; not only draft a
                reply, but send it; not only describe a code change, but open the
                pull request. Agents that execute — with the context of the
                meeting or project behind them — are what turn a knowledge system
                into a work system.
              </p>
            </section>

            {/* How Dial8 implements it */}
            <section className="relative py-16">
              <SectionDivider />
              <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
                How Dial8 implements it
              </h2>
              <p className="mt-6">
                Dial8 is built as an AI work environment from the ground up, not
                a notetaker with features bolted on. Capture is bot-free: the
                macOS and iOS apps record meetings locally, and email and
                calendar sync in, so context arrives without anyone joining a
                call or copying anything.
              </p>
              <p className="mt-4">
                From there, the meeting becomes work. Action items land in a real
                task system — with identifiers like{' '}
                <span className="font-mono text-sm text-foreground">ENG-42</span>,
                boards, workflow states, and cycles — instead of sitting in a
                summary. Projects update their status from the conversations
                about them. A native CRM keeps contacts and interaction history
                current straight from your calls. Every meeting, document, and
                email feeds a persistent knowledge graph you can search, each
                fact carrying the source it came from.
              </p>
              <p className="mt-4">
                And the work gets done. Dial8 hands actions to AI agents that
                execute — writing code, opening pull requests, drafting
                documents — with the full context of the meeting that created the
                task. The whole workspace is exposed over MCP, so you can point
                your own agents at it or connect external MCP servers. Capture,
                context, and execution live in one loop.
              </p>

              <div className="mt-10 flex flex-col sm:flex-row items-start gap-3">
                <a
                  href="/api/download"
                  className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-transparent bg-primary shadow-md whitespace-nowrap font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
                  </svg>
                  Download for macOS
                </a>
                <Link
                  href="/docs"
                  className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
                >
                  Read the docs
                </Link>
                <Link
                  href="/pricing"
                  className="inline-flex items-center justify-center gap-2 py-3 px-6 text-base rounded-full border border-border whitespace-nowrap font-medium text-foreground hover:bg-accent transition-colors"
                >
                  See pricing
                </Link>
              </div>
            </section>

            {/* How it compares */}
            <section className="relative py-16">
              <SectionDivider />
              <h2 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
                How it compares to AI notetakers
              </h2>
              <p className="mt-6">
                Most tools in this space are excellent notetakers that stop at
                the summary. They are worth understanding on their own terms — so
                we wrote honest, side-by-side comparisons of where each one is
                strong and where a full work environment goes further:
              </p>
              <ul className="mt-6 grid gap-2 sm:grid-cols-2">
                <li>
                  <Link
                    href="/vs/granola"
                    className="block rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    Dial8 vs Granola
                  </Link>
                </li>
                <li>
                  <Link
                    href="/vs/fathom"
                    className="block rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    Dial8 vs Fathom
                  </Link>
                </li>
                <li>
                  <Link
                    href="/vs/otter"
                    className="block rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    Dial8 vs Otter.ai
                  </Link>
                </li>
                <li>
                  <Link
                    href="/vs/fireflies"
                    className="block rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    Dial8 vs Fireflies.ai
                  </Link>
                </li>
              </ul>
            </section>
          </div>
        </article>
      </main>
      <Footer />
    </PageLayout>
  )
}
