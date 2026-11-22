'use client'

/**
 * What a comment box keeps of its `@` picks, for the comments that live on a
 * record of their own kind (a canvas, a spreadsheet). The box is a
 * MentionTextarea given `textareaProps`; when the comment is sent, `payload`
 * is what goes beside the words: the teammates and the records whose `@label`
 * is still in them (a mention deleted from the text is not sent).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { hasMention } from '@/lib/team-chat/compose'
import type { LabeledMentionRef } from '@/lib/entity-links/mentionable'
import type { ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import { memberName, type Member } from '@/app/account/(dashboard)/views/team-chat-message-parts'

export interface CommentMentionsPayload {
  mentions: string[]
  records: LabeledMentionRef[]
}

/** The teammates and records still named in the words. */
export function mentionsStillNamed(text: string, members: readonly ComposerMentionOption[], records: readonly LabeledMentionRef[]): CommentMentionsPayload {
  return {
    mentions: [...new Set(members.filter((m) => hasMention(text, m.label)).map((m) => m.id))],
    records: records.filter((r) => hasMention(text, r.label)),
  }
}

/** The workspace's members as `@` options, less the viewer. Shared by every box on the page (one cached request). */
export function useMentionMembers(me?: string | null): ComposerMentionOption[] {
  const workspaceId = useWorkspaceId()
  const [members, setMembers] = useState<Member[]>([])
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    cachedJson<{ members?: Member[] }>('/api/account/workspace/members', { scope: workspaceId })
      .then((data) => {
        if (!cancelled) setMembers(Array.isArray(data?.members) ? data.members : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspaceId])
  return useMemo(() => members.filter((m) => m.id !== me).map((m) => ({ id: m.id, label: memberName(m) })), [members, me])
}

export function useCommentMentions(members: readonly ComposerMentionOption[], already: readonly string[] = []) {
  // An edit starts from who the comment already mentions.
  const seeded = useMemo(() => members.filter((m) => already.includes(m.id)), [members, already])
  const [pickedMembers, setPickedMembers] = useState<ComposerMentionOption[]>([])
  const [pickedRecords, setPickedRecords] = useState<LabeledMentionRef[]>([])
  const onMemberMention = useCallback((m: ComposerMentionOption) => setPickedMembers((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m])), [])
  const onMention = useCallback((r: LabeledMentionRef) => setPickedRecords((prev) => (prev.some((p) => p.type === r.type && p.id === r.id) ? prev : [...prev, r])), [])
  const payload = useCallback((text: string) => mentionsStillNamed(text, [...seeded, ...pickedMembers], pickedRecords), [seeded, pickedMembers, pickedRecords])
  const reset = useCallback(() => {
    setPickedMembers([])
    setPickedRecords([])
  }, [])
  return { textareaProps: { members, onMemberMention, onMention }, payload, reset }
}
