'use client'

import { ChevronsUpDown, FlaskConical, Rocket } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useRouter } from 'next/navigation'
import { useState, useCallback } from 'react'
import type { AdminEnv } from '@/lib/admin'

const environments = [
  {
    value: 'development' as const,
    label: 'Development',
    description: 'Dev environment',
    icon: FlaskConical,
  },
  {
    value: 'production' as const,
    label: 'Production',
    description: 'Live environment',
    icon: Rocket,
  },
]

export function EnvSwitcher({ currentEnv }: { currentEnv: AdminEnv }) {
  const { isMobile } = useSidebar()
  const [env, setEnv] = useState<AdminEnv>(currentEnv)
  const [error, setError] = useState('')
  const router = useRouter()

  const activeEnv = environments.find((e) => e.value === env)!

  const handleSwitch = useCallback(async (newEnv: AdminEnv) => {
    if (newEnv === env) return
    setError('')

    const res = await fetch('/api/admin/switch-env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: newEnv }),
    })

    if (res.ok) {
      setEnv(newEnv)
      router.refresh()
    } else {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to switch environment')
    }
  }, [env, router])

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <activeEnv.icon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Dial8</span>
                <span className="truncate text-xs">{activeEnv.label}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Environments
            </DropdownMenuLabel>
            {environments.map((item) => (
              <DropdownMenuItem
                key={item.value}
                onSelect={() => handleSwitch(item.value)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <item.icon className="size-3.5 shrink-0" />
                </div>
                <div className="grid text-left text-sm leading-tight">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.description}</span>
                </div>
              </DropdownMenuItem>
            ))}
            {error && (
              <div className="px-2 py-1.5 text-xs text-destructive">{error}</div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
