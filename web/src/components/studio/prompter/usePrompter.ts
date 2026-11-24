'use client'
// The prompter's state for one take: where the speaker is in the script (follow.ts) and the checklist's checks
// (checklist.ts), updated from the words heard (live-words.ts). Checks are this take's only: a retake starts clear.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { autoCheck, EMPTY_CHECKS, nextItem, toggle, type ChecklistItem, type ChecklistState } from '@/lib/studio/prompter/checklist'
import { follow, indexScript, placeBeforeLine, START, type FollowPlace, type ScriptLine } from '@/lib/studio/prompter/follow'
import type { Heard } from '@/lib/studio/prompter/live-words'

export function usePrompter(lines: ScriptLine[], items: ChecklistItem[], heard: Heard) {
  const index = useMemo(() => indexScript(lines), [lines])
  const [place, setPlace] = useState<FollowPlace>(START)
  const [checks, setChecks] = useState<ChecklistState>(EMPTY_CHECKS)

  // A new script starts at its top.
  useEffect(() => { setPlace(START) }, [index])
  useEffect(() => { setPlace((p) => follow(index, p, heard.finals, heard.interim)) }, [index, heard])
  // Only final words check items (a guess is not what was said).
  useEffect(() => { setChecks((c) => autoCheck(items, c, heard.finals)) }, [items, heard.finals])

  const toggleItem = useCallback((id: string) => setChecks((c) => toggle(c, id)), [])
  /** "Start here": the person points at the line they are on. */
  const startAt = useCallback((line: number) => { const at = placeBeforeLine(index, line); setPlace({ confirmed: at, shown: at }) }, [index])
  const next = useMemo(() => nextItem(items, checks), [items, checks])
  return { index, place, checks, next, toggleItem, startAt }
}
