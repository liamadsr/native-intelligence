'use client'

/** ⇧⌘B (docs/plans/github-reviews.md): copy an action's branch name, and say so. */
import { toast } from 'sonner'
import { copyTextToClipboard } from '@/lib/clipboard'
import { branchNameFor } from './branch-name'

export async function copyBranchName(identifier: string, title: string | null | undefined): Promise<string | null> {
  const name = branchNameFor(identifier, title)
  if (!name) return null
  if (await copyTextToClipboard(name)) {
    toast.success(`Copied ${name}`)
    return name
  }
  toast.error('Could not copy the branch name')
  return null
}
