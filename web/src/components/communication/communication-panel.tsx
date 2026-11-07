'use client'

/**
 * The agent panel's reach tabs (agent-look-editor.tsx): how the person and
 * their agent reach each other outside the app, and who else may (Liam,
 * 2026-10-24: "break communication out into their own tabs ... so you can
 * comfortably set up each one", and a People tab "where you can see who's
 * been given access to what").
 *
 *   Phone    texting the agent: add a number, get a code, type it back
 *            (phone-section.tsx, as Settings › Phone shows it)
 *   Slack    the Slack connector, as the Phone tab's card: link your
 *            account by sending the bot a code (slack-card.tsx)
 *   People   who can talk to the agent, and over what: the person, over
 *            their phone and Slack, and the people they've given access
 *            (guest access; people-panel.tsx).
 *
 * Each reads and writes the same routes as its settings page, so a change in
 * either shows in the other.
 */

import { SlackCard } from './slack-card'
import { PhoneSection } from './phone-section'

export function PhonePanel({ name }: { name: string }) {
  return (
    // The card centred in the tab, up and down too: a short step doesn't leave a gap under it.
    <div className="flex min-h-full flex-col justify-center" data-communication="phone">
      <PhoneSection compact name={name} />
    </div>
  )
}

export function SlackPanel({ name }: { name: string }) {
  return (
    <div className="flex min-h-full flex-col justify-center" data-communication="slack">
      <SlackCard name={name} />
    </div>
  )
}

export type ReachTab = 'phone' | 'slack'

export { PeoplePanel } from './people-panel'
