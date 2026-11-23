/**
 * Each place's file, as the in-app viewer takes it (lib/files/viewer-file.ts),
 * read with that place's own rule:
 *   a mail attachment   through its mailbox's own attachment route (the
 *                       owner's, or a share's), the bytes it would download;
 *   a team chat file    through a short signed link the bucket's read policy
 *                       (team_chat_can_read, 558) signs only for the
 *                       channel's readers, signed again when it has run out;
 *   an uploaded file    through a short signed link from the attachments
 *                       bucket (its own read policy, 663 and 696, fences it).
 */
import { downloadFile } from '@/lib/download'
import { createClient } from '@/lib/supabase/client'
import { cachedTeamChatFileUrl, teamChatFileUrl } from '@/lib/team-chat/upload-client'
import type { TeamChatAttachment } from '@/lib/team-chat/types'
import { routeLoader, type ViewerFile } from './viewer-file'

/** A mail attachment as the viewer takes it: read through its own attachment route. */
export function emailViewerFile(attachment: { name: string; size: number; mimeType: string }, href: string, sourceLabel = 'Email attachment'): ViewerFile {
  return {
    key: `email:${href}`,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sourceLabel,
    load: routeLoader(href),
    download: async () => {
      await downloadFile(href, attachment.name)
    },
  }
}

/** A team chat file as the viewer takes it, at `url` (a signed link); comments on it when its message is known. */
export function teamChatViewerFile(attachment: Pick<TeamChatAttachment, 'path' | 'name' | 'size' | 'type'>, url: string, sourceLabel = 'Team chat', messageId?: string | null): ViewerFile {
  return {
    ...(messageId ? { commentTarget: { kind: 'chat' as const, messageId, path: attachment.path } } : {}),
    key: `team-chat:${attachment.path}`,
    name: attachment.name,
    mimeType: attachment.type,
    size: attachment.size,
    url,
    sourceLabel,
    download: async () => {
      const fresh = cachedTeamChatFileUrl(attachment.path) ?? (await teamChatFileUrl(attachment.path))
      if (!fresh) throw new Error('Could not download the file')
      await downloadFile(fresh, attachment.name)
    },
  }
}

/** A team chat file's link: the cached one while good, else signed again. */
export async function teamChatFileLink(path: string): Promise<string | null> {
  return cachedTeamChatFileUrl(path) ?? (await teamChatFileUrl(path))
}

/** Signed for ten minutes: enough for a video to stream. */
export const UPLOAD_VIEW_TTL_SECONDS = 600

/** A short signed link to an uploaded file; `download` names the file storage sends as an attachment. */
export async function uploadFileLink(path: string, ttl = UPLOAD_VIEW_TTL_SECONDS, download?: string): Promise<string | null> {
  const { data } = await createClient().storage.from('attachments').createSignedUrl(path, ttl, download ? { download } : undefined)
  return data?.signedUrl ?? null
}

/** An uploaded file as the viewer takes it. A form's file (a stranger's) is never rendered, an image aside. */
export function uploadViewerFile(
  file: { id: string; file_name: string; mime_type: string | null; file_size_bytes: number | null; storage_path: string; from_form?: boolean | null; file_category?: string | null },
  url: string,
  sourceLabel?: string | null,
): ViewerFile {
  return {
    key: `attachment:${file.id}`,
    // A stranger's file is never opened in place, so no comments are kept on it here.
    ...(file.from_form ? {} : { commentTarget: { kind: 'attachment' as const, id: file.id } }),
    name: file.file_name,
    mimeType: file.mime_type,
    size: file.file_size_bytes,
    url,
    sourceLabel: sourceLabel ?? null,
    downloadOnly: !!file.from_form && file.file_category !== 'image',
    download: async () => {
      const fresh = await uploadFileLink(file.storage_path, 60, file.from_form ? file.file_name : undefined)
      if (!fresh) throw new Error('Could not download the file')
      await downloadFile(fresh, file.file_name)
    },
  }
}
