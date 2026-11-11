'use client'

/**
 * The booking link dialog (Settings → Availability → Booking links): a new
 * link, or one to change. A new link needs only its title: 30 minutes on
 * video, 4 hours' notice, 30 days ahead, the person its host
 * (./booking-link-form.ts newDraft). Hosts are workspace members; with more
 * than one, whether everyone attends or any one of them does.
 */
import { useState } from 'react'
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
import {
  BUFFER_OPTIONS,
  LENGTH_OPTIONS,
  NOTICE_OPTIONS,
  WINDOW_OPTIONS,
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
      <SelectTrigger id={id} className="h-9 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {label(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const problem = draftProblem(draft)
  const toggleHost = (userId: string, on: boolean) =>
    setDraft((d) => ({ ...d, hosts: on ? (d.hosts.includes(userId) ? d.hosts : [...d.hosts, userId].slice(0, LINK_HOSTS_MAX)) : d.hosts.filter((h) => h !== userId) }))
  const editQuestion = (i: number, patch: Partial<LinkDraft['questions'][number]>) => setDraft((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] gap-0 overflow-hidden p-0 sm:max-w-lg" data-booking-link-dialog="">
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
          <div className="max-h-[calc(90dvh-10rem)] space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="link-title">Title</Label>
              <Input id="link-title" autoFocus value={draft.title} maxLength={LINK_TITLE_MAX} placeholder="Intro call" onChange={(e) => setDraft((d) => withTitle(d, e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-slug">Address</Label>
              <div className="flex h-9 items-center rounded-md border border-input text-sm shadow-xs focus-within:border-foreground/30">
                <span className="max-w-[60%] shrink-0 truncate pl-3 text-muted-foreground" data-link-address-base="">
                  {draft.team ? addressBase.team : addressBase.me}
                </span>
                <input
                  id="link-slug"
                  value={draft.slug}
                  placeholder="intro-call"
                  onChange={(e) => set({ slug: typedSlug(e.target.value), slugTyped: true })}
                  className="h-full min-w-0 flex-1 bg-transparent pr-3 outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-description">Description (optional)</Label>
              <Textarea id="link-description" rows={2} value={draft.description} maxLength={LINK_DESCRIPTION_MAX} placeholder="What the meeting is for" onChange={(e) => set({ description: e.target.value })} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="link-length">Length</Label>
                <NumberSelect id="link-length" value={draft.durationMinutes} options={withValue(LENGTH_OPTIONS, draft.durationMinutes)} label={lengthLabel} onChange={(n) => set({ durationMinutes: n })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="link-window">How far ahead</Label>
                <NumberSelect id="link-window" value={draft.windowDays} options={withValue(WINDOW_OPTIONS, draft.windowDays)} label={windowLabel} onChange={(n) => set({ windowDays: n })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="link-notice">Minimum notice</Label>
                <NumberSelect id="link-notice" value={draft.noticeMinutes} options={withValue(NOTICE_OPTIONS, draft.noticeMinutes)} label={noticeLabel} onChange={(n) => set({ noticeMinutes: n })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="link-before">Buffer before</Label>
                  <NumberSelect id="link-before" value={draft.bufferBeforeMinutes} options={withValue(BUFFER_OPTIONS, draft.bufferBeforeMinutes)} label={bufferLabel} onChange={(n) => set({ bufferBeforeMinutes: n })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="link-after">After</Label>
                  <NumberSelect id="link-after" value={draft.bufferAfterMinutes} options={withValue(BUFFER_OPTIONS, draft.bufferAfterMinutes)} label={bufferLabel} onChange={(n) => set({ bufferAfterMinutes: n })} />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="link-video">Video call</Label>
                <Switch id="link-video" checked={draft.video} onCheckedChange={(video) => set({ video })} />
              </div>
              {!draft.video && <Input aria-label="Where" value={draft.location} maxLength={LINK_LOCATION_MAX} placeholder="Where: an address, or a phone call" onChange={(e) => set({ location: e.target.value })} />}
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="link-ask-first">Ask me first</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Each booking waits for your yes; the time is held until you answer.</p>
              </div>
              <Switch id="link-ask-first" checked={draft.askFirst} onCheckedChange={(askFirst) => set({ askFirst })} />
            </div>

            <div className="space-y-2" data-link-questions="">
              <Label>Questions</Label>
              {draft.questions.length === 0 && <p className="text-xs text-muted-foreground">Their name and how to reach them are always asked.</p>}
              {draft.questions.map((q, i) => (
                <div key={q.id ?? `new-${i}`} className="flex items-center gap-2" data-link-question-row="">
                  <Input aria-label={`Question ${i + 1}`} className="h-8 min-w-0 flex-1" value={q.label} maxLength={QUESTION_LABEL_MAX} placeholder="What should we cover?" onChange={(e) => editQuestion(i, { label: e.target.value })} />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox checked={q.required} onCheckedChange={(v) => editQuestion(i, { required: v === true })} aria-label={`Question ${i + 1} required`} />
                    Required
                  </label>
                  <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Remove question ${i + 1}`} onClick={() => set({ questions: draft.questions.filter((_, j) => j !== i) })}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
              {draft.questions.length < LINK_QUESTIONS_MAX && (
                <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 gap-1 text-xs text-muted-foreground" onClick={() => set({ questions: [...draft.questions, { label: '', required: false, kind: 'text' }] })}>
                  <Plus className="size-3.5" />
                  Add a question
                </Button>
              )}
            </div>

            {members.length > 1 && (
              <div className="space-y-2" data-link-hosts="">
                <Label>Hosts</Label>
                <ul className="max-h-44 divide-y overflow-y-auto rounded-md border">
                  {members.map((m) => (
                    <li key={m.userId}>
                      <label className="flex items-center gap-2.5 px-3 py-1.5 text-sm">
                        <Checkbox checked={draft.hosts.includes(m.userId)} onCheckedChange={(v) => toggleHost(m.userId, v === true)} aria-label={`${m.name} hosts`} />
                        <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {draft.hosts.length > 1 && (
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How the hosts share it" data-link-host-mode="">
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
                        className={cn('rounded-md border px-3 py-2 text-left transition-colors', draft.shared === mode ? 'border-foreground bg-muted/60' : 'hover:bg-muted/40')}
                      >
                        <span className="block text-sm font-medium">{title}</span>
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!editing && canTeam && (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor="link-team">Team link</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Under the workspace&apos;s address instead of yours.</p>
                </div>
                <Switch id="link-team" checked={draft.team} onCheckedChange={(team) => set({ team })} />
              </div>
            )}
          </div>
          <DialogFooter className="items-center border-t px-6 py-4">
            {problem && draft.title.trim() && <p className="mr-auto text-xs text-destructive">{problem}</p>}
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !!problem}>
              {editing ? 'Save' : 'Create link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
