/**
 * What a Listen brief can be about: the things a user opens in the app that
 * listen mode tells them about in a few spoken sentences, said from what the
 * workspace knows (how it works: ./build.ts). Shared by the client
 * (components/read-aloud/listen-brief.tsx) and the route
 * (/api/account/listen/brief), so it imports nothing.
 */

export const LISTEN_BRIEF_KINDS = ['capture', 'contact', 'company', 'event', 'project', 'initiative', 'action', 'agent', 'skill', 'flow'] as const

export type ListenBriefKind = (typeof LISTEN_BRIEF_KINDS)[number]

export function isListenBriefKind(value: unknown): value is ListenBriefKind {
  return typeof value === 'string' && (LISTEN_BRIEF_KINDS as readonly string[]).includes(value)
}
