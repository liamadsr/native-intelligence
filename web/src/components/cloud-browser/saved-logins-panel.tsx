'use client'

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { tauriBridge, type SavedLogin } from '@/lib/tauri-bridge'

/**
 * Saved logins, on the desktop app only: the sites the agent may sign in to by
 * itself when its browser reaches their sign-in page. Each password is kept in
 * this computer's keystore (the Keychain, or Credential Manager on Windows)
 * and nowhere else: this panel sends one to the desktop once, at Save, and can
 * never read one back. A login asks on this computer before each use; turning
 * that off is confirmed in a dialog on the computer itself, never by this page alone.
 *
 * Rendered over the live view's screen, like the blocked sites panel, with a
 * click-away backdrop.
 */
export function SavedLoginsPanel({ onClose, bridge = tauriBridge.savedLogins }: { onClose: () => void; bridge?: typeof tauriBridge.savedLogins }) {
  const [logins, setLogins] = useState<SavedLogin[] | null>(null)
  const [site, setSite] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setLogins((await bridge.list()) ?? []) } catch { setLogins([]) }
  }, [bridge])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      after?.()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!site.trim() || !username.trim() || !password) { setError('Enter the site, the account name and the password.'); return }
    // The password leaves this field once, for the desktop's keystore, and the field is emptied either way.
    const login = { site: site.trim(), username: username.trim(), password }
    setPassword('')
    void run(() => bridge.save(login), () => { setSite(''); setUsername('') })
  }

  const field = 'h-7 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div className="absolute inset-0 z-50 bg-background/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-label="Saved logins" data-saved-logins=""
        className="absolute right-3 top-3 max-h-[calc(100%-1.5rem)] w-80 overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium">Saved logins</p>
          <button type="button" onClick={onClose} aria-label="Close"
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          When your agent&rsquo;s browser reaches one of these sites&rsquo; sign-in page, it can sign in by itself while this app is open.
          Passwords are kept in this computer&rsquo;s keystore only, never on our servers.
        </p>

        <form className="mb-3 space-y-1.5" onSubmit={(e) => { e.preventDefault(); save() }}>
          <input aria-label="Site" placeholder="Site, like example.com" value={site} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={(e) => { setSite(e.target.value); setError(null) }} className={field} />
          <input aria-label="Account name" placeholder="Email or username" value={username} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            autoComplete="off" onChange={(e) => { setUsername(e.target.value); setError(null) }} className={field} />
          <div className="flex items-center gap-2">
            <input aria-label="Password" type="password" placeholder="Password" value={password} autoComplete="new-password"
              onChange={(e) => { setPassword(e.target.value); setError(null) }} className={field} />
            <button type="submit" disabled={busy} data-saved-logins-save=""
              className="h-7 shrink-0 rounded-full bg-foreground px-3 text-[11px] font-medium text-background hover:opacity-90 disabled:opacity-50">
              Save
            </button>
          </div>
        </form>
        {error && <p role="alert" className="mb-2 text-[11px] text-destructive">{error}</p>}

        {logins === null ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : logins.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No saved logins yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {logins.map((login) => (
              <li key={login.id} data-saved-login={login.site} className="rounded-lg bg-muted/50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs" title={login.site}>{login.site}</p>
                    <p className="truncate text-[11px] text-muted-foreground" title={login.username}>{login.username}</p>
                  </div>
                  <button type="button" disabled={busy} onClick={() => void run(() => bridge.remove(login.id))}
                    className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-50">
                    Remove
                  </button>
                </div>
                <label className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input type="checkbox" checked={login.ask} disabled={busy} onChange={(e) => void run(() => bridge.setAsk(login.id, e.target.checked))} />
                  Ask me on this computer before each use
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
