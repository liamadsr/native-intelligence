import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { INDEXABLE_ATTACHMENT_EXTENSIONS } from '@/lib/attachments/extract-text'
import { isImageUploadExtension, isOwnChatUploadPath } from '@/lib/chat/upload-allowlist'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { TOOL_IMAGE_BASE64, TOOL_IMAGE_MIME_TYPE, imageForModel } from './tool-image'
import { withGrantedIds } from '@/lib/entity-access/grants'
import {
  resolveEntityWorkspace,
  applyCaptureVisibility,
  captureReadAccess,
  captureRequester,
  FUZZY_MATCH_LIMIT,
  listMatches,
  soleMatch,
} from './_shared'

/**
 * @param omitPrivateCaptures unattended runs pass true: an attachment on a
 *   capture is then reachable only when that capture is workspace-visible.
 */
export function createAttachmentTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  omitPrivateCaptures = false,
) {
  // Attachments are shared workspace rows, but one on a capture is only as
  // visible as that capture (RLS `attachments_workspace_select`, migration
  // 223). MCP and unattended runs use a service-role client, so this requester
  // is what keeps a teammate's private meeting's files hidden there.
  const requester = captureRequester(userId, omitPrivateCaptures)

  /**
   * The ids, among `captureIds`, of captures the caller may see in this
   * workspace: for a READ, so a teammate's private capture shared with them
   * (a grant, 492; the attachment policy's arm, 493) counts.
   */
  const visibleCaptureIds = async (captureIds: string[]): Promise<Set<string>> => {
    if (captureIds.length === 0) return new Set()
    const { data } = await applyCaptureVisibility(
      supabase.from('captures').select('id').eq('workspace_id', workspaceId).in('id', captureIds),
      requester,
    )
    const visible = (data || []).map((c) => c.id as string)
    return withGrantedIds(supabase, { userId: requester, workspaceId }, 'capture', captureIds, visible)
  }

  return {
    list_attachments: tool({
      description:
        'List file attachments on a capture or action. Returns metadata and signed download URLs. Use this to see what files are attached before downloading them.',
      inputSchema: z.object({
        capture_id: z.string().optional().describe('UUID of the capture to list attachments for'),
        action_id: z.string().optional().describe('UUID of the action to list attachments for'),
        project_id: z.string().optional().describe('UUID of the project to list all attachments across its captures'),
      }),
      execute: async ({ capture_id, action_id, project_id }) => {
        if (!capture_id && !action_id && !project_id) {
          return { success: false, error: 'Provide one of capture_id, action_id, or project_id' }
        }

        // Workspace-wide, not uploader-scoped: a teammate's file on a shared
        // action or capture is listed too. Capture visibility is applied below.
        let query = supabase
          .from('attachments')
          .select('id, file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path, note_id, action_id, project_id, created_at')
          .eq('workspace_id', workspaceId)

        if (capture_id) query = query.eq('note_id', capture_id)
        if (action_id) query = query.eq('action_id', action_id)
        if (project_id) query = query.eq('project_id', project_id)

        query = query.order('created_at', { ascending: false })

        const { data, error } = await query

        if (error) return { success: false, error: error.message }

        // Drop files hanging off a capture the caller may not see (a
        // teammate's private meeting). Files on no capture stay.
        const rows = data || []
        const visible = await visibleCaptureIds([
          ...new Set(rows.map((a) => a.note_id as string | null).filter((id): id is string => Boolean(id))),
        ])
        const attachments = rows.filter((a) => !a.note_id || visible.has(a.note_id as string)).map((a) => ({
          id: a.id,
          file_name: a.file_name,
          file_size_bytes: a.file_size_bytes,
          mime_type: a.mime_type,
          file_extension: a.file_extension,
          file_category: a.file_category,
          capture_id: a.note_id,
          action_id: a.action_id,
          project_id: a.project_id,
          created_at: a.created_at,
        }))

        return { success: true, attachments, count: attachments.length }
      },
    }),

    read_chat_file: tool({
      description:
        'Read a file the user uploaded in chat, directly from its storage_path — without first attaching it to any action or capture. Use this when the user uploads a markdown, text, code, csv, or json file and wants you to read, summarize, or ingest it, and to LOOK AT a photo or image they uploaded: a photo is never in the message itself, only named there with its storage_path. You will find the storage_path in the "## Chat File Uploads" section of your context (and beside each photo in the message). Returns the file text for text-based files, and the image itself for an image (shown to a model that can view images). Other binary files (PDF, Office docs) are not supported here (no text extraction) — for those, fall back to attaching the file. This does NOT create an attachment row.',
      inputSchema: z.object({
        storage_path: z
          .string()
          .describe('The storage_path of the chat-uploaded file, e.g. "<user-id>/chat-uploads/<uuid>.md" (from the chat upload metadata)'),
      }),
      execute: async ({ storage_path }) => {
        // Security: a chat upload always lives under the CALLER's own prefix
        // (`${user.id}/chat-uploads/...`, see /api/ai/chat/upload). Storage is
        // service-role here, so without this guard a crafted storage_path could
        // read another user's files. Pin reads to ONE object directly in the
        // caller's chat-uploads dir: storage-js does not encode the path, so a
        // prefix check alone lets `../` or `%2e%2e` walk out of the folder.
        if (!isOwnChatUploadPath(userId, storage_path)) {
          return {
            success: false,
            error: 'storage_path must be a file you uploaded in this chat (under your chat-uploads folder).',
          }
        }

        const ext = storage_path.split('.').pop()?.toLowerCase() || ''

        // A photo: scaled for the model and handed back as the image (see
        // ./tool-image.ts for who sees it). The chat's photos come only this
        // way, never as a file part on the message (that starts a sandbox).
        // An SVG stays text below: every model reads that.
        if (isImageUploadExtension(ext) && ext !== 'svg') {
          const { data: imageData, error: imageError } = await supabase.storage.from('attachments').download(storage_path)
          if (imageError || !imageData) {
            return { success: false, error: imageError?.message || 'Failed to download image' }
          }
          const image = await imageForModel(Buffer.from(await imageData.arrayBuffer()))
          const file_name = storage_path.split('/').pop() || storage_path
          if (!image) {
            return { success: false, error: `"${file_name}" can't be shown: it isn't an image that can be read.` }
          }
          return {
            success: true,
            file_name,
            file_extension: ext,
            mime_type: image.mediaType,
            width: image.width,
            height: image.height,
            [TOOL_IMAGE_BASE64]: image.base64,
            [TOOL_IMAGE_MIME_TYPE]: image.mediaType,
          }
        }

        const textExtensions = new Set([
          'txt', 'md', 'csv', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go',
          'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'css', 'scss',
          'html', 'xml', 'yaml', 'yml', 'toml', 'sh', 'sql', 'r', 'lua', 'php',
          'env', 'log', 'conf', 'cfg', 'ini', 'svg',
        ])

        if (!textExtensions.has(ext)) {
          return {
            success: false,
            error: `Cannot read "${ext || 'unknown'}" files as text here. Binary files (PDF, Office docs) are not supported by read_chat_file.`,
          }
        }

        const { data: fileData, error: downloadError } = await supabase.storage
          .from('attachments')
          .download(storage_path)

        if (downloadError || !fileData) {
          return { success: false, error: downloadError?.message || 'Failed to download file' }
        }

        const text = await fileData.text()
        const file_name = storage_path.split('/').pop() || storage_path

        return {
          success: true,
          file_name,
          file_extension: ext,
          // A file's text can carry someone else's instructions (a forwarded
          // doc, a pasted export): marked as data (src/lib/email/untrusted.ts).
          content: wrapUntrusted(text, 'FILE') ?? '',
        }
      },
    }),

    attach_chat_file: tool({
      description:
        'Attach a file that the user uploaded in chat to an action or capture. Use this when the user shares a file/image in chat and asks you to attach it to a specific action or capture. The file must have been uploaded in the current chat session — you will find it referenced as a file part in the user\'s message. You can reference the action by UUID, identifier (e.g. GEN-859), or title match.',
      inputSchema: z.object({
        storage_path: z.string().describe('The storage_path of the uploaded file (from the chat upload metadata)'),
        file_name: z.string().describe('Original file name'),
        file_size: z.number().describe('File size in bytes'),
        mime_type: z.string().describe('MIME type of the file'),
        action_id: z.string().optional().describe('UUID of the action to attach to'),
        action_identifier: z.string().optional().describe('Action identifier like GEN-859 — will be resolved to action_id'),
        action_title_match: z.string().optional().describe('Partial action title to match (case-insensitive)'),
        capture_id: z.string().optional().describe('UUID of the capture to attach to'),
        project_id: z.string().optional().describe('UUID of the project to associate with'),
      }),
      execute: async ({ storage_path, file_name, file_size, mime_type, action_id, action_identifier, action_title_match, capture_id, project_id }) => {
        // storage_path is model-controlled. Registering an attachments row for
        // a path outside the caller's own chat-uploads folder would grant the
        // whole workspace read/delete on that object via the row-gated storage
        // policies — pin it the same way read_chat_file does.
        if (!isOwnChatUploadPath(userId, storage_path)) {
          return {
            success: false,
            error: 'storage_path must be a file you uploaded in this chat (under your chat-uploads folder).',
          }
        }

        // Resolve action by identifier or title match if no UUID provided
        let resolvedActionId = action_id
        // Actions are shared rows, so the lookup is workspace-wide: a file can go
        // on a teammate's action as easily as on the caller's own.
        if (!resolvedActionId && action_identifier) {
          const { data } = await supabase
            .from('actions')
            .select('id')
            .eq('identifier', action_identifier)
            .eq('workspace_id', workspaceId)
            .single()
          resolvedActionId = data?.id
          if (!resolvedActionId) {
            return { success: false, error: `Action "${action_identifier}" not found` }
          }
        }
        if (!resolvedActionId && action_title_match) {
          // Everyone's actions: the sole match (or sole exact one), never the first.
          const { data } = await supabase
            .from('actions')
            .select('id, title, identifier')
            .eq('workspace_id', workspaceId)
            .ilike('title', `%${action_title_match}%`)
            .limit(FUZZY_MATCH_LIMIT)
          const rows = (data || []) as Array<{ id: string; title: string; identifier: string | null }>
          resolvedActionId = soleMatch(rows, (r) => r.title, action_title_match)?.id
          if (!resolvedActionId && rows.length > 1) {
            return {
              success: false,
              error: `"${action_title_match}" matches several actions: ${listMatches(rows.map((r) => `${r.identifier ?? r.id} "${r.title}"`))}. Pass action_identifier or action_id.`,
            }
          }
          if (!resolvedActionId) {
            return { success: false, error: `No action matching "${action_title_match}" found` }
          }
        }

        if (!resolvedActionId && !capture_id) {
          return { success: false, error: 'Provide either an action (by id, identifier, or title) or capture_id to attach the file to' }
        }

        // Route by the TARGET entity the file attaches to, not the session
        // workspace: an action_id/capture_id copied from the UI may live in
        // another workspace the caller belongs to (resolveEntityWorkspace),
        // and the attachment must land in THAT workspace or it becomes a
        // cross-tenant foreign key. `targetWs` below is what the insert uses.
        let targetWs = workspaceId
        let resolvedProjectId = project_id || null
        if (resolvedActionId) {
          const wsResolved = await resolveEntityWorkspace(supabase, userId, 'actions', resolvedActionId, workspaceId, strictWorkspace)
          if (!wsResolved) {
            return { success: false, error: 'Action not found in this workspace' }
          }
          targetWs = wsResolved.workspaceId
          const { data: action } = await supabase
            .from('actions')
            .select('id, project_id')
            .eq('id', resolvedActionId)
            .eq('workspace_id', targetWs)
            .maybeSingle()
          if (!action) {
            return { success: false, error: 'Action not found in this workspace' }
          }
          resolvedProjectId = action.project_id ?? null
        } else if (capture_id) {
          const wsResolved = await resolveEntityWorkspace(supabase, userId, 'captures', capture_id, workspaceId, strictWorkspace)
          if (!wsResolved) {
            return { success: false, error: 'Capture not found in this workspace' }
          }
          targetWs = wsResolved.workspaceId
          const { data: capture } = await supabase
            .from('captures')
            .select('id, project_id')
            .eq('id', capture_id)
            .eq('workspace_id', targetWs)
            .maybeSingle()
          if (!capture) {
            return { success: false, error: 'Capture not found in this workspace' }
          }
          resolvedProjectId = capture.project_id ?? null
        } else if (resolvedProjectId) {
          const { data: project } = await supabase
            .from('projects')
            .select('id')
            .eq('id', resolvedProjectId)
            .eq('workspace_id', targetWs)
            .maybeSingle()
          if (!project) {
            return { success: false, error: 'Project not found in this workspace' }
          }
        }

        const ext = file_name.split('.').pop()?.toLowerCase() || 'bin'
        const isImage = mime_type.startsWith('image/')
        const fileCategory = isImage ? 'image' : 'document'
        const isEmbeddable = INDEXABLE_ATTACHMENT_EXTENSIONS.has(ext)

        // Get current count for display_order — every file on the target, not
        // just the caller's, so a new one lands after a teammate's.
        let countQuery = supabase
          .from('attachments')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', targetWs)
        if (capture_id) countQuery = countQuery.eq('note_id', capture_id)
        if (resolvedActionId) countQuery = countQuery.eq('action_id', resolvedActionId)
        const { count } = await countQuery

        const { data, error } = await supabase
          .from('attachments')
          .insert({
            user_id: userId,
            workspace_id: targetWs,
            note_id: capture_id || null,
            action_id: resolvedActionId || null,
            project_id: resolvedProjectId,
            file_name,
            file_size_bytes: file_size,
            mime_type,
            file_extension: ext,
            file_category: fileCategory,
            storage_bucket: 'attachments',
            storage_path,
            display_order: count || 0,
          })
          .select('id, file_name, file_category, action_id, note_id')
          .single()

        if (error) return { success: false, error: error.message }

        // Fire-and-forget: trigger multimodal embedding for eligible file types
        if (isEmbeddable) {
          inngest.send({
            name: 'attachment/index',
            data: {
              attachmentId: data.id,
              userId,
              workspaceId: targetWs,
              projectId: resolvedProjectId,
            },
          }).catch((err) => {
            console.error('[attachments] Failed to send attachment/index event:', err)
          })
        }

        return {
          success: true,
          attachment: data,
          message: `Attached "${file_name}" to ${resolvedActionId ? 'action' : 'capture'}`,
        }
      },
    }),

    get_attachment_content: Object.assign(tool({
      description:
        'Get the content of a file attachment. For text-based files returns content as text. For images, downloads and displays the image so you can see and describe it. For binary files (PDF, Office docs) returns a signed download URL. IMPORTANT: After finding images via semantic_search_attachments, call this tool to actually view the image content.',
      inputSchema: z.object({
        attachment_id: z.string().describe('UUID of the attachment to retrieve'),
      }),
      execute: async ({ attachment_id }) => {
        const { data: attachment, error } = await supabase
          .from('attachments')
          .select('id, file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path, note_id')
          .eq('id', attachment_id)
          .eq('workspace_id', workspaceId)
          .single()

        if (error || !attachment) {
          return { success: false, error: error?.message || 'Attachment not found' }
        }

        // Any member may read a workspace attachment, but one on a capture
        // only when that capture is visible to them, or shared with them (a
        // grant) — a teammate's private meeting's file reads as absent.
        if (
          attachment.note_id &&
          !(await captureReadAccess(supabase, attachment.note_id as string, workspaceId, requester))
        ) {
          return { success: false, error: 'Attachment not found' }
        }

        if (!attachment.storage_path) {
          return { success: false, error: 'Attachment has no storage path' }
        }

        const ext = attachment.file_extension?.toLowerCase() || ''
        const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])

        // For text-based files, download and return content directly
        const textExtensions = new Set([
          'txt', 'md', 'csv', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go',
          'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'css', 'scss',
          'html', 'xml', 'yaml', 'yml', 'toml', 'sh', 'sql', 'r', 'lua', 'php',
          'env', 'log', 'conf', 'cfg', 'ini', 'svg',
        ])

        if (textExtensions.has(ext)) {
          const { data: fileData, error: downloadError } = await supabase.storage
            .from('attachments')
            .download(attachment.storage_path)

          if (downloadError || !fileData) {
            return { success: false, error: downloadError?.message || 'Failed to download file' }
          }

          const text = await fileData.text()

          return {
            success: true,
            file_name: attachment.file_name,
            file_extension: ext,
            mime_type: attachment.mime_type,
            // Marked as data: whoever wrote the file wrote this text.
            content: wrapUntrusted(text, 'FILE') ?? '',
          }
        }

        // For images, download and return base64 so toModelOutput can show inline
        if (IMAGE_MIME_TYPES.has(attachment.mime_type || '')) {
          const { data: fileData, error: downloadError } = await supabase.storage
            .from('attachments')
            .download(attachment.storage_path)

          if (downloadError || !fileData) {
            return { success: false, error: downloadError?.message || 'Failed to download image' }
          }

          const buffer = Buffer.from(await fileData.arrayBuffer())
          const { data: urlData } = await supabase.storage
            .from('attachments')
            .createSignedUrl(attachment.storage_path, 3600)

          return {
            success: true,
            file_name: attachment.file_name,
            file_extension: ext,
            mime_type: attachment.mime_type,
            file_size_bytes: attachment.file_size_bytes,
            signed_url: urlData?.signedUrl || null,
            __imageBase64: buffer.toString('base64'),
            __imageMimeType: attachment.mime_type,
          }
        }

        // For binary files, return a signed URL
        const { data: urlData, error: urlError } = await supabase.storage
          .from('attachments')
          .createSignedUrl(attachment.storage_path, 3600)

        if (urlError || !urlData?.signedUrl) {
          return { success: false, error: urlError?.message || 'Failed to generate URL' }
        }

        return {
          success: true,
          file_name: attachment.file_name,
          file_extension: ext,
          file_category: attachment.file_category,
          mime_type: attachment.mime_type,
          file_size_bytes: attachment.file_size_bytes,
          signed_url: urlData.signedUrl,
          note: 'This is a binary file. Use the signed URL to download it.',
        }
      },
    }), {
      toModelOutput({ output }: { output: Record<string, unknown> }) {
        const imageBase64 = output?.__imageBase64 as string | undefined
        const imageMimeType = output?.__imageMimeType as string | undefined

        if (!imageBase64 || !imageMimeType) {
          // Not an image or missing data — return as plain text
          const clean = { ...output }
          delete clean.__imageBase64
          delete clean.__imageMimeType
          return { type: 'text' as const, value: JSON.stringify(clean) }
        }

        // Build content with text metadata + inline image
        const textMeta = JSON.stringify({
          success: output.success,
          file_name: output.file_name,
          mime_type: output.mime_type,
          file_size_bytes: output.file_size_bytes,
          signed_url: output.signed_url,
        })

        return {
          type: 'content' as const,
          value: [
            { type: 'text', text: textMeta },
            { type: 'image-data', data: imageBase64, mediaType: imageMimeType },
          ],
        }
      },
    }),

  }
}
