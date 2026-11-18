'use client'

import type { ReactNode } from 'react'
import { RecordingProvider } from '@/hooks/recording-context'
import { DesktopSetupMount } from '@/components/desktop/desktop-setup-mount'
import { ReadAloudSectionsSupport } from './read-aloud-sections-support'
import { LocalAgentRelayMount } from './local-agent-relay-mount'
import { PresenceMount } from './presence-mount'
import { CloudComputerMount } from './cloud-computer-mount'
import { OwnCallDetectionMount } from './own-call-detection-mount'

/** Providers shared across all /account/* routes (dashboard, settings, onboarding).
 *  RecordingProvider lives here so an active capture survives navigation
 *  between the dashboard and settings pages. ReadAloudSectionsSupport sits
 *  inside it: the markdown section buttons go quiet while a capture records.
 *  LocalAgentRelayMount runs the Mac's local-agent relay (desktop main window
 *  only); PresenceMount tells the server whether the person is at this app
 *  and how far they have read their home thread (every window, signed in);
 *  CloudComputerMount the agent's computer (its cloud browser's live
 *  view on every window, and on the desktop's main window this Mac's exit for it).
 *  DesktopSetupMount downloads on-device speech in the background from a new user's first
 *  onboarding screen on (desktop only), holding off while a capture records,
 *  and keeps echo cancellation and meeting detection on. OwnCallDetectionMount
 *  holds the desktop's meeting detection back while the person is in one of
 *  our own calls, which the server records itself (desktop main window only). */
export function AccountProviders({ children }: { children: ReactNode }) {
  return (
    <RecordingProvider>
      <LocalAgentRelayMount />
      <PresenceMount />
      <CloudComputerMount />
      <DesktopSetupMount />
      <OwnCallDetectionMount />
      <ReadAloudSectionsSupport>{children}</ReadAloudSectionsSupport>
    </RecordingProvider>
  )
}
