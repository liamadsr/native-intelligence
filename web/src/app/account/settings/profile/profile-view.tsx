'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, LogOut, Building2, Check } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'

interface UserProfile {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  created_at: string
}

interface WorkspaceItem {
  id: string
  name: string
  slug: string
  logo_url: string | null
  plan: string
  role: string
}

function getInitials(name: string | null | undefined, email?: string): string {
  if (name) {
    return name
      .split(' ')
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
  return (email?.[0] || '?').toUpperCase()
}

export function ProfileView() {
  const router = useRouter()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([])
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Editable fields
  const [fullName, setFullName] = useState('')
  const [nameChanged, setNameChanged] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const nameTimeout = useRef<NodeJS.Timeout | null>(null)

  // Leave workspace dialog
  const [leaveWorkspace, setLeaveWorkspace] = useState<WorkspaceItem | null>(null)
  const [leavingId, setLeavingId] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [profileRes, workspacesRes, currentRes] = await Promise.all([
          fetch('/api/account/profile'),
          fetch('/api/account/workspace/list'),
          fetch('/api/account/workspace'),
        ])

        if (profileRes.ok) {
          const data = await profileRes.json()
          setProfile(data)
          setFullName(data.name || '')
        }

        if (workspacesRes.ok) {
          const data = await workspacesRes.json()
          setWorkspaces(data.workspaces || [])
        }

        if (currentRes.ok) {
          const data = await currentRes.json()
          setCurrentWorkspaceId(data.workspace?.id || null)
        }
      } catch {
        // silently fail
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function handleNameChange(value: string) {
    setFullName(value)
    setNameChanged(true)
    setNameSaved(false)
    // Debounce save
    if (nameTimeout.current) clearTimeout(nameTimeout.current)
    nameTimeout.current = setTimeout(() => saveName(value), 800)
  }

  async function saveName(name: string) {
    setSavingName(true)
    try {
      const res = await fetch('/api/account/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: name }),
      })
      if (!res.ok) throw new Error()
      setProfile((prev) => prev ? { ...prev, name } : prev)
      setNameChanged(false)
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
    } catch {
      toast.error('Failed to update name')
    } finally {
      setSavingName(false)
    }
  }

  async function handleLeaveWorkspace(workspace: WorkspaceItem) {
    setLeavingId(workspace.id)
    try {
      const res = await fetch('/api/account/workspace/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to leave workspace')
      }

      setWorkspaces((prev) => prev.filter((w) => w.id !== workspace.id))
      toast.success(`Left ${workspace.name}`)

      if (workspace.id === currentWorkspaceId) {
        router.push('/account')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to leave workspace')
    } finally {
      setLeavingId(null)
      setLeaveWorkspace(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div>
          <Skeleton className="mb-3 h-4 w-16" />
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between px-5 py-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-10 rounded-full" />
            </div>
            <div className="mx-5 border-t border-dashed border-border" />
            <div className="flex items-center justify-between px-5 py-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="mx-5 border-t border-dashed border-border" />
            <div className="flex items-center justify-between px-5 py-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-48" />
            </div>
          </div>
        </div>
        <div>
          <Skeleton className="mb-3 h-4 w-32" />
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-lg" />
                <div>
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="mt-1.5 h-3 w-16" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!profile) return null

  return (
    <div className="space-y-8">
      {/* Account info card */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Account</h3>
        <div className="rounded-xl border border-border bg-card">
          {/* Profile picture row */}
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium">Profile picture</p>
            </div>
            <Avatar className="h-10 w-10">
              <AvatarImage src={profile.avatar_url ?? undefined} />
              <AvatarFallback className="bg-emerald-600 text-sm font-medium text-white">
                {getInitials(profile.name, profile.email)}
              </AvatarFallback>
            </Avatar>
          </div>

          <div className="mx-5 border-t border-dashed border-border" />

          {/* Email row */}
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium">Email</p>
            </div>
            <p className="text-sm text-muted-foreground">{profile.email}</p>
          </div>

          <div className="mx-5 border-t border-dashed border-border" />

          {/* Full name row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-medium">Full name</p>
            </div>
            <div className="relative flex items-center gap-2">
              <Input
                value={fullName}
                onChange={(e) => handleNameChange(e.target.value)}
                onBlur={() => {
                  // Save immediately on blur if changed
                  if (nameChanged) {
                    if (nameTimeout.current) clearTimeout(nameTimeout.current)
                    saveName(fullName)
                  }
                }}
                placeholder="Your name"
                className="h-9 w-48 text-sm"
              />
              {savingName && (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
              {nameSaved && (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Workspace access */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Workspace access</h3>
        <div className="rounded-xl border border-border bg-card">
          {workspaces.length === 0 ? (
            <div className="px-5 py-4 text-sm text-muted-foreground">
              No workspaces found.
            </div>
          ) : (
            workspaces.map((ws, i) => (
              <div key={ws.id}>
                {i > 0 && <div className="mx-5 border-t border-dashed border-border" />}
                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {ws.logo_url ? (
                        <img
                          src={ws.logo_url}
                          alt={ws.name}
                          className="h-9 w-9 rounded-lg object-cover"
                        />
                      ) : (
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{ws.name}</p>
                        {ws.id === currentWorkspaceId && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Current</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground capitalize">{ws.role}</p>
                    </div>
                  </div>
                  {ws.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setLeaveWorkspace(ws)}
                      disabled={leavingId === ws.id}
                    >
                      {leavingId === ws.id ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <LogOut className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Leave
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Leave workspace confirmation */}
      <AlertDialog open={!!leaveWorkspace} onOpenChange={(open) => !open && setLeaveWorkspace(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave workspace</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave <strong>{leaveWorkspace?.name}</strong>? You will lose access to all data in this workspace. You&apos;ll need a new invite to rejoin. Your comments stay, and your drafts come back if you rejoin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => leaveWorkspace && handleLeaveWorkspace(leaveWorkspace)}
            >
              Leave workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
