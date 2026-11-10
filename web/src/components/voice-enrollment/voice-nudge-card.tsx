'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { AudioWaveform, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { useVoiceProfile } from '@/hooks/use-voice-profile'
import {
  hasEnoughSignIns,
  SIGN_IN_COUNT_METADATA_KEY,
} from '@/lib/onboarding/sign-in-count'

/**
 * Dashboard nudge that invites the user to teach Native Intelligence their voice. A standalone
 * surface — deliberately NOT spliced into OnboardingChecklist (its 5-step
 * completion ring would miscount for existing users) nor faked into the
 * AttentionDeck (server/realtime-driven proposal infra). It borrows only the
 * checklist's StepRow visual idiom inside a 320px rounded-xl card.
 *
 * Shows iff `!enrolled && !dismissed && enoughSignIns`, all USER-GLOBAL
 * (matching the user-global voice profile — training works in every workspace,
 * so "Later" in one workspace must silence it everywhere):
 *   • `enrolled`      ← shared use-voice-profile hook (GET /api/account/voice-profile)
 *   • `dismissed`     ← user_metadata.voice_nudge_dismissed off the browser session
 *   • `enoughSignIns` ← user_metadata.sign_in_count, so a brand-new user isn't
 *     handed this on top of the onboarding wizard, the guide and the arrival
 *     dashboard. See @/lib/onboarding/sign-in-count.
 *
 * Dismissal writes supabase.auth.updateUser({ data: { voice_nudge_dismissed:
 * true } }) — user-global, no route, no migration. Auto-hides forever once
 * enrolled (the hook refetches on focus, so completing the flow hides it without
 * a reload).
 *
 * Renders nothing until BOTH signals resolve, so the card never flashes on load.
 */
export function VoiceNudgeCard() {
  const { status, loading } = useVoiceProfile()

  // `dismissed` reads user_metadata off the session user — null until the async
  // getUser() resolves so we don't flash the card before we know its state.
  const [dismissed, setDismissed] = useState<boolean | null>(null)
  const [dismissing, setDismissing] = useState(false)
  // Whether the user has signed in enough times for first-run nudges. Same
  // getUser() call as the dismissal flag, so this costs nothing extra. `null`
  // until it resolves, for the same no-flash reason.
  const [enoughSignIns, setEnoughSignIns] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    const supabase = createClient()
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!active) return
        setDismissed(data.user?.user_metadata?.voice_nudge_dismissed === true)
        setEnoughSignIns(
          hasEnoughSignIns(data.user?.user_metadata?.[SIGN_IN_COUNT_METADATA_KEY]),
        )
      })
      .catch(() => {
        // Signed out / network error — treat as not-dismissed so a real user
        // still sees the nudge once the profile status resolves.
        if (active) {
          setDismissed(false)
          // Can't read the count either; don't let a transient failure
          // resurrect the nudge for a first-time user. Staying hidden is the
          // safe direction — it reappears on the next load.
          setEnoughSignIns(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  async function handleDismiss() {
    // Optimistically hide, then persist user-global. If the write fails the card
    // simply reappears on the next load — no error surface needed for a nudge.
    setDismissing(true)
    setDismissed(true)
    const supabase = createClient()
    await supabase.auth.updateUser({ data: { voice_nudge_dismissed: true } })
    setDismissing(false)
  }

  // Never flash: wait until the profile status has resolved AND the dismissal
  // flag has loaded. `loading` is only true during the very first hydrate.
  if (loading || status === null || dismissed === null || enoughSignIns === null) return null
  if (status.enrolled || dismissed) return null
  // Hold off for the first couple of sessions — signup already surfaces the
  // wizard, the guide and the arrival dashboard, and this competes with them.
  if (!enoughSignIns) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18 }}
      className="w-[320px] overflow-hidden rounded-xl border bg-background text-card-foreground shadow-lg dark:shadow-none"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        {/* Status icon — a quiet "not yet done" circle, matching StepRow's
         *  unlocked-not-done glyph. */}
        <div className="mt-0.5 shrink-0">
          <Circle className="h-4 w-4 text-muted-foreground/40" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <AudioWaveform className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[13px] font-medium leading-tight">
              Teach Native Intelligence your voice
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            60 seconds, once — Native Intelligence will always know which voice is yours.
          </p>

          <div className="mt-2 flex items-center gap-1.5">
            <Button
              asChild
              variant="secondary"
              size="sm"
              className="h-6 shrink-0 self-center px-2.5 text-[11px]"
            >
              <Link href="/account/voice-enrollment">Teach Native Intelligence</Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={dismissing}
              className={cn(
                'h-6 shrink-0 self-center px-2 text-[11px] text-muted-foreground shadow-none',
                'hover:bg-muted hover:text-foreground',
              )}
            >
              Later
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
