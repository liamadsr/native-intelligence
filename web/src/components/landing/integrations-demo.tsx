'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  GitHubIcon,
  GoogleCalendarIcon,
  GmailIcon,
  OutlookIcon,
  OutlookCalendarIcon,
  SlackIcon,
  HubSpotIcon,
  ZapierIcon,
  AffinityIcon,
  AsanaIcon,
  JiraIcon,
  LinearIcon,
} from '@/components/brand-icons'

// ── MCP Tool categories ──

const MCP_CATEGORIES = [
  {
    name: 'Actions & Projects',
    description: 'Create, update, and manage actions and projects programmatically',
    tools: ['list_actions', 'create_action', 'update_action', 'complete_action', 'create_actions_batch', 'get_action_suggestions', 'list_labels', 'list_projects', 'get_project_context'],
  },
  {
    name: 'Documents & Knowledge',
    description: 'Read and search your workspace knowledge base',
    tools: ['list_documents', 'get_document', 'search', 'list_attachments', 'get_attachment_content'],
  },
  {
    name: 'Captures & Meetings',
    description: 'Access transcripts, decisions, and context from every conversation',
    tools: ['list_captures', 'get_capture_content', 'search', 'deep_search'],
  },
  {
    name: 'Contacts & People',
    description: 'Look up team members, contacts, and ownership',
    tools: ['search', 'get_contact'],
  },
  {
    name: 'GitHub',
    description: 'Link PRs to actions and track development progress',
    tools: ['link_pr', 'get_pr_status', 'list_linked_prs'],
  },
  {
    name: 'Workspaces',
    description: 'Navigate and switch between workspaces',
    tools: ['list_workspaces', 'get_workspace', 'set_workspace'],
  },
]

// ── Integration definitions (mirrors real integrations-view.tsx) ──

interface DemoIntegration {
  name: string
  description: string
  icon: React.ReactNode
  connected: boolean
  accounts?: string[]
  capabilities: string[]
}

const INTEGRATIONS: DemoIntegration[] = [
  {
    name: 'GitHub',
    description: 'Link repos, create PRs, sync development',
    icon: <GitHubIcon />,
    connected: true,
    accounts: ['acme/platform'],
    capabilities: ['Link repositories to projects', 'Create PRs from actions via MCP', 'Track PR status on actions'],
  },
  {
    name: 'Google Calendar',
    description: 'Sync events and link to captures',
    icon: <GoogleCalendarIcon />,
    connected: true,
    accounts: ['alex@acme.io'],
    capabilities: ['Auto-link meetings to captures', 'See upcoming meetings in dashboard', 'Calendar-aware scheduling'],
  },
  {
    name: 'Gmail',
    description: 'Unified email with AI-drafted replies',
    icon: <GmailIcon />,
    connected: true,
    accounts: ['alex@acme.io'],
    capabilities: ['Read and send emails from Native Intelligence', 'AI-drafted replies with meeting context', 'Email-triggered automations (coming soon)'],
  },
  {
    name: 'Outlook Calendar',
    description: 'Sync events and link to captures',
    icon: <OutlookCalendarIcon />,
    connected: true,
    accounts: ['alex@acme.onmicrosoft.com'],
    capabilities: ['Auto-link meetings to captures', 'See upcoming meetings in dashboard', 'Calendar-aware scheduling'],
  },
  {
    name: 'Outlook Mail',
    description: 'Unified email with AI-drafted replies',
    icon: <OutlookIcon />,
    connected: true,
    accounts: ['alex@acme.onmicrosoft.com'],
    capabilities: ['Read and send emails from Native Intelligence', 'AI-drafted replies with meeting context', 'Email-triggered automations (coming soon)'],
  },
  {
    name: 'Jira',
    description: 'Push actions and keep issue status in sync',
    icon: <JiraIcon />,
    connected: true,
    accounts: ['acme.atlassian.net'],
    capabilities: ['Push action items as Jira issues', 'Two-way status sync back to Native Intelligence', 'Choose project and issue type per push'],
  },
  {
    name: 'Linear',
    description: 'Push actions and keep issue state in sync',
    icon: <LinearIcon />,
    connected: true,
    accounts: ['Acme'],
    capabilities: ['Push action items as Linear issues', 'Two-way state sync back to Native Intelligence', 'Choose team and project per push'],
  },
  {
    name: 'Asana',
    description: 'Push actions and keep completion in sync',
    icon: <AsanaIcon />,
    connected: true,
    accounts: ['Acme Inc'],
    capabilities: ['Push action items as Asana tasks', 'Completion syncs back to Native Intelligence', 'Choose project and section per push'],
  },
  {
    name: 'HubSpot',
    description: 'CRM sync for contacts and companies',
    icon: <HubSpotIcon />,
    connected: true,
    accounts: ['Acme Inc'],
    capabilities: ['Sync contacts and companies', 'Auto-log meeting activity to CRM records', 'Match meeting attendees to contacts'],
  },
  {
    name: 'Slack',
    description: 'Notifications and channel sync',
    icon: <SlackIcon />,
    connected: false,
    capabilities: ['Post action updates to channels', 'Create actions from Slack messages', 'Meeting recap notifications'],
  },
  {
    name: 'Zapier',
    description: 'Connect to 6,000+ apps',
    icon: <ZapierIcon />,
    connected: false,
    capabilities: ['Trigger workflows from actions', 'Create actions from external events', 'Automate cross-tool processes'],
  },
  {
    name: 'Affinity',
    description: 'Relationship intelligence CRM',
    icon: <AffinityIcon />,
    connected: false,
    capabilities: ['Sync relationship data', 'Auto-log interactions from meetings', 'Enrich contact profiles'],
  },
]

