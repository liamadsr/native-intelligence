'use client'

/**
 * Settings › Phone: the phone section (components/communication/phone-section.tsx)
 * on its own page. The 10DLC campaign and the texts Native Intelligence sends name this page
 * (dial8.ai/account/settings/phone), so it stays; the agent panel's
 * Communication tab shows the same section.
 */

import { MessageSquareText } from 'lucide-react'
import { PhoneSection } from '@/components/communication/phone-section'

export function PhoneSettingsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-800">
            <MessageSquareText className="h-5 w-5 text-sky-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Phone</h1>
            <p className="text-sm text-muted-foreground">
              Text your Native Intelligence agent from your phone. Your texts and its replies show up in your chat.
            </p>
          </div>
        </div>

        <PhoneSection />
      </div>
    </div>
  )
}
