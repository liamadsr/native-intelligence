'use client'

/**
 * Linking a phone to text the Native Intelligence agent (docs/plans/text-and-calling.md,
 * Phase 1). Add a number → we text a 6-digit code → type it back → linked.
 *
 * Two steps, as a modern sign-in's (Liam, 2026-10-24, with his reference:
 * a serif heading, one line under it, few words), in one column centred in
 * its space; the SMS consent stays word for word with its unchecked box
 * (the 10DLC campaign names both: docs/plans/text-and-calling-10dlc.md), as
 * the fine print over the button:
 *   the number   one field: the flag and +1 (Native Intelligence texts US and Canadian
 *                numbers only), then the number formatted as it's typed or
 *                pasted, (555) 123-4567 (lib/sms/phone-format.ts); the
 *                consent; Send code →
 *   the code     six boxes across (components/ui/code-input.tsx) that take a
 *                paste or the phone's own autofill, and check the code the
 *                moment the sixth digit is in; a new code after 30 s, or
 *                change number
 * Texts from that number then land in the person's home thread, and the
 * agent's replies are texted back. Remove unlinks it. STOP from the phone
 * opts out; START opts back in.
 *
 * Its own number (Liam, 2026-11-02; src/lib/sms/agent-number.ts): where this
 * Native Intelligence has a pool to give from, a person without one first gets the agent a
 * number on a button ("Get a number"), then links their phone to it; a
 * phone already linked to the Native Intelligence number can get one too. Never on sign-up.
 *
 * Linking is the agreement to every text the agent sends, the ones while the
 * person is away included: there is no second switch (Liam, 2026-10-31: "I
 * don't want this to be a setting, it should just happen"). STOP turns them off.
 *
 * Shown twice: Settings › Phone (phone-settings-view.tsx, the page the 10DLC
 * campaign names) and the agent panel's Communication tab (`compact`).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CodeInput } from '@/components/ui/code-input'
import { QrCode } from '@/components/ui/qr-code'
import { ReachCard, ReachHeading, ReachLead } from './reach-card'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { SMS_CONSENT_TEXT, SMS_CONSENT_VERSION } from '@/lib/sms/consent'
import { caretAfterDigits, digitsAfterEdit, formatE164ForDisplay, formatNanp, isCompleteNanp, isImpossibleNanp, nanpE164, smsHref, smsQrPayload } from '@/lib/sms/phone-format'

/** How long Resend waits after a code is sent (the server allows 3 codes in 10 minutes). */
export const RESEND_AFTER_S = 30
/** Getting a number while none is ready: ask again this often, this many times (about a minute). */
export const NUMBER_RETRY_MS = 3000
export const NUMBER_TRIES = 20
const CODE_LENGTH = 6

interface LinkedPhone {
  number: string
  masked: string
  verifiedAt: string
  optedOut: boolean
  alertsOn?: boolean
}

interface PhoneState {
  phone: LinkedPhone | null
  /** The number they text: their agent's own, else the Native Intelligence one. */
  dial8Number: string | null
  /** Their agent's own number, when it has one. */
  agentNumber?: string | null
  /** It has none, and this deployment can give one. */
  canGetNumber?: boolean
  available: boolean
}

/** SMS_CONSENT_TEXT verbatim, with its two links clickable. */
function ConsentText() {
  const parts = SMS_CONSENT_TEXT.split(/(https:\/\/dial8\.ai\/(?:terms|privacy))/)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('https://') ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error || fallback
}

