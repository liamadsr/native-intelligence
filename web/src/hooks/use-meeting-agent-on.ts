'use client'

/**
 * Whether this server lets people send their assistant to meetings
 * (MEETING_AGENT, roadmap #12): asked once per page load
 * (/api/account/meeting-agent?probe=1), shared by every caller (Settings' nav,
 * the prep card's "Send my assistant"). Anything but a yes (off, signed out,
 * offline) is no.
 */
import { useEffect, useState } from 'react'

let probe: Promise<boolean> | null = null

/** For the tests: forget the answer. */
export function resetMeetingAgentProbe(): void {
  probe = null
}

export function useMeetingAgentOn(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    probe ??= fetch('/api/account/meeting-agent?probe=1')
      .then((res) => res.ok)
      .catch(() => false)
    void probe.then((yes) => {
      if (live) setOn(yes)
    })
    return () => {
      live = false
    }
  }, [])
  return on
}
