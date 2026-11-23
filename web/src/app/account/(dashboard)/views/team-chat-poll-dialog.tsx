'use client'

/**
 * New poll (docs/plans/channels-inbox.md, phase 3), from the team chat
 * composer's + menu: a question, two to ten options, one choice or several,
 * anonymous or not, and when it closes. Posted into the conversation it was
 * opened in (a thread's, when from a thread's box) by
 * POST /api/account/team-chat/channels/[id]/polls, which checks everything
 * again (src/lib/team-chat/polls.ts planPoll) before 703's function does.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  POLL_CLOSE_CHOICES,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  planPoll,
  pollClosesAt,
  type PollCloseChoice,
} from '@/lib/team-chat/polls'
import type { TeamChatMessage } from '@/lib/team-chat/types'

const CLOSE_LABELS: Record<PollCloseChoice, string> = {
  none: 'When I close it',
  hour: 'In an hour',
  day: 'In a day',
  week: 'In a week',
}

export function TeamChatPollDialog({
  open,
  onOpenChange,
  channelId,
  threadRootId,
  onPosted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelId: string
  threadRootId: string | null
  /** The poll's message, as posted (the pane shows it at once). */
  onPosted?: (message: TeamChatMessage) => void
}) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [multiple, setMultiple] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [closes, setCloses] = useState<PollCloseChoice>('none')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const clientId = useRef<string>('')
  useEffect(() => {
    if (!open) return
    setQuestion('')
    setOptions(['', ''])
    setMultiple(false)
    setAnonymous(false)
    setCloses('none')
    setError(null)
    clientId.current = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : ''
  }, [open])

  const setOption = (i: number, value: string) => setOptions((prev) => prev.map((o, j) => (j === i ? value.slice(0, POLL_OPTION_MAX) : o)))
  const removeOption = (i: number) => setOptions((prev) => (prev.length <= POLL_MIN_OPTIONS ? prev : prev.filter((_, j) => j !== i)))
  const addOption = () => setOptions((prev) => (prev.length >= POLL_MAX_OPTIONS ? prev : [...prev, '']))

  const submit = async () => {
    if (saving) return
    const input = { question, options, multiple, anonymous, closes_at: pollClosesAt(closes) }
    const plan = planPoll(input)
    if (!plan.ok) return setError(plan.error)
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/account/team-chat/channels/${channelId}/polls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...plan.draft, thread_root_id: threadRootId, client_id: clientId.current || undefined }),
    }).catch(() => null)
    setSaving(false)
    if (!res?.ok) {
      const json = (await res?.json().catch(() => null)) as { error?: string } | null
      setError(json?.error ?? 'The poll could not be posted. Try again.')
      return
    }
    const json = (await res.json().catch(() => null)) as { message?: TeamChatMessage } | null
    if (json?.message) onPosted?.(json.message)
    toast.success('Poll posted')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-team-chat-poll-dialog="">
        <DialogHeader>
          <DialogTitle>New poll</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, POLL_QUESTION_MAX))}
            placeholder="Ask a question"
            aria-label="Question"
            data-poll-question=""
            autoFocus
          />
          <div className="flex flex-col gap-1.5">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input value={o} onChange={(e) => setOption(i, e.target.value)} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} data-poll-option={i} />
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  disabled={options.length <= POLL_MIN_OPTIONS}
                  aria-label={`Remove option ${i + 1}`}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:invisible"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            {options.length < POLL_MAX_OPTIONS && (
              <button type="button" onClick={addOption} data-poll-add-option="" className="flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
                <Plus className="h-4 w-4" /> Add an option
              </button>
            )}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Let people pick more than one</span>
            <Switch checked={multiple} onCheckedChange={setMultiple} data-poll-multiple="" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col">
              <span>Anonymous</span>
              <span className="text-xs text-muted-foreground">Only the counts show, to everyone, you too</span>
            </span>
            <Switch checked={anonymous} onCheckedChange={setAnonymous} data-poll-anonymous="" />
          </label>
          <div className="flex flex-col gap-1.5 text-sm">
            <span>Closes</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Closes">
              {POLL_CLOSE_CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={closes === c}
                  data-poll-closes={c}
                  onClick={() => setCloses(c)}
                  className={cn('rounded-full px-3 py-1 text-xs', closes === c ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground')}
                >
                  {CLOSE_LABELS[c]}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert" data-poll-error="">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving} data-poll-submit="">
              {saving ? 'Posting…' : 'Post poll'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
