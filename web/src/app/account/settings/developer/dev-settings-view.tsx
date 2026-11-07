'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Loader2, RotateCcw } from 'lucide-react'
import { HOME_ADOPTED_KEY_PREFIX } from '@/app/account/(dashboard)/use-home-conversation-adoption'
import { SkyPreviewSection } from './sky-preview-section'

export function DevSettingsView() {
  const [resetting, setResetting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  )
  const router = useRouter()

  async function handleResetOnboarding() {
    setResetting(true)
    setResult(null)
    try {
      const res = await fetch('/api/account/onboarding/reset', {
        method: 'POST',
      })
      if (res.ok) {
        // This browser adopts the home conversation once per workspace
        // (use-home-conversation-adoption.ts): clear those bits so the replay
        // lands on the new brief here too.
        try {
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith(HOME_ADOPTED_KEY_PREFIX)) localStorage.removeItem(key)
          }
        } catch {
          /* storage unavailable: the replay still runs, on whatever chat is open */
        }
        // router.refresh() invalidates the App Router cache, so going back to
        // /account re-reads the cleared state and lands on the wizard.
        router.refresh()
        setResult({
          ok: true,
          message: 'Onboarding reset: the wizard runs again next time you open /account.',
        })
      } else {
        const data = await res.json().catch(() => ({ error: 'Request failed' }))
        setResult({ ok: false, message: data.error ?? 'Failed to reset' })
      }
    } catch {
      setResult({ ok: false, message: 'Network error' })
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* What the sky looks like in any weather, at any time, anywhere */}
      <SkyPreviewSection />

      {/* Onboarding reset */}
      <div className="rounded-lg border p-6">
        <h3 className="text-sm font-semibold">Reset Onboarding</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Clears your <code className="rounded bg-muted px-1 py-0.5 text-xs">onboarding_completed_at</code> and{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">onboarding_progress</code>{' '}
          (including getting started) so you can test from scratch.
          Next time you visit{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">/account</code> you&apos;ll be
          redirected to the signup setup wizard.
        </p>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="outline"
            onClick={handleResetOnboarding}
            disabled={resetting}
          >
            {resetting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="mr-2 h-4 w-4" />
            )}
            {resetting ? 'Resetting...' : 'Reset onboarding'}
          </Button>

          {result && (
            <span
              className={`text-sm ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}
            >
              {result.message}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
