/**
 * Where a form's files go once its row is stored (migration 663; the
 * intake's last step, ./submit.ts). Server only: the service role's client.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formFilePath, type CheckedFile } from './files'
import type { DataForm } from './types'

/**
 * A stored row's files as its attachments (migration 663): each file's bytes
 * to the private attachments bucket under a random name (./files.ts
 * formFilePath) with the type ./files.ts decided, never the one declared;
 * then its attachments row: on the row, from_form, the form it came through,
 * and no uploader. A row that can't be inserted takes its object back out.
 * Nothing is extracted, thumbnailed or indexed (no attachment/index event):
 * a stranger's file is read by a model only when someone asks, inside the
 * untrusted fence (src/lib/ai/tools/attachments.ts).
 */
export async function storeFormFiles(
  supabase: SupabaseClient,
  form: DataForm,
  rowId: string,
  files: readonly CheckedFile[],
  newId: () => string = randomUUID,
): Promise<{ stored: number; failed: number }> {
  let stored = 0
  let failed = 0
  for (const [i, file] of files.entries()) {
    const path = formFilePath(form.workspaceId, form.id, newId(), file.ext)
    const bucket = supabase.storage.from('attachments')
    const up = await bucket.upload(path, file.bytes, { contentType: file.mime, upsert: false, cacheControl: '3600' }).catch((err: unknown) => ({ error: err instanceof Error ? err : new Error(String(err)) }))
    if (up.error) {
      failed++
      console.error(`[form-intake] form=${form.id} row=${rowId} file upload failed:`, up.error.message)
      continue
    }
    const { error } = await supabase.from('attachments').insert({
      user_id: null,
      workspace_id: form.workspaceId,
      data_row_id: rowId,
      from_form: true,
      form_id: form.id,
      file_name: file.name,
      file_size_bytes: file.size,
      mime_type: file.mime,
      file_extension: file.ext,
      file_category: file.category,
      storage_bucket: 'attachments',
      storage_path: path,
      display_order: i,
    })
    if (error) {
      failed++
      console.error(`[form-intake] form=${form.id} row=${rowId} file row failed:`, error.message)
      await bucket.remove([path]).catch(() => {})
      continue
    }
    stored++
  }
  return { stored, failed }
}
