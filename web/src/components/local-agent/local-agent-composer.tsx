'use client'

/**
 * The person's box in a local agent's panel (contract G): what's typed goes
 * to the local agent as the person (author `person`; the Native Intelligence agent sees it
 * too). Steer lands mid-turn, Queue waits for the turn to end; idle, either
 * starts its next turn, and an interrupted one resumes on your Mac. Enter
 * sends, Shift+Enter is a new line. What's typed stays while a send is out,
 * and clears once it went.
 *
 * Each submit carries a request id the server keys the message on
 * (`person:<requestId>`), so it lands once: a second Enter while one is out
 * sends nothing, and trying the same text again after a failure reuses the
 * id (the first try may have landed and only its answer been lost).
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { LocalAgentPolicy } from '@/lib/tauri-bridge'

/** The local route's limit (TEXT_MAX). */
export const COMPOSER_MAX = 20_000

function newRequestId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

const POLICIES: Array<{ value: LocalAgentPolicy; label: string; hint: string }> = [
  { value: 'steer', label: 'Steer', hint: 'Lands while it works' },
  { value: 'queue', label: 'Queue', hint: 'Waits for this turn to end' },
]

export function LocalAgentComposer({
  onSend,
  working,
  asking,
  autoFocus = false,
}: {
  onSend: (text: string, policy: LocalAgentPolicy, requestId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  /** It works now (Steer and Queue differ); idle, either starts a turn. */
  working: boolean
  /** It asked a question: what's sent answers it. */
  asking: boolean
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const [policy, setPolicy] = useState<LocalAgentPolicy>('steer')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The send that's out (no second one meanwhile), and the id a retry of the same text reuses.
  const inFlightRef = useRef(false)
  const attemptRef = useRef<{ text: string; requestId: string } | null>(null)
  const trimmed = text.trim()
  const canSend = !sending && !!trimmed && trimmed.length <= COMPOSER_MAX

  const submit = async () => {
    if (!canSend || inFlightRef.current) return
    inFlightRef.current = true
    const requestId = attemptRef.current?.text === trimmed ? attemptRef.current.requestId : newRequestId()
    attemptRef.current = { text: trimmed, requestId }
    setSending(true)
    setError(null)
    try {
      const res = await onSend(trimmed, policy, requestId)
      if (res.ok) {
        attemptRef.current = null
        setText('')
      } else setError(res.message)
    } finally {
      inFlightRef.current = false
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const hint = asking
    ? 'Your reply answers its question.'
    : working
      ? POLICIES.find((p) => p.value === policy)!.hint
      : 'Starts its next turn on your Mac.'

  return (
    <form
      data-local-agent-composer=""
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="rounded-[22px] border border-border/60 bg-background px-3 pb-2 pt-2.5 shadow-sm shadow-black/[0.03] dark:border-white/10"
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        autoFocus={autoFocus}
        aria-label="Message the local agent"
        placeholder={asking ? 'Answer its question…' : 'Tell it something…'}
        className="min-h-[44px] resize-none border-0 bg-transparent p-1 text-sm shadow-none focus-visible:ring-0"
      />
      <div className="mt-1 flex min-w-0 items-center gap-2">
        {working && !asking ? (
          <div role="radiogroup" aria-label="How it lands" className="flex shrink-0 items-center rounded-full bg-muted p-0.5">
            {POLICIES.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={policy === p.value}
                data-local-agent-policy={p.value}
                onClick={() => setPolicy(p.value)}
                className={cn(
                  'h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors',
                  policy === p.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
        <span data-local-agent-composer-hint="" className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {error ? <span className="text-destructive">{error}</span> : hint}
        </span>
        <Button
          type="submit"
          size="icon"
          disabled={!canSend}
          aria-label="Send"
          className="h-7 w-7 shrink-0 rounded-full"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </form>
  )
}
