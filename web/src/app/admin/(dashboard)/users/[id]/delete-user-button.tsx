'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'

export function DeleteUserButton({
  userId,
  userEmail,
}: {
  userId: string
  userEmail: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    if (!confirm(`Are you sure you want to delete ${userEmail}? This will remove all their data including devices, purchases, and workflows.`)) {
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`/api/admin/users/${userId}/delete`, {
        method: 'DELETE',
      })

      if (!res.ok) {
        const data = await res.json()
        alert(data.error ?? 'Failed to delete user')
        return
      }

      router.push('/admin/users')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDelete}
      disabled={loading}
      className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
    >
      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
      {loading ? 'Deleting...' : 'Delete'}
    </Button>
  )
}