export function PhoneSection({ compact = false, name: nameProp }: { compact?: boolean; name?: string }) {
  // The agent's name (Settings → Preferences, or the agent panel's): "Text Joseph", "Hey Joseph!".
  const savedName = useAssistantName().name
  const name = nameProp ?? savedName
  const [state, setState] = useState<PhoneState | null>(null)
  // The number being added: its ten national digits (the field shows them formatted).
  const [digits, setDigits] = useState('')
  // The SMS consent (US 10DLC): required, never pre-ticked.
  const [consent, setConsent] = useState(false)
  // The code step: the number it went to (E.164), once a code is sent.
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/api/account/phone')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PhoneState | null) => setState(d ?? { phone: null, dial8Number: null, available: false }))
      .catch(() => setState({ phone: null, dial8Number: null, available: false }))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Getting a number asks again while one is bought: stop asking once the tab is gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Text a code to `phone` (E.164). True when it went. */
  async function requestCode(phone: string): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/account/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, consent: true, consentVersion: SMS_CONSENT_VERSION }),
      })
      if (!res.ok) {
        setError(await errorOf(res, 'Could not send a code'))
        return false
      }
      return true
    } catch {
      setError('Could not send a code')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function sendCode(e?: FormEvent) {
    e?.preventDefault()
    if (!isCompleteNanp(digits) || !consent || busy) return
    const phone = nanpE164(digits)
    if (await requestCode(phone)) setSentTo(phone)
  }

  /** Get the agent its own number, then show it; while none is ready (202), ask again for about a minute. */
  async function getNumber() {
    setBusy(true)
    setError(null)
    try {
      for (let i = 0; i < NUMBER_TRIES; i++) {
        const res = await fetch('/api/account/agent-number', { method: 'POST' })
        if (!mounted.current) return
        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, NUMBER_RETRY_MS))
          continue
        }
        if (!res.ok) return setError(await errorOf(res, 'Could not get a number'))
        return load()
      }
      setError('Still getting a number ready. Try again in a minute.')
    } catch {
      setError('Could not get a number')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/account/phone', { method: 'DELETE' })
      if (!res.ok) return setError(await errorOf(res, 'Could not remove the number'))
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    // One card, every step laid out the same way: centred heading and line, full-width controls, centred links under them.
    <ReachCard className={compact ? '' : 'mt-10'} data-phone-section="">
      {state === null ? (
        <Loader2 aria-label="Loading" className="mx-auto my-16 size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : state.phone ? (
        <section className="flex flex-col items-center text-center" data-phone-step="linked">
          {state.phone.optedOut || !state.dial8Number ? (
            <>
              <Heading>{state.phone.optedOut ? 'Texts are off' : `Text ${name}`}</Heading>
              <Lead>{state.phone.optedOut ? 'You replied STOP. Text START to turn them back on.' : 'Your phone is linked.'}</Lead>
            </>
          ) : (
            <StartTexting name={name} agentNumber={state.dial8Number} />
          )}
          {state.canGetNumber && !state.phone.optedOut && (
            <button
              type="button"
              onClick={getNumber}
              disabled={busy}
              data-get-number=""
              className="mt-4 text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50"
            >
              {busy ? 'Getting a number…' : `Give ${name} its own number`}
            </button>
          )}
          <p className="mt-6 w-full border-t pt-4 text-xs text-muted-foreground">
            Your phone <span className="tabular-nums text-foreground">{formatE164ForDisplay(state.phone.number)}</span>
            <span aria-hidden className="mx-2">·</span>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              aria-label="Remove phone"
              className="underline underline-offset-4 transition-colors hover:text-destructive disabled:opacity-50"
            >
              Remove
            </button>
          </p>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </section>
      ) : !state.available ? (
        <section>
          <Heading>Text {name}</Heading>
          <Lead>Texting isn&apos;t set up here yet.</Lead>
        </section>
      ) : sentTo ? (
        <CodeStep
          sentTo={sentTo}
          sendError={error}
          resend={() => requestCode(sentTo)}
          onChangeNumber={() => {
            setSentTo(null)
            setError(null)
          }}
          onVerified={() => {
            setSentTo(null)
            setDigits('')
            setError(null)
            load()
          }}
        />
      ) : state.canGetNumber && !state.agentNumber ? (
        <GetNumberStep name={name} busy={busy} error={error} onGet={getNumber} />
      ) : (
        <NumberStep
          name={name}
          agentNumber={state.agentNumber ?? null}
          digits={digits}
          onDigits={(next) => {
            setDigits(next)
            setError(null)
          }}
          consent={consent}
          onConsent={setConsent}
          busy={busy}
          error={error}
          onSubmit={sendCode}
        />
      )}
    </ReachCard>
  )
}

const Heading = ReachHeading
const Lead = ReachLead

/**
 * Linked: start the conversation (Liam, 2026-10-24, with his reference), all
 * centred. A QR code a phone's camera opens in Messages, to the agent's
 * number, "Hey {name}!" typed in; the number to copy; on a phone itself, a
 * button that does the same. No alerts switch: the sign-up consent covers the
 * agent's "needs your OK" texts (lib/sms/consent.ts).
 */
