/**
 * Index the text of a team chat message's files (migration 697;
 * lib/drive/chat-file-text.ts), when the message is posted with files the
 * extractor reads. Event `team-chat/files.posted` { messageId }, sent by the
 * messages route. One step: the passages never leave it (Inngest's step
 * payload limit), only counts.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { indexTeamChatMessageFiles } from '@/lib/drive/chat-file-text'

export const TEAM_CHAT_FILES_POSTED = 'team-chat/files.posted'

export const teamChatFileIndex = inngest.createFunction(
  {
    id: 'team-chat-file-index',
    retries: 3,
    concurrency: [{ limit: 3 }],
    triggers: [{ event: TEAM_CHAT_FILES_POSTED }],
  },
  async ({ event, step }) => {
    const { messageId } = event.data as { messageId?: unknown }
    if (typeof messageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(messageId)) return { skipped: 'no message' }
    return step.run('index-files', () => indexTeamChatMessageFiles(getServiceClient(), messageId))
  },
)
