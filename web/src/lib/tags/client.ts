'use client'

/**
 * The browser's half of tags: create one, and set the tags on a record.
 * The tag list itself is the labels cache (useScopedLabels), which every
 * picker already shares; these calls refresh it.
 */
import { invalidateLabelsCache } from '@/lib/labels/use-scoped-labels'
import type { LabelWithScope } from '@/lib/labels/utils'
import { tagColorStore } from './color-store'
import type { TagKind } from './kinds'

export interface NewTag {
  name: string
  color: string
  personal: boolean
}

export class TagRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function readError(res: Response): Promise<TagRequestError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return new TagRequestError(body?.error ?? `Request failed (${res.status})`, res.status)
}

export async function createTag(tag: NewTag): Promise<LabelWithScope> {
  const res = await fetch('/api/account/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tag.name, color: tag.color, personal: tag.personal }),
  })
  if (!res.ok) throw await readError(res)
  const { label } = (await res.json()) as { label: LabelWithScope }
  tagColorStore.put([label])
  invalidateLabelsCache()
  return label
}

function onUrl(kind: TagKind, id: string): string {
  return `/api/account/tags/on/${kind}/${encodeURIComponent(id)}`
}

/** Put one tag on a record (idempotent). */
export async function addTagToRecord(kind: TagKind, id: string, labelId: string): Promise<void> {
  const res = await fetch(onUrl(kind, id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label_id: labelId }),
  })
  if (!res.ok) throw await readError(res)
}

/** Take one tag off a record. */
export async function removeTagFromRecord(kind: TagKind, id: string, labelId: string): Promise<void> {
  const res = await fetch(`${onUrl(kind, id)}?label_id=${encodeURIComponent(labelId)}`, { method: 'DELETE' })
  if (!res.ok) throw await readError(res)
}