function StartTexting({ name, agentNumber }: { name: string; agentNumber: string }) {
  const [copied, setCopied] = useState(false)
  const hello = `Hey ${name}!`
  const shown = formatE164ForDisplay(agentNumber)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* no clipboard: the number is on screen to type */
    }
  }
  return (
    <div className="flex w-full flex-col items-center" data-start-texting="">
      <div className="rounded-xl border bg-white p-3">
        <QrCode value={smsQrPayload(agentNumber, hello)} size={124} label={`QR code: text ${name} at ${shown}`} />
      </div>
      <Heading className="mt-5">Start texting {name}</Heading>
      <Lead>Scan with your phone&apos;s camera, or text it.</Lead>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy ${shown}`}
        data-agent-number={agentNumber}
        className="mt-5 flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border text-[15px] font-medium tabular-nums transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown}
        {copied ? <Check aria-hidden className="size-4 text-emerald-500" /> : <Copy aria-hidden className="size-4 text-muted-foreground" />}
      </button>
      {/* On a phone there's nothing to scan: open Messages straight away. */}
      <a
        href={smsHref(agentNumber, hello)}
        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground text-[15px] font-medium text-background hover:bg-foreground/90 md:hidden"
        data-text-agent=""
      >
        Text {name}
        <ArrowRight aria-hidden className="size-4" />
      </a>
    </div>
  )
}

/** The US flag (Native Intelligence texts +1 numbers: the US and Canada). Drawn, not an emoji: Windows has no flag emoji. */
function UsFlag() {
  return (
    <svg aria-hidden viewBox="0 0 19 10" className="h-3.5 w-[26px] shrink-0 rounded-[2px] ring-1 ring-black/10">
      <rect width="19" height="10" fill="#B22234" />
      {[1, 3, 5, 7, 9].map((y) => (
        <rect key={y} y={(y * 10) / 13} width="19" height={10 / 13} fill="#fff" />
      ))}
      <rect width="7.6" height={(7 * 10) / 13} fill="#3C3B6E" />
    </svg>
  )
}

/** Before step one, where this deployment can give one: get the agent its own number. */
function GetNumberStep({ name, busy, error, onGet }: { name: string; busy: boolean; error: string | null; onGet: () => void }) {
  return (
    <section data-phone-step="get-number">
      <Heading>Text {name}</Heading>
      <Lead>Give {name} a phone number of its own, then text it from yours.</Lead>
      <Button
        type="button"
        onClick={onGet}
        className="mt-6 h-11 w-full gap-2 rounded-xl bg-foreground text-[15px] font-medium text-background hover:bg-foreground/90"
        disabled={busy}
        data-get-number=""
      >
        {busy ? (
          <Loader2 aria-label="Getting a number" className="size-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <>
            Get a number
            <ArrowRight aria-hidden className="size-4" />
          </>
        )}
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

/** Step one: the flag and +1, the number formatted as it's typed; the consent; Send code. */
function NumberStep({
  name,
  agentNumber,
  digits,
  onDigits,
  consent,
  onConsent,
  busy,
  error,
  onSubmit,
}: {
  name: string
  /** The agent's own number, named in the lead when it has one. */
  agentNumber: string | null
  digits: string
  onDigits: (digits: string) => void
  consent: boolean
  onConsent: (consent: boolean) => void
  busy: boolean
  error: string | null
  onSubmit: (e: FormEvent) => void
}) {
  const field = useRef<HTMLInputElement>(null)
  // Where the caret goes after a reformat, in digits (an edit mid-number keeps its place).
  const caret = useRef<number | null>(null)
  const formatted = formatNanp(digits)
  const complete = isCompleteNanp(digits)
  const impossible = isImpossibleNanp(digits)

  useLayoutEffect(() => {
    const input = field.current
    if (caret.current === null || !input || document.activeElement !== input) return
    const at = caretAfterDigits(formatted, caret.current)
    input.setSelectionRange(at, at)
    caret.current = null
  }, [formatted])

  return (
    <section data-phone-step="number">
      <Heading>Text {name}</Heading>
      {agentNumber ? (
        <Lead>
          {name}&apos;s number is <span className="whitespace-nowrap tabular-nums text-foreground" data-own-number="">{formatE164ForDisplay(agentNumber)}</span>. Link your phone to text it.
        </Lead>
      ) : (
        <Lead>We&apos;ll send you a code to link your phone.</Lead>
      )}
      <form onSubmit={onSubmit} className="mt-6 text-left" noValidate>
        <div
          className={cn(
            'flex h-12 cursor-text items-center rounded-xl border bg-background px-4 transition-[border-color,box-shadow] focus-within:border-foreground/40 focus-within:ring-4 focus-within:ring-foreground/5',
            impossible || error ? 'border-destructive focus-within:border-destructive' : 'border-input',
          )}
          onClick={() => field.current?.focus()}
        >
          <UsFlag />
          <span aria-hidden className="mx-3.5 h-7 w-px shrink-0 bg-border" />
          <span aria-hidden className={cn('mr-1.5 text-lg tabular-nums', digits ? 'text-foreground' : 'text-muted-foreground/50')}>
            +1
          </span>
          <input
            ref={field}
            value={formatted}
            onChange={(e) => {
              const next = digitsAfterEdit(digits, e.target.value, e.target.selectionStart)
              caret.current = next.caretDigits
              onDigits(next.digits)
            }}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(555) 000-0000"
            aria-label="Mobile number"
            aria-invalid={impossible || undefined}
            disabled={busy}
            data-phone-number=""
            className="h-full min-w-0 flex-1 bg-transparent text-lg tabular-nums outline-none placeholder:text-muted-foreground/50 disabled:opacity-60"
          />
          {complete && <Check aria-hidden className="ml-2 size-4 shrink-0 text-emerald-500" data-phone-complete="" />}
        </div>
        {(impossible || error) && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {impossible ? 'Not a valid US or Canadian number.' : error}
          </p>
        )}
        <label className="mt-4 flex items-start gap-2.5 text-xs leading-relaxed text-muted-foreground">
          <Checkbox checked={consent} onCheckedChange={(v) => onConsent(v === true)} disabled={busy} aria-required="true" className="mt-[3px]" />
          <span data-sms-consent>
            <ConsentText />
          </span>
        </label>
        <Button
          type="submit"
          className="mt-5 h-11 w-full gap-2 rounded-xl bg-foreground text-[15px] font-medium text-background hover:bg-foreground/90"
          disabled={busy || !complete || !consent}
          data-phone-send=""
        >
          {busy ? (
            <Loader2 aria-label="Sending" className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <>
              Send code
              <ArrowRight aria-hidden className="size-4" />
            </>
          )}
        </Button>
      </form>
    </section>
  )
}

/** Step two: the code, in six boxes across; checked as soon as it's all in. */
function CodeStep({
  sentTo,
  sendError,
  resend,
  onChangeNumber,
  onVerified,
}: {
  sentTo: string
  sendError: string | null
  resend: () => Promise<boolean>
  onChangeNumber: () => void
  onVerified: () => void
}) {
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<'idle' | 'checking' | 'wrong' | 'linked'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [wait, setWait] = useState(RESEND_AFTER_S)
  const [resending, setResending] = useState(false)

  useEffect(() => {
    if (wait <= 0) return
    const timer = setTimeout(() => setWait((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [wait])

  async function verify(value: string) {
    if (value.length !== CODE_LENGTH || phase === 'checking' || phase === 'linked') return
    setPhase('checking')
    setMessage(null)
    try {
      const res = await fetch('/api/account/phone/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value }),
      })
      if (!res.ok) {
        setMessage(await errorOf(res, 'Could not verify the code'))
        setPhase('wrong')
        setCode('')
        return
      }
      setPhase('linked')
      // A moment on the tick, then the linked phone.
      setTimeout(onVerified, 900)
    } catch {
      setMessage('Could not verify the code')
      setPhase('wrong')
      setCode('')
    }
  }

  async function again() {
    if (wait > 0 || resending) return
    setResending(true)
    setMessage(null)
    const sent = await resend()
    setResending(false)
    if (!sent) return
    setCode('')
    setPhase('idle')
    setMessage('New code sent.')
    setWait(RESEND_AFTER_S)
  }

  const status =
    phase === 'checking' ? (
      <Loader2 aria-label="Checking" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
    ) : phase === 'linked' ? (
      <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
        <Check aria-hidden className="size-4" />
        Phone linked
      </span>
    ) : sendError ? (
      <span className="text-destructive">{sendError}</span>
    ) : message ? (
      <span className={phase === 'wrong' ? 'text-destructive' : 'text-muted-foreground'}>{message}</span>
    ) : null

  const link = 'underline underline-offset-4 decoration-1'
  return (
    <section data-phone-step="code">
      <Heading>Enter your code</Heading>
      <Lead>
        We texted a code to <span className="whitespace-nowrap font-medium text-foreground tabular-nums">{formatE164ForDisplay(sentTo)}</span>
      </Lead>
      <CodeInput
        className="mt-6"
        value={code}
        onChange={(next) => {
          setCode(next)
          if (phase === 'wrong') setPhase('idle')
        }}
        onComplete={verify}
        length={CODE_LENGTH}
        disabled={phase === 'checking' || phase === 'linked'}
        invalid={phase === 'wrong' && code === ''}
        autoFocus
      />
      <p role="status" aria-live="polite" className="mt-4 flex min-h-5 items-center justify-center text-sm" data-phone-code-status="">
        {status}
      </p>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        No code yet? Check filtered or blocked messages.
        <br />
        <button
          type="button"
          onClick={again}
          disabled={wait > 0 || resending || phase === 'linked'}
          data-phone-resend=""
          className={cn(link, 'text-foreground disabled:cursor-default disabled:text-muted-foreground/60')}
        >
          {resending ? 'Sending…' : wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
        </button>{' '}
        or{' '}
        <button
          type="button"
          onClick={onChangeNumber}
          disabled={phase === 'linked'}
          data-phone-change=""
          className={cn(link, 'font-medium text-foreground disabled:cursor-default')}
        >
          change number
        </button>
        .
      </p>
    </section>
  )
}
