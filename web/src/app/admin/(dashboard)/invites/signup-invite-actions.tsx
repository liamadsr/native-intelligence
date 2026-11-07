'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { CopyLink } from './signup-invite-form'
import type { SignupInviteStatus } from '@/lib/admin/signup-invites'

export function SignupInviteActions({
  invite,
}: {
  invite: {
    id: string
    email: string
    note: string | null
    skipPayment: boolean
    status: SignupInviteStatus
    url: string
  }
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<'resend' | 'revoke' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function resend() {
    setBusy('resend')
    setMessage(null)
    try {
      const res = await fetch('/api/admin/signup-invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: invite.email, note: invite.note ?? undefined, skip_payment: invite.skipPayment }),
      })
      const data = await res.json()
      if (!res.ok) setMessage(data.error ?? 'Failed')
      else setMessage(data.email_sent ? 'Re-sent' : 'Saved, email failed')
      router.refresh()
    } catch {
      setMessage('Network error')
    } finally {
      setBusy(null)
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke the invite for ${invite.email}?`)) return
    setBusy('revoke')
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/signup-invites/${invite.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        setMessage(data.error ?? 'Failed')
        return
      }
      router.refresh()
    } catch {
      setMessage('Network error')
    } finally {
      setBusy(null)
    }
  }

  if (invite.status === 'used') {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
      {invite.status === 'pending' && <CopyLink url={invite.url} />}
      <Button variant="outline" size="sm" onClick={resend} disabled={busy !== null}>
        {busy === 'resend' ? 'Sending...' : invite.status === 'expired' ? 'Renew & resend' : 'Resend'}
      </Button>
      <Button variant="ghost" size="sm" onClick={revoke} disabled={busy !== null} className="text-destructive">
        {busy === 'revoke' ? 'Revoking...' : 'Revoke'}
      </Button>
    </div>
  )
}
