'use client'

/**
 * A company's email, shared with the team (migration 680), on its page.
 *
 * Off by default. Turning "Share email with the team" on shares nobody's
 * mail by itself: each teammate's threads with this company show here only
 * once THEY agree, for this company ("Share my email"), and they can stop at
 * any time, here or for every company at once. A thread its owner keeps
 * private never shows. Who shares is always listed. The threads are read
 * live from each owner's mailbox (nothing is stored), view only.
 *
 * `ph-no-capture`: session replay never records the mail.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EyeOff, Loader2, Mail, Paperclip } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmailShareMessages } from '@/components/email/email-share-card'
import type { EmailShareMessage } from '@/lib/email-share/types'
import { cn } from '@/lib/utils'

interface Status {
  enabled: boolean
  changed_by_member_id: string | null
  changed_at: string | null
  my_consent: boolean
  sharers: Array<{ member_id: string; display_name: string | null; since: string }>
}

interface ThreadItem {
  id: string
  subject: string | null
  snippet: string | null
  from_name: string | null
  from_email: string | null
  last_message_at: string | null
  message_count: number | null
  has_attachments: boolean
  shared_by: { member_id: string; name: string }
  team: Array<{ member_id: string; name: string }>
  mine: boolean
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function CompanyTeamEmail({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [threads, setThreads] = useState<ThreadItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<ThreadItem | null>(null)
  const base = `/api/account/companies/${encodeURIComponent(companyId)}/team-email`

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' })
      if (!res.ok) {
        setStatus(null)
        return
      }
      const json = (await res.json()) as { status: Status; threads: ThreadItem[] }
      setStatus(json.status)
      setThreads(json.threads ?? [])
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const act = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true)
    try {
      const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(res.status === 400 && json.error ? json.error : "Couldn't save that")
        return false
      }
      if (done) toast(done)
      await load()
      return true
    } finally {
      setBusy(false)
    }
  }

  if (loading) return null
  if (!status) return null

  const sharers = status.sharers
  return (
    <section className="ph-no-capture space-y-3" data-company-team-email="">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Shared email</p>
          <p className="text-xs text-muted-foreground">
            {status.enabled
              ? 'Teammates’ email with this company shows here once each of them agrees. Nobody’s mail is shared without it.'
              : 'Off. Turn it on to let teammates share their email with this company here. Each of them still has to agree.'}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Share email with the team
          <Switch
            checked={status.enabled}
            disabled={busy}
            data-company-share-switch=""
            onCheckedChange={(on) => void act({ action: 'sharing', on }, on ? 'Sharing is on. Each teammate decides for their own mail.' : 'Sharing is off for this company.')}
            aria-label="Share email with the team"
          />
        </label>
      </div>

      {status.enabled && (
        <div className="space-y-2 rounded-md border border-border px-3 py-2 text-xs" data-company-share-consent="">
          {status.my_consent ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>You share your email with this company.</span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void act({ action: 'consent', on: false }, 'You stopped sharing your email with this company.')}>
                Stop sharing
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground"
                disabled={busy}
                onClick={() => void act({ action: 'stop_all' }, 'You stopped sharing your email with every company.')}
              >
                Stop for every company
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span>Your email with this company is not shared.</span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} data-company-share-mine="" onClick={() => void act({ action: 'consent', on: true }, 'Your email with this company is shared with the team.')}>
                Share my email
              </Button>
            </div>
          )}
          <p className="text-muted-foreground" data-company-sharers="">
            {sharers.length
              ? `Shared by ${sharers.map((s) => s.display_name || 'a teammate').join(', ')}.`
              : 'No one shares their email with this company yet.'}
          </p>
        </div>
      )}

      {status.enabled && threads.length > 0 && (
        <ul className="space-y-1" data-company-team-threads="">
          {threads.map((t) => (
            <li key={t.id} className="group/thread">
              <div className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/50">
                <button type="button" onClick={() => setOpen(t)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                  <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Mail className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-medium">{t.subject || '(subject not available)'}</span>
                      {t.has_attachments && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{when(t.last_message_at)}</span>
                    </div>
                    <p className="truncate text-muted-foreground">
                      {[t.from_name || t.from_email, t.message_count && t.message_count > 1 ? `${t.message_count} messages` : null].filter(Boolean).join(' · ')}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground" data-thread-team="">
                      Shared by {t.mine ? 'you' : t.shared_by.name}
                      {t.team.length ? ` · Team on it: ${t.team.map((m) => m.name).join(', ')}` : ''}
                    </p>
                  </div>
                </button>
                {t.mine && (
                  <button
                    type="button"
                    title="Keep this thread private"
                    className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/thread:opacity-100"
                    onClick={async () => {
                      const ok = await act({ action: 'private', thread_id: t.id, on: true })
                      if (ok)
                        toast('Kept private. It no longer shows on any company.', {
                          action: { label: 'Undo', onClick: () => void act({ action: 'private', thread_id: t.id, on: false }) },
                        })
                    }}
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {status.enabled && threads.length === 0 && sharers.length > 0 && (
        <p className="px-2 text-xs text-muted-foreground">No shared email with this company yet.</p>
      )}

      {open && <TeamThreadDialog base={base} item={open} onClose={() => setOpen(null)} />}
    </section>
  )
}

function TeamThreadDialog({ base, item, onClose }: { base: string; item: ThreadItem; onClose: () => void }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'thread'; subject: string; messages: EmailShareMessage[] } | { kind: 'gone' } | { kind: 'busy' }>({ kind: 'loading' })
  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(item.id)}`, { cache: 'no-store' })
        if (!current) return
        if (res.ok) {
          const json = (await res.json()) as { thread: { subject: string; messages: EmailShareMessage[] } }
          setState({ kind: 'thread', subject: json.thread.subject, messages: json.thread.messages })
        } else setState({ kind: res.status >= 500 ? 'busy' : 'gone' })
      } catch {
        if (current) setState({ kind: 'busy' })
      }
    })()
    return () => {
      current = false
    }
  }, [base, item.id])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="ph-no-capture flex max-h-[85vh] flex-col sm:max-w-2xl" data-company-team-thread="">
        <DialogHeader>
          <DialogTitle className="select-text pr-6">{state.kind === 'thread' ? state.subject : item.subject || 'Shared email'}</DialogTitle>
          <DialogDescription>
            Shared by {item.mine ? 'you' : item.shared_by.name} with the team, from their mailbox, read-only.
          </DialogDescription>
        </DialogHeader>
        <div className={cn('min-h-0 flex-1 space-y-3 overflow-y-auto')}>
          {state.kind === 'loading' ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </p>
          ) : state.kind === 'gone' ? (
            <p className="text-sm text-muted-foreground">This email is no longer shared, or no longer available.</p>
          ) : state.kind === 'busy' ? (
            <p className="text-sm text-muted-foreground">Couldn’t load right now. Try again in a moment.</p>
          ) : (
            <EmailShareMessages
              thread={{ messages: state.messages, missing: 0, blockedImages: 0 }}
              images={false}
              onLoadImages={() => undefined}
              attachmentHref={(messageId, key) => `${base}/${encodeURIComponent(item.id)}/attachment?message=${encodeURIComponent(messageId)}&key=${encodeURIComponent(key)}`}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
