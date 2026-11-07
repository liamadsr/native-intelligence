'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Gift } from 'lucide-react'

const BYOK_FEATURES = ['speech_to_text', 'text_to_speech', 'ai_chat']

export function GrantPurchase({
  userId,
  features,
}: {
  userId: string
  features: { id: string; display_name: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [grantType, setGrantType] = useState<'byok_bundle' | 'individual'>('byok_bundle')
  const [featureId, setFeatureId] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGrant() {
    setLoading(true)
    setError(null)

    try {
      const featureIds = grantType === 'byok_bundle' ? BYOK_FEATURES : [featureId]

      if (grantType === 'individual' && !featureId) {
        setError('Please select a feature')
        setLoading(false)
        return
      }

      for (const fid of featureIds) {
        const res = await fetch(`/api/admin/users/${userId}/grant-purchase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feature_id: fid,
            purchase_option: grantType === 'byok_bundle' ? 'byok_unlock' : undefined,
            reason: reason.trim() || undefined,
          }),
        })

        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error ?? `Failed to grant ${fid}`)
        }
      }

      setOpen(false)
      setFeatureId('')
      setReason('')
      setGrantType('byok_bundle')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Gift className="mr-1.5 h-3.5 w-3.5" />
          Grant Access
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant Feature Access</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Create a complimentary purchase record for this user. No payment will be charged.
        </p>
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label>Grant Type</Label>
            <Select value={grantType} onValueChange={(v) => setGrantType(v as 'byok_bundle' | 'individual')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="byok_bundle">BYOK Bundle (all features)</SelectItem>
                <SelectItem value="individual">Individual Feature</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {grantType === 'individual' && (
            <div className="space-y-2">
              <Label>Feature</Label>
              <Select value={featureId} onValueChange={setFeatureId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a feature..." />
                </SelectTrigger>
                <SelectContent>
                  {features.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {grantType === 'byok_bundle' && (
            <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              Grants all features (Speech-to-Text, Text-to-Speech, AI Chat) as a BYOK unlock.
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="grant-reason">Reason (optional)</Label>
            <Textarea
              id="grant-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Complimentary upgrade, beta tester reward..."
              rows={2}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button onClick={handleGrant} disabled={loading} className="w-full">
            {loading ? 'Granting...' : grantType === 'byok_bundle' ? 'Grant BYOK Bundle' : 'Grant Access'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
