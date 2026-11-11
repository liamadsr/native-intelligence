'use client'

/**
 * "New meeting link" (calls plan, phase 7), from team chat: a title, and
 * optionally a time and a length. Made, it shows the link with Copy and
 * Open; the meeting's conversation shows in team chat once it is used.
 * Without a time, the link works from now for 30 days; with one, from 15
 * minutes before until 2 hours after its planned end.
 */

import { useEffect, useState } from 'react'
import { Check, Copy, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { copyTextToClipboard } from '@/lib/clipboard'
import { requestNewMeeting, type CreatedMeeting } from '@/lib/meeting-links/client'
import { MEETING_DEFAULT_MINUTES, MEETING_TITLE_MAX } from '@/lib/meeting-links/shape'

const LENGTHS = [15, 30, 45, 60, 90, 120]

/** A local date and time input's value ("2026-11-12T14:30") as an ISO instant, or null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

export function NewMeetingDialog({ open, onOpenChange, onOpenMeeting }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenMeeting?: (meeting: CreatedMeeting) => void }) {
  const [title, setTitle] = useState('')
  const [scheduled, setScheduled] = useState(false)
  const [when, setWhen] = useState('')
  const [minutes, setMinutes] = useState(MEETING_DEFAULT_MINUTES)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [made, setMade] = useState<CreatedMeeting | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setScheduled(false)
    setWhen('')
    setMinutes(MEETING_DEFAULT_MINUTES)
    setError(null)
    setMade(null)
    setCopied(false)
  }, [open])

  const create = async () => {
    if (!title.trim() || saving) return
    const startsAt = scheduled ? localInputToIso(when) : null
    if (scheduled && !startsAt) return setError('Pick a date and time, or turn off the schedule.')
    setSaving(true)
    setError(null)
    const res = await requestNewMeeting({ title, startsAt, minutes: scheduled ? minutes : null })
    setSaving(false)
    if (!res.ok) return setError(res.line)
    setMade(res.meeting)
  }

  const copy = async () => {
    if (!made) return
    setCopied(await copyTextToClipboard(made.url))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md [&>*]:min-w-0" data-new-meeting-dialog={made ? 'made' : 'form'}>
        <DialogHeader>
          <DialogTitle>{made ? 'Your meeting link' : 'New meeting link'}</DialogTitle>
          <DialogDescription>
            {made
              ? 'Anyone with the link can ask to join. People in your workspace come straight in; others wait until someone in the call lets them in.'
              : 'A call anyone can be invited to. Guests without an account wait in a lobby until someone in the call admits them.'}
          </DialogDescription>
        </DialogHeader>
        {made ? (
          <div className="min-w-0 space-y-3">
            <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" data-new-meeting-url="">
                {made.url}
              </span>
              <Button size="sm" variant="outline" onClick={() => void copy()} data-new-meeting-copy="">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {scheduled ? 'It works from 15 minutes before the start until 2 hours after the planned end.' : 'It works for the next 30 days.'} You can turn it off from the meeting’s conversation.
            </p>
          </div>
        ) : (
          <div className="min-w-0 space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Title</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Design review" maxLength={MEETING_TITLE_MAX} autoFocus onKeyDown={(e) => e.key === 'Enter' && void create()} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} className="h-4 w-4 rounded border-input" data-new-meeting-schedule="" />
              Schedule it for a time
            </label>
            {scheduled && (
              <div className="flex gap-2">
                <label className="block min-w-0 flex-1 space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Starts</span>
                  <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                </label>
                <label className="block w-28 space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Length</span>
                  <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    {LENGTHS.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ` ${m % 60} min` : ''}`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {made ? (
            <>
              {onOpenMeeting && (
                <Button variant="outline" size="sm" onClick={() => onOpenMeeting(made)}>
                  Start the meeting
                </Button>
              )}
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void create()} disabled={!title.trim() || saving} data-new-meeting-create="">
                {saving ? 'Making…' : 'Make the link'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
