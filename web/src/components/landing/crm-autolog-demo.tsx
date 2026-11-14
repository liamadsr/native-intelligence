'use client'

/**
 * Landing demo of the CRM filling itself in after a customer call: the contact's
 * record as it opens in the chat (a card's window, DemoCard), drawn the way
 * the contact's own panel draws it (app/account/(dashboard)/views/
 * contact-detail-panel.tsx): the tab row, the avatar and name, Notes, Recent
 * Activity, Knowledge and Stats on the left, the Properties rail on the right.
 *
 * The record already has a history (an intro call, a pricing email, what the
 * team learned), so it never reads as empty. After today's call, step by
 * step, its notes are added, the call and its follow-ups land at the top of
 * Recent Activity (each row opens into place), the stats count up and a
 * follow-up date is set; then the loop starts over. Content is FICTIONAL.
 */
import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Building2,
  Calendar,
  ExternalLink,
  ListChecks,
  Mail,
  MapPin,
  Mic,
  Phone,
  User,
  Video,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoCard, DemoSky, DemoTabs } from './demo-card'

/** What the record already said before today's call. */
const PRIOR_NOTES = [
  'VP Operations at Acme Corp; leads the rollout for a 40-person team.',
  'Came in through the Q3 webinar. Their team loses context between tools.',
]

/** What today's call adds. */
const NEW_NOTES = [
  'Comparing us with BridgeCRM; price is the deciding factor.',
  'Legal needs our SOC 2 report before they sign.',
  'Wants a 40-seat pilot live within two weeks.',
]

const PRIOR_ACTIVITY = [
  { icon: Mail, title: 'Email: pricing sheet and case study sent', when: '5d ago' },
  { icon: Video, title: 'Intro call · 24 min', when: '6d ago' },
  { icon: Calendar, title: 'Discovery call booked for Oct 22', when: '6d ago' },
  { icon: Mail, title: 'Email: “Following up from the webinar”', when: '2w ago' },
]

const NEW_ACTIVITY = [
  { icon: Mic, title: 'Discovery call · 32 min', when: 'now' },
  { icon: ListChecks, title: 'Follow-up: send the SOC 2 report', when: 'now' },
  { icon: ArrowRight, title: 'Stage moved: Discovery → Evaluation', when: 'now' },
  { icon: Mail, title: 'Recap email drafted for review', when: 'now' },
]

const KNOWLEDGE = [
  { text: 'Acme’s renewal with their current CRM ends Dec 31.', when: '6d ago' },
  { text: 'Alex promised a security review before the pilot.', when: '6d ago' },
]

// The steps, in order: the new notes, the new activity rows, then the follow-up date.
const STEPS = NEW_NOTES.length + NEW_ACTIVITY.length + 1
const FOLLOW_UP_STEP = STEPS

