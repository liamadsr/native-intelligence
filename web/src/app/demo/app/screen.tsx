'use client'

import { useSearchParams } from 'next/navigation'
import { DemoApp } from '@/components/demo/demo-app'
import { DEMO_SCREENS, type DemoScreen } from '@/components/demo/demo-screens'

export default function DemoAppScreen() {
  const asked = useSearchParams().get('screen')
  const screen = (DEMO_SCREENS as readonly string[]).includes(asked ?? '') ? (asked as DemoScreen) : DEMO_SCREENS[0]
  return <DemoApp screen={screen} />
}
