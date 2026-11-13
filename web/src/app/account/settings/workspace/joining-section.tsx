'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Loader2, RefreshCw, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import type { JoinSettingsView } from '@/lib/workspace-join/view'

/**
 * The workspace's joining settings (/api/account/workspace/join). The view
 * owns the state because its Invitations block follows it too (a member
 * sees the invite form while "members can invite" is on).
 */
export function useJoinSettings() {
  const [view, setView] = useState<JoinSettingsView | null>(null)
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/account/workspace/join')
      if (!res.ok) return
      const data = (await res.json()) as Partial<JoinSettingsView> | null
      // Only a whole answer: anything else leaves the section hidden.
      if (data && data.link && data.byDomain && Array.isArray(data.invitableRoles)) setView(data as JoinSettingsView)
    } catch {
      // The section stays hidden; nothing else depends on it.
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { view, setView, reload }
}

type Busy = 'link' | 'by_domain' | 'members_can_invite' | 'reset' | `remove:${string}` | null

/**
 * "Joining": the shareable link (switch, Copy, Reset), join by email
 * domain, and "members can invite people". Owners and admins change them;
 * a member sees the link to copy only while members can invite; a guest sees
 * nothing here.
 */
export function JoiningSection({
  view,
  onChange,
}: {
  view: JoinSettingsView | null
  onChange: (next: JoinSettingsView) => void
}) {
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  if (!view) return null
  const { canManage } = view
  // A member without "members can invite" (or a guest) has nothing to do here.
  if (!canManage && !view.link.url) return null

  async function send(kind: Exclude<Busy, null>, init: { url: string; body?: Record<string, boolean | string[]> }) {
    setBusy(kind)
    setError('')
    try {
      const res = await fetch(init.url, {
        method: init.body ? 'PATCH' : 'POST',
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not save')
      onChange(data as JoinSettingsView)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(null)
    }
  }

  async function copyLink() {
    if (!view?.link.url) return
    try {
      await navigator.clipboard.writeText(view.link.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy the link')
    }
  }

  // Join by email domain: this admin's own domain is the switch; domains
  // other admins listed show below it, each with Remove.
  const { domains, yourDomain, unavailableReason } = view.byDomain
  const mineOn = yourDomain !== null && domains.includes(yourDomain)
  const others = domains.filter((d) => d !== yourDomain)

  return (
    <div className="mt-10" data-joining>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <UserPlus className="h-4 w-4" />
        Joining
      </div>
      <Separator className="mt-2 mb-4" />

      <div className="divide-y rounded-lg border">
        {/* The shareable link */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Invite link</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Anyone with the link can join as a member.
              </p>
            </div>
            {canManage && (
              <div className="flex shrink-0 items-center gap-2">
                {busy === 'link' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <Switch
                  checked={view.link.enabled}
                  disabled={busy !== null}
                  aria-label="Invite link"
                  onCheckedChange={(val) =>
                    send('link', { url: '/api/account/workspace/join', body: { link_enabled: val } })
                  }
                />
              </div>
            )}
          </div>
          {view.link.url && (
            <div className="mt-2 flex items-center gap-2">
              <Input
                readOnly
                value={view.link.url}
                aria-label="Invite link address"
                // Kept out of session replay and autocapture: the link admits whoever holds it.
                className="ph-no-capture h-8 font-mono text-xs"
              />
              <Button variant="outline" size="sm" className="gap-1.5" onClick={copyLink}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  disabled={busy !== null}
                  onClick={() => send('reset', { url: '/api/account/workspace/join/link/reset' })}
                >
                  {busy === 'reset' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Reset
                </Button>
              )}
            </div>
          )}
          {view.link.url && canManage && (
            <p className="mt-1.5 text-xs text-muted-foreground/80">Reset makes a new link; the old one stops working.</p>
          )}
        </div>

        {canManage && (
          <div className="px-4 py-3" data-by-domain>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {yourDomain ? `People with an @${yourDomain} email can join` : 'Join by email domain'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  After signing in with a verified address, they can join with one click. Nobody is added without it.
                </p>
                {unavailableReason && (
                  <p className="mt-0.5 text-xs text-muted-foreground/80">Unavailable: {unavailableReason}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {busy === 'by_domain' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <Switch
                  checked={mineOn}
                  disabled={busy !== null || yourDomain === null}
                  aria-label="Join by email domain"
                  onCheckedChange={(val) =>
                    send('by_domain', { url: '/api/account/workspace/join', body: { by_domain: val } })
                  }
                />
              </div>
            </div>
            {others.length > 0 && (
              <ul className="mt-2 space-y-1">
                {others.map((d) => (
                  <li key={d} className="flex items-center justify-between gap-4">
                    <span className="truncate text-xs text-muted-foreground">People with an @{d} email can join</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      disabled={busy !== null}
                      onClick={() =>
                        send(`remove:${d}`, { url: '/api/account/workspace/join', body: { remove_domains: [d] } })
                      }
                    >
                      {busy === `remove:${d}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Remove'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {canManage && (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Members can invite people</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Members can send invites (as members or guests) and copy the invite link.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {busy === 'members_can_invite' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <Switch
                checked={view.membersCanInvite}
                disabled={busy !== null}
                aria-label="Members can invite people"
                onCheckedChange={(val) =>
                  send('members_can_invite', { url: '/api/account/workspace/join', body: { members_can_invite: val } })
                }
              />
            </div>
          </div>
        )}
      </div>
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}
