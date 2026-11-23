'use client'

/**
 * The booking link dialog (Settings → Availability → Booking links): a new
 * link, or one to change. A new link needs only its title: 30 minutes on
 * video, 4 hours' notice, 30 days ahead, the person its host
 * (./booking-link-form.ts newDraft). Hosts are workspace members; with more
 * than one, whether everyone attends or any one of them does.
 */
import { useState, type HTMLAttributes, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { LINK_DESCRIPTION_MAX, LINK_HOSTS_MAX, LINK_LOCATION_MAX, LINK_QUESTIONS_MAX, LINK_TITLE_MAX, QUESTION_LABEL_MAX } from '@/lib/booking-links/types'
import { lengthLabel } from '@/lib/time-offers/display'
import { cn } from '@/lib/utils'
import { useTeamCalls } from '@/components/team-calls/team-calls-provider'
import { LinkFormGateEditor } from './link-form-gate-editor'
import { LinkHoursEditor } from './link-hours-editor'
import {
  BUFFER_OPTIONS,
  DAILY_CAP_OPTIONS,
  LENGTH_OPTIONS,
  NOTICE_OPTIONS,
  WINDOW_OPTIONS,
  dailyCapLabel,
  draftProblem,
  noticeLabel,
  typedSlug,
  withTitle,
  withValue,
  type LinkDraft,
} from './booking-link-form'

export interface LinkMember {
  userId: string
  name: string
}

function NumberSelect({ id, value, options, label, onChange }: { id: string; value: number; options: number[]; label: (n: number) => string; onChange: (n: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger id={id} className="h-8 w-36 bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {label(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A titled group of settings, as on the Availability page this dialog opens from. */
function Section({ title, hint, children, ...rest }: { title: string; hint?: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest}>
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  )
}

const CARD = 'divide-y rounded-lg border border-border bg-muted/30'

/** One setting in a card: its name (and what it does) on the left, its control on the right. */
function Row({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2">
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="leading-5 font-normal">
          {label}
        </Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const bufferLabel = (n: number) => (n === 0 ? 'None' : lengthLabel(n))
const windowLabel = (n: number) => `${n} days`

export function BookingLinkDialog({
  open,
  onOpenChange,
  initial,
  editing,
  addressBase,
  members,
  canTeam,
  busy,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: LinkDraft
  /** Changing a saved link (no team choice; its address keeps its handle). */
  editing: boolean
  /** The address before the slug, the person's and the team's: "nativeintelligence.dev/book/ada-finch/". */
  addressBase: { me: string; team: string }
  members: LinkMember[]
  /** An owner or admin may put a new link under the team's address. */
  canTeam: boolean
  busy: boolean
  onSave: (draft: LinkDraft) => void
}) {
  const [draft, setDraft] = useState(initial)
  const set = (patch: Partial<LinkDraft>) => setDraft((d) => ({ ...d, ...patch }))
  // Meeting links are offered only where calling is set up (the dashboard's call provider says so).
  const callsHere = useTeamCalls().available
  const problem = draftProblem(draft)
  const toggleHost = (userId: string, on: boolean) =>
    setDraft((d) => ({ ...d, hosts: on ? (d.hosts.includes(userId) ? d.hosts : [...d.hosts, userId].slice(0, LINK_HOSTS_MAX)) : d.hosts.filter((h) => h !== userId) }))
  const editQuestion = (i: number, patch: Partial<LinkDraft['questions'][number]>) => setDraft((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] grid-cols-1 gap-0 overflow-hidden p-0 sm:max-w-lg" data-booking-link-dialog="">
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>{editing ? 'Edit booking link' : 'New booking link'}</DialogTitle>
          <DialogDescription>Anyone with the link books a time from your real availability.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (!problem) onSave(draft)
          }}
        >
          <div className="max-h-[calc(90dvh-10rem)] space-y-7 overflow-y-auto px-6 py-5">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="link-title">Title</Label>
                <Input id="link-title" autoFocus value={draft.title} maxLength={LINK_TITLE_MAX} placeholder="Intro call" onChange={(e) => setDraft((d) => withTitle(d, e.target.value))} />
                {/* The address follows the title until it is typed; it reads as one line under it. */}
                <div className="flex items-center text-xs text-muted-foreground">
                  <span className="max-w-[65%] shrink-0 truncate" data-link-address-base="">
                    {draft.team ? addressBase.team : addressBase.me}
                  </span>
                  <input
                    id="link-slug"
                    aria-label="Address"
                    value={draft.slug}
                    placeholder="intro-call"
                    onChange={(e) => set({ slug: typedSlug(e.target.value), slugTyped: true })}
                    className="-my-0.5 min-w-0 flex-1 rounded-sm bg-transparent py-0.5 text-foreground outline-none placeholder:text-muted-foreground hover:bg-muted focus:bg-muted"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="link-description">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Textarea id="link-description" rows={2} value={draft.description} maxLength={LINK_DESCRIPTION_MAX} placeholder="What the meeting is for" onChange={(e) => set({ description: e.target.value })} />
              </div>
            </div>

            <Section title="Meeting">
              <div className={CARD}>
                <Row label="Length" htmlFor="link-length">
                  <NumberSelect id="link-length" value={draft.durationMinutes} options={withValue(LENGTH_OPTIONS, draft.durationMinutes)} label={lengthLabel} onChange={(n) => set({ durationMinutes: n })} />
                </Row>
                <Row label="Video call" htmlFor="link-video">
                  <Switch id="link-video" checked={draft.video} onCheckedChange={(video) => set({ video })} />
                </Row>
                {draft.video && callsHere && (
                  <Row label="Use a meeting link here" htmlFor="link-call-here" hint="Instead of the calendar&rsquo;s video link. Guests wait in the lobby until you let them in.">
                    <Switch id="link-call-here" checked={draft.callHere} onCheckedChange={(callHere) => set({ callHere })} data-link-call-here="" />
                  </Row>
                )}
                {!draft.video && (
                  <div className="px-4 py-2.5">
                    <Input aria-label="Where" className="h-8 bg-background" value={draft.location} maxLength={LINK_LOCATION_MAX} placeholder="Where: an address, or a phone call" onChange={(e) => set({ location: e.target.value })} />
                  </div>
                )}
              </div>
            </Section>

            <Section title="When it can be booked">
              <div className={CARD}>
                <Row label="Minimum notice" htmlFor="link-notice">
                  <NumberSelect id="link-notice" value={draft.noticeMinutes} options={withValue(NOTICE_OPTIONS, draft.noticeMinutes)} label={noticeLabel} onChange={(n) => set({ noticeMinutes: n })} />
                </Row>
                <Row label="How far ahead" htmlFor="link-window">
                  <NumberSelect id="link-window" value={draft.windowDays} options={withValue(WINDOW_OPTIONS, draft.windowDays)} label={windowLabel} onChange={(n) => set({ windowDays: n })} />
                </Row>
                <Row label="Daily limit" htmlFor="link-daily-cap" hint="At most this many of its bookings in a day.">
                  <NumberSelect id="link-daily-cap" value={draft.dailyCap} options={withValue(DAILY_CAP_OPTIONS, draft.dailyCap)} label={dailyCapLabel} onChange={(n) => set({ dailyCap: n })} />
                </Row>
                <Row label="Buffer before" htmlFor="link-before">
                  <NumberSelect id="link-before" value={draft.bufferBeforeMinutes} options={withValue(BUFFER_OPTIONS, draft.bufferBeforeMinutes)} label={bufferLabel} onChange={(n) => set({ bufferBeforeMinutes: n })} />
                </Row>
                <Row label="Buffer after" htmlFor="link-after">
                  <NumberSelect id="link-after" value={draft.bufferAfterMinutes} options={withValue(BUFFER_OPTIONS, draft.bufferAfterMinutes)} label={bufferLabel} onChange={(n) => set({ bufferAfterMinutes: n })} />
                </Row>
                <Row label="Ask me first" htmlFor="link-ask-first" hint="Each booking waits for your yes; the time is held until you answer.">
                  <Switch id="link-ask-first" checked={draft.askFirst} onCheckedChange={(askFirst) => set({ askFirst })} />
                </Row>
              </div>
            </Section>

            <Section title="Hours" data-link-hours="">
              <div className={CARD}>
                <Row label="Its own hours" htmlFor="link-own-hours" hint={draft.ownHours ? 'Only these hours, around everything busy.' : 'Off: each host’s working hours.'}>
                  <Switch id="link-own-hours" checked={draft.ownHours} onCheckedChange={(ownHours) => set({ ownHours })} />
                </Row>
              </div>
              {draft.ownHours && (
                <div className="mt-3">
                  <LinkHoursEditor weekly={draft.weekly} timeZone={draft.timeZone} dateOverrides={draft.dateOverrides} onChange={(patch) => set(patch)} />
                </div>
              )}
            </Section>

            <Section title="Before they book" hint="A form they answer first: only those who qualify see your times." data-link-form-section="">
              <LinkFormGateEditor formId={draft.formId} conditions={draft.formConditions} refusal={draft.formRefusal} onChange={(patch) => set(patch)} />
            </Section>

            <Section title="Questions" hint="Their name and how to reach them are always asked." data-link-questions="">
              {draft.questions.length > 0 && (
                <div className={cn(CARD, 'mb-2')}>
                  {draft.questions.map((q, i) => (
                    <div key={q.id ?? `new-${i}`} className="flex items-center gap-2 py-2 pr-2 pl-4" data-link-question-row="">
                      <Input aria-label={`Question ${i + 1}`} className="h-8 min-w-0 flex-1 bg-background" value={q.label} maxLength={QUESTION_LABEL_MAX} placeholder="What should we cover?" onChange={(e) => editQuestion(i, { label: e.target.value })} />
                      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox checked={q.required} onCheckedChange={(v) => editQuestion(i, { required: v === true })} aria-label={`Question ${i + 1} required`} />
                        Required
                      </label>
                      <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground shadow-none hover:text-foreground" aria-label={`Remove question ${i + 1}`} onClick={() => set({ questions: draft.questions.filter((_, j) => j !== i) })}>
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {draft.questions.length < LINK_QUESTIONS_MAX && (
                <Button type="button" variant="outline" size="sm" className="-ml-3 gap-1" onClick={() => set({ questions: [...draft.questions, { label: '', required: false, kind: 'text' }] })}>
                  <Plus className="size-3.5" />
                  Add a question
                </Button>
              )}
            </Section>

            {members.length > 1 && (
              <Section title="Hosts" data-link-hosts="">
                <ul className={cn(CARD, 'max-h-44 overflow-y-auto')}>
                  {members.map((m) => (
                    <li key={m.userId}>
                      <label className="flex items-center gap-2.5 px-4 py-2 text-sm">
                        <Checkbox checked={draft.hosts.includes(m.userId)} onCheckedChange={(v) => toggleHost(m.userId, v === true)} aria-label={`${m.name} hosts`} />
                        <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {draft.hosts.length > 1 && (
                  <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="How the hosts share it" data-link-host-mode="">
                    {(
                      [
                        ['all', 'Everyone attends', 'Only times when all are free'],
                        ['any', 'Any one of them', 'Whoever is free, the least booked'],
                      ] as const
                    ).map(([mode, title, hint]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={draft.shared === mode}
                        onClick={() => set({ shared: mode })}
                        className={cn('rounded-lg border border-border px-4 py-2 text-left transition-colors', draft.shared === mode ? 'border-foreground/60 bg-muted/60' : 'bg-muted/30 hover:bg-muted/50')}
                      >
                        <span className="block text-sm">{title}</span>
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {!editing && canTeam && (
              <Section title="Team">
                <div className={CARD}>
                  <Row label="Team link" htmlFor="link-team" hint="Under the workspace&rsquo;s address instead of yours.">
                    <Switch id="link-team" checked={draft.team} onCheckedChange={(team) => set({ team })} />
                  </Row>
                </div>
              </Section>
            )}
          </div>
          <DialogFooter className="items-center border-t px-6 py-4">
            {problem && draft.title.trim() && <p className="mr-auto text-xs text-destructive">{problem}</p>}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !!problem}>
              {editing ? 'Save' : 'Create link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