/** A row that opens into place (its height from 0, then fades in), so what's below glides down. */
function Opens({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('grid transition-[grid-template-rows,opacity] duration-500 ease-out', on ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** A line of the notes, as the editor draws a bullet list. */
function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 pl-1.5">
      <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-foreground/70" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

function ActivityRow({ icon: Icon, title, when, fresh }: { icon: typeof Mail; title: string; when: string; fresh?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
      <div className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', fresh ? 'bg-emerald-500/15' : 'bg-muted')}>
        <Icon className={cn('h-3 w-3', fresh ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} />
      </div>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{when}</span>
    </div>
  )
}

export function CrmAutologDemo() {
  // How many of today's steps have landed (0: the record as it was before the call).
  const [step, setStep] = useState(0)
  useEffect(() => {
    const delay = step === 0 ? 1800 : step >= STEPS ? 5000 : 900
    const t = setTimeout(() => setStep((s) => (s >= STEPS ? 0 : s + 1)), delay)
    return () => clearTimeout(t)
  }, [step])

  const notesShown = Math.min(step, NEW_NOTES.length)
  const activityShown = Math.max(0, Math.min(step - NEW_NOTES.length, NEW_ACTIVITY.length))
  const called = activityShown >= 1
  const followUp = step >= FOLLOW_UP_STEP

  return (
    <DemoSky className="p-3 sm:p-4">
      <div className="[zoom:0.8]">
        <DemoCard title="Dana Whitfield" className="h-[640px]">
          <DemoTabs
            active="Overview"
            tabs={[
              { label: 'Overview' },
              { label: 'Details' },
              { label: 'Actions', count: activityShown >= 2 ? 3 : 2 },
              { label: 'Captures', count: called ? 2 : 1 },
              { label: 'Sequences', count: 1 },
            ]}
          />
          <div className="flex min-h-0 flex-1">
            {/* Left: the Overview tab (fixed height: what runs past the foot is cut, as in the card) */}
            <div className="min-w-0 flex-1 space-y-5 overflow-hidden px-6 pb-6">
              <div className="flex items-center gap-3 pt-5 pb-1">
                <img src="/linked-avatars/manager.jpg" alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
                <span className="truncate text-lg font-semibold">Dana Whitfield</span>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Notes</p>
                <div className="text-sm leading-relaxed">
                  {PRIOR_NOTES.map((n) => (
                    <Bullet key={n}>{n}</Bullet>
                  ))}
                  {NEW_NOTES.map((n, i) => (
                    <Opens key={n} on={i < notesShown}>
                      <Bullet>{n}</Bullet>
                    </Opens>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Recent Activity</p>
                <div>
                  {/* Newest first: today's rows open in above the history. */}
                  {[...NEW_ACTIVITY].reverse().map((a) => {
                    const i = NEW_ACTIVITY.indexOf(a)
                    return (
                      <Opens key={a.title} on={i < activityShown}>
                        <ActivityRow {...a} fresh />
                      </Opens>
                    )
                  })}
                  {PRIOR_ACTIVITY.map((a) => (
                    <ActivityRow key={a.title} {...a} />
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Stats</p>
                <div className="space-y-1 px-2 text-xs text-muted-foreground">
                  {[
                    ['Interactions', 11 + activityShown],
                    ['Last interaction', called ? 'now' : '5d ago'],
                    ['Meetings', called ? 2 : 1],
                    ['Email threads', activityShown >= 4 ? 4 : 3],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between">
                      <span>{label}</span>
                      <span className="font-medium tabular-nums text-foreground">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Knowledge</p>
                <div className="space-y-1.5">
                  {KNOWLEDGE.map((k) => (
                    <div key={k.text} className="rounded-md border px-2.5 py-2 text-xs">
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 leading-snug">{k.text}</span>
                        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{k.when}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Properties */}
            <aside className="hidden w-60 shrink-0 border-l border-border/60 pt-2 sm:block">
              <div className="p-3">
                <div className="px-3 py-2 text-sm font-medium text-muted-foreground">Properties</div>
                <Prop icon={<User className="h-4 w-4 shrink-0 text-muted-foreground" />}>Customer</Prop>
                <Prop icon={<span className="h-4 w-4 shrink-0 rounded-full bg-emerald-500" />}>Strong</Prop>
                <Prop icon={<MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />}>VP Operations</Prop>
                <Prop icon={<Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />}>Operations</Prop>
                <Prop icon={<Mail className="h-4 w-4 shrink-0 text-muted-foreground" />}>dana@acmecorp.com</Prop>
                <Prop icon={<Phone className="h-4 w-4 shrink-0 text-muted-foreground" />}>+1 (415) 555-0142</Prop>
                <Prop icon={<ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />}>linkedin.com/in/danawhitfield</Prop>
                <Prop icon={<Building2 className="h-4 w-4 shrink-0" />}>Acme Corp</Prop>
                <Prop icon={<Calendar className="h-4 w-4 shrink-0" />} muted={!followUp}>
                  <span className="relative inline-grid">
                    <span className={cn('col-start-1 row-start-1 transition-opacity duration-500', followUp ? 'opacity-0' : 'opacity-100')}>
                      Set follow-up date
                    </span>
                    <span className={cn('col-start-1 row-start-1 transition-opacity duration-500', followUp ? 'opacity-100' : 'opacity-0')}>
                      Follow up Fri, Oct 30
                    </span>
                  </span>
                </Prop>
              </div>
            </aside>
          </div>
        </DemoCard>
      </div>
    </DemoSky>
  )
}

function Prop({ icon, children, muted }: { icon: React.ReactNode; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className={cn('flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm', muted && 'text-muted-foreground')}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}
