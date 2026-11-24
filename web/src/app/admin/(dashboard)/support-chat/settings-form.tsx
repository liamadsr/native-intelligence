'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SUPPORT_WELCOME_MAX, welcomeWords, type SupportChatSettings, type SupportStaffRow } from '@/lib/support-chat/welcome'

const START_WORDS: Record<string, string> = {
  started: 'Started: it’s in their team chat now, with the welcome.',
  exists: 'They already have one.',
  deleted: 'They had deleted theirs: a fresh one is started.',
  staff: 'That account is on the support team.',
  no_workspace: 'That account has no workspace yet.',
  no_staff: 'Nobody is on the support team yet: open team chat once as an admin first.',
  no_account: 'No account has that address.',
}

export function SupportChatSettingsForm({ settings, staff }: { settings: SupportChatSettings; staff: SupportStaffRow[] }) {
  const [template, setTemplate] = useState(settings.welcome_template)
  const [sender, setSender] = useState(settings.sender_user_id ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [starting, setStarting] = useState(false)
  const [startResult, setStartResult] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setSaved(null)
    const res = await fetch('/api/admin/support-chat', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ welcomeTemplate: template, senderUserId: sender || null }),
    }).catch(() => null)
    const json = (await res?.json().catch(() => null)) as { error?: string } | null
    setSaving(false)
    setSaved(res?.ok ? 'Saved. New accounts get this welcome.' : (json?.error ?? 'Couldn’t save.'))
  }

  const start = async () => {
    setStarting(true)
    setStartResult(null)
    const res = await fetch('/api/admin/support-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }).catch(() => null)
    const json = (await res?.json().catch(() => null)) as { reason?: string; error?: string } | null
    setStarting(false)
    setStartResult(res?.ok ? (START_WORDS[json?.reason ?? ''] ?? 'Done.') : (json?.error ?? 'Couldn’t start it.'))
  }

  const senderName = staff.find((s) => s.user_id === sender)?.display_name ?? staff[0]?.display_name ?? 'Support'

  return (
    <div className="mt-6 space-y-8">
      <section className="space-y-3" data-support-settings="">
        <h2 className="text-base font-semibold">Welcome</h2>
        <div className="space-y-1.5">
          <Label htmlFor="support-welcome">Words</Label>
          <Textarea id="support-welcome" rows={4} maxLength={SUPPORT_WELCOME_MAX} value={template} onChange={(e) => setTemplate(e.target.value)} />
          <p className="text-xs text-muted-foreground">{'{name}'} becomes an @-mention of them; {'{first_name}'} their first name.</p>
        </div>
        <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm" data-support-preview="">
          <p className="text-xs font-medium text-muted-foreground">{senderName} · Support</p>
          <p className="mt-1 whitespace-pre-wrap">{welcomeWords(template, 'Ana Ruiz')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="support-sender">Sent by</Label>
          <select
            id="support-sender"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
          >
            <option value="">The longest-standing on the team{staff[0] ? ` (${staff[0].display_name})` : ''}</option>
            {staff.map((s) => (
              <option key={s.user_id} value={s.user_id}>
                {s.display_name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            On the team: {staff.length ? staff.map((s) => s.display_name).join(', ') : 'nobody yet (an admin is added when they open team chat)'}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {saved && <span className="text-sm text-muted-foreground">{saved}</span>}
        </div>
      </section>

      <section className="space-y-3" data-support-start-form="">
        <h2 className="text-base font-semibold">Start one for an existing account</h2>
        <p className="text-sm text-muted-foreground">Accounts made before support chat have none. Start theirs here, one at a time.</p>
        <div className="flex gap-2">
          <Input type="email" placeholder="their@address.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button onClick={() => void start()} disabled={starting || !email.includes('@')}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
        </div>
        {startResult && <p className="text-sm text-muted-foreground">{startResult}</p>}
      </section>
    </div>
  )
}
