/**
 * What the full composer says about the controls a conversation that isn't
 * the main chat can't honour (bots v4, ChatInputUnavailable): shown on the
 * control's dimmed pill, and when it's pressed. Shared by a run's chat
 * (run-chat.tsx) and a teammate's (teammate-chat.tsx).
 */

/** Why a run's chat has no agent picker. */
export function runChatAgentReason(agentName: string | null | undefined): string {
  return agentName ? `This chat is ${agentName}’s run: its agent can’t change here.` : 'This chat is the run’s own: its agent can’t change here.'
}

/** Why a teammate's own chat has no agent picker. */
export function teammateAgentReason(name: string | null | undefined): string {
  return `${name ?? 'This teammate'} is the agent in this chat: its persona and tools are its own.`
}

/**
 * Why a run's chat or a teammate's thread can't take photos yet: the agent
 * would get it only as a file part, which eve keeps in the session's sandbox
 * (provisioning one) or, as a link, in a history that outlives the link.
 * The run-chat routes refuse a photo with the same words
 * (RUN_CHAT_PHOTO_REFUSAL in run-chat-turn.ts).
 */
export const CHAT_PHOTOS_REASON = 'Photos can’t be sent in this chat yet. Describe what the photo shows instead.'
