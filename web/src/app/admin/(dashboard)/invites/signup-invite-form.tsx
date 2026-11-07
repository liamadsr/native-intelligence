'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'

export function SignupInviteForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [skipPayment, setSkipPayment] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string; url?: string } | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/signup-invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), note: note.trim() || undefined, skip_payment: skipPayment }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResult({ kind: 'error', text: data.error ?? 'Failed to send invite' })
        return
      }
      const who = data.invite.email
      if (data.email_sent) {
        setResult({
          kind: 'ok',
          text: data.refreshed ? `Invite refreshed and re-sent to ${who}.` : `Invite sent to ${who}.`,
          url: data.url,
        })
      } else {
        setResult({
          kind: 'error',
          text: `Invite saved for ${who}, but the email failed to send${data.email_error ? ` (${data.email_error})` : ''}. Copy the link instead.`,
          url: data.url,
        })
      }
      setEmail('')
      setNote('')
      setSkipPayment(true)
      router.refresh()
    } catch {
      setResult({ kind: 'error', text: 'Network error' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <div className="space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="person@gmail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-note">Note (optional, included in the email)</Label>
          <Textarea
            id="invite-note"
            placeholder="Great chatting yesterday — here's your invite."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
        <Switch id="invite-skip-payment" checked={skipPayment} onCheckedChange={setSkipPayment} />
        <div className="space-y-0.5">
          <Label htmlFor="invite-skip-payment">Skip the paywall</Label>
          <p className="text-xs text-muted-foreground">
            {skipPayment
              ? 'They get complimentary access — no card, no trial. Good for design partners and testers.'
              : 'They still add a card and start the 7-day trial. The invite only lets a personal email address sign up.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={loading || !email.trim()}>
          {loading ? 'Sending...' : 'Send invite'}
        </Button>
        {result && (
          <span className={`text-sm ${result.kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
            {result.text}
          </span>
        )}
        {result?.url && <CopyLink url={result.url} />}
      </div>
    </form>
  )
}

export function CopyLink({ url, label = 'Copy link' }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          window.prompt('Copy this invite link', url)
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}
