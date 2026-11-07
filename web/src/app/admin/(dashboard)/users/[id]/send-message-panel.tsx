'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { MessageSquare } from 'lucide-react'
import { SendMessageForm } from '@/components/admin/send-message-form'

export function SendMessagePanel({
  userId,
  userEmail,
}: {
  userId: string
  userEmail: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
          Send Message
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Send Message</SheetTitle>
        </SheetHeader>
        <div className="mt-6">
          <SendMessageForm
            userId={userId}
            userEmail={userEmail}
            onSuccess={() => setOpen(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
