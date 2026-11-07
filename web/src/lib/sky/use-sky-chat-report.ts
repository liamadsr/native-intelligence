'use client'

/**
 * A chat panel tells the sky what it's doing: a reply streaming in or a page
 * full screen freezes the sky (holds in sky-activity), and whether its chat is
 * empty (nothing in the sky reads that now: the reading-column scrim it drove
 * is gone). Only the active tab's
 * panel reports; a hidden tab's panel withdraws its report. The effects key on
 * booleans, so a streaming reply costs nothing per token.
 */

import { useEffect, useId } from 'react'
import { skyActivity } from './sky-activity'

export function useSkyChatReport({
  active,
  streaming,
  fullScreen,
  empty,
}: {
  active: boolean
  streaming: boolean
  fullScreen: boolean
  empty: boolean
}): void {
  const id = useId()
  const holdStream = active && streaming
  const holdFull = active && fullScreen
  useEffect(() => {
    skyActivity.setHold(`stream${id}`, holdStream)
  }, [id, holdStream])
  useEffect(() => {
    skyActivity.setHold(`full${id}`, holdFull)
  }, [id, holdFull])
  useEffect(() => {
    skyActivity.setChatEmpty(id, active ? empty : null)
  }, [id, active, empty])
  useEffect(
    () => () => {
      skyActivity.setHold(`stream${id}`, false)
      skyActivity.setHold(`full${id}`, false)
      skyActivity.setChatEmpty(id, null)
    },
    [id],
  )
}