// ── Integration card (mirrors real integration card UI) ──

function IntegrationCard({ integration }: { integration: DemoIntegration }) {
  return (
    <div className="rounded-xl border border-border">
      {/* Card header */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background shadow-sm border border-border/50">
            {integration.icon}
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-foreground">
                {integration.name}
              </span>
              {integration.connected ? (
                <span className="inline-flex items-center h-5 rounded-full border border-green-500/30 bg-green-500/10 px-1.5 text-[10px] font-medium text-green-500">
                  Available
                </span>
              ) : (
                <span className="inline-flex items-center h-5 rounded-full border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                  Coming soon
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {integration.description}
            </p>
          </div>
        </div>
      </div>

      {/* Capabilities */}
      <div className="border-t border-border px-4 py-3 space-y-1.5">
        {integration.capabilities.map((cap) => (
          <div key={cap} className="flex items-start gap-2">
            <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <span className="text-xs text-foreground/70">{cap}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── MCP section ──

function McpSection() {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
      <div className="flex items-start gap-4 mb-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-foreground/5 border border-border">
          <svg className="h-6 w-6 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
          </svg>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Model Context Protocol</h3>
          <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
            Any MCP-compatible agent — Claude, Codex, your own — gets full read/write access to your workspace.
            The same tools that power the built-in AI are available to external agents.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MCP_CATEGORIES.map((cat) => (
          <div key={cat.name} className="rounded-lg border border-border/60 p-4">
            <p className="text-sm font-medium text-foreground">{cat.name}</p>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{cat.description}</p>
            <div className="mt-3 flex flex-wrap gap-1">
              {cat.tools.map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

    </div>
  )
}

// ── Main component ──

export function IntegrationsDemo() {
  const [activeTab, setActiveTab] = useState<'integrations' | 'mcp'>('integrations')

  return (
    <div className="w-full">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 mb-8 p-1 rounded-full bg-muted/50 border border-border/40 w-fit mx-auto">
        <button
          onClick={() => setActiveTab('integrations')}
          className={cn(
            'px-4 py-2 rounded-full text-sm font-medium transition-all',
            activeTab === 'integrations'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Integrations
        </button>
        <button
          onClick={() => setActiveTab('mcp')}
          className={cn(
            'px-4 py-2 rounded-full text-sm font-medium transition-all',
            activeTab === 'mcp'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          MCP Protocol
        </button>
      </div>

      {activeTab === 'integrations' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((integration) => (
            <IntegrationCard
              key={integration.name}
              integration={integration}
            />
          ))}
        </div>
      ) : (
        <McpSection />
      )}
    </div>
  )
}
