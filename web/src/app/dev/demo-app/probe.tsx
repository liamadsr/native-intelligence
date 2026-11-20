'use client'

import { AccountProviders } from '@/app/account/account-providers'
import { DashboardShell } from '@/app/account/(dashboard)/dashboard-shell'
import { DemoWorkspace } from '@/components/demo/demo-workspace'
import type { DemoSnapshot } from '@/lib/demo/demo-fetch'
import recording from '@/lib/demo/snapshots/app-startup.json'

const SNAPSHOT = recording as DemoSnapshot

export default function DemoAppProbe() {
  return (
    <div className="p-10">
      {/* A transform makes this the box the shell's fixed layers are placed in. */}
      <div className="relative h-[760px] w-[1240px] overflow-hidden rounded-2xl ring-1 ring-white/10 [transform:translateZ(0)]">
        <DemoWorkspace snapshot={SNAPSHOT} className="absolute inset-0">
          <AccountProviders>
            <DashboardShell userId="68dec777-e0cb-42c3-8ac0-b44dccbca33b" email="demo@native-intelligence.test" name="Jordan Ellery" avatarUrl={null} />
          </AccountProviders>
        </DemoWorkspace>
      </div>
    </div>
  )
}
