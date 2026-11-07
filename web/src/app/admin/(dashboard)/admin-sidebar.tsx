'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Mail, Monitor, Cpu, Layers, FileText, Lightbulb, UserPlus, Gauge, FlaskConical } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { EnvSwitcher } from './env-switcher'
import { NavUser } from './nav-user'
import type { AdminEnv } from '@/lib/admin'

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/users', label: 'Users', icon: Monitor },
  { href: '/admin/invites', label: 'Invites', icon: UserPlus },
  { href: '/admin/ai-usage', label: 'AI Usage', icon: Cpu },
  { href: '/admin/decisions', label: 'Jev Performance', icon: Gauge },
  { href: '/admin/evals', label: 'Evals', icon: FlaskConical },
  { href: '/admin/ai-plans', label: 'AI Plans', icon: Layers },
  { href: '/admin/feature-requests', label: 'Feature Requests', icon: Lightbulb },
]

export function AdminSidebar({
  email,
  adminEnv,
  campaigns = [],
}: {
  email: string
  adminEnv: AdminEnv
  campaigns?: { id: string; title: string }[]
}) {
  const pathname = usePathname()
  const isCampaignsActive = pathname.startsWith('/admin/campaigns')

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <EnvSwitcher currentEnv={adminEnv} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.href === '/admin'
                        ? pathname === '/admin'
                        : pathname.startsWith(item.href)
                    }
                    tooltip={item.label}
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {/* Campaigns with nested sub-pages */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isCampaignsActive}
                  tooltip="Campaigns"
                >
                  <Link href="/admin/campaigns">
                    <Mail />
                    <span>Campaigns</span>
                  </Link>
                </SidebarMenuButton>
                {isCampaignsActive && (
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        asChild
                        isActive={pathname === '/admin/campaigns/templates'}
                        size="sm"
                      >
                        <Link href="/admin/campaigns/templates">
                          <FileText className="h-3.5 w-3.5" />
                          <span>Templates</span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    {campaigns.map((c) => {
                      const href = `/admin/campaigns/${c.id}`
                      return (
                        <SidebarMenuSubItem key={c.id}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={pathname.startsWith(href)}
                            size="sm"
                          >
                            <Link href={href}>
                              <span className="truncate">{c.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )
                    })}
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavUser email={email} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
