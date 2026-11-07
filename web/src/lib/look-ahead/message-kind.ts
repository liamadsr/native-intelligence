/**
 * The look-ahead's home-thread message kind (ui_message.metadata.kind), on its
 * own so the chat's live bridge (use-live-conversation.ts) can take the row
 * without bundling the server writer (./message.ts).
 */
export const LOOK_AHEAD_MESSAGE_KIND = 'look_ahead' as const
