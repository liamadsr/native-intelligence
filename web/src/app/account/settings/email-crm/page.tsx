'use client'

import { useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

/**
 * Settings → Email & CRM: sync your mail threads and contacts, and see the
 * counts.
 *
 * There are no draft settings (Liam, 2026-10-17). "Auto-generate drafts",
 * "Default tone" and "Auto-sync contacts from email" were never saved or read
 * by anything, so they are gone: drafts are always on, and write the way you
 * do, from what Dial8 learns of how you write (Settings → Memory shows it).
 */
/** Companies page size: the companies route caps `limit` at 200. */
const COMPANY_PAGE = 200

/**
 * Contact and company counts. Contacts come back with a `total`; companies do
 * not (and `limit=0` returns no rows), so they are counted page by page.
 */
async function fetchCounts(): Promise<{ contacts: number; companies: number }> {
  const contactsRes = await fetch('/api/account/contacts?limit=0')
  if (!contactsRes.ok) throw new Error('contacts count failed')
  const contactsData = await contactsRes.json()
  let companies = 0
  for (let offset = 0; ; offset += COMPANY_PAGE) {
    const res = await fetch(`/api/account/companies?limit=${COMPANY_PAGE}&offset=${offset}`)
    if (!res.ok) throw new Error('companies count failed')
    const page = ((await res.json()).companies ?? []) as unknown[]
    companies += page.length
    if (page.length < COMPANY_PAGE) break
  }
  return { contacts: contactsData.total || 0, companies }
}

export default function EmailCrmSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const [contactCount, setContactCount] = useState(0)
  const [companyCount, setCompanyCount] = useState(0)
  const [lastSynced, setLastSynced] = useState<string | null>(null)

  useEffect(() => {
    fetchCounts().then(({ contacts, companies }) => {
      setContactCount(contacts)
      setCompanyCount(companies)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const syncRes = await fetch('/api/account/contacts/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_sync: true }),
      })
      const participantsRes = await fetch('/api/account/contacts/sync-from-participants', { method: 'POST' })
      if (!syncRes.ok || !participantsRes.ok) throw new Error('sync failed')

      // Refresh stats
      const { contacts, companies } = await fetchCounts()
      setContactCount(contacts)
      setCompanyCount(companies)
      setLastSynced(new Date().toLocaleTimeString())
    } catch {
      toast.error("Couldn't sync contacts")
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncEmail = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/account/email/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_sync: true }),
      })
      if (!res.ok) throw new Error('sync failed')
    } catch {
      toast.error("Couldn't sync email")
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Email & CRM</h1>
        <p className="text-sm text-muted-foreground">Sync your email threads, contacts and companies.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email</CardTitle>
          <CardDescription>Dial8 drafts replies the way you write. See what it has learned in Settings → Memory.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={handleSyncEmail} disabled={syncing}>
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', syncing && 'animate-spin')} />
            Sync Email Threads
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contacts</CardTitle>
          <CardDescription>Import contacts from your email provider.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            {loading ? (
              <ThinkingOrb state="working" size={20} theme="auto" />
            ) : (
              <>
                <p>Contacts imported: {contactCount}</p>
                <p>Companies created: {companyCount}</p>
                {lastSynced && <p>Last synced: {lastSynced}</p>}
              </>
            )}
          </div>

          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', syncing && 'animate-spin')} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
