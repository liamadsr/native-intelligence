'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { User } from 'lucide-react'
import { getInitials } from '@/lib/campaign-utils'

interface UserCellProps {
  id: string
  email: string
  avatarUrl: string | null
  linkToProfile?: boolean
}

export function UserCell({ id, email, avatarUrl, linkToProfile = true }: UserCellProps) {
  const initials = getInitials(email)
  const [imgError, setImgError] = useState(false)

  const showAvatar = avatarUrl && !imgError

  const content = (
    <div className="flex items-center gap-2.5">
      <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full bg-muted">
        {showAvatar ? (
          <Image
            src={avatarUrl}
            alt=""
            fill
            className="object-cover"
            unoptimized
            onError={() => setImgError(true)}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[10px] font-medium text-muted-foreground">
            {initials || <User className="h-3 w-3" />}
          </span>
        )}
      </div>
      <span className="font-medium text-foreground truncate">
        {email}
      </span>
    </div>
  )

  if (linkToProfile) {
    return (
      <Link href={`/admin/users/${id}`} className="flex items-center gap-2.5 hover:underline">
        {content}
      </Link>
    )
  }

  return content
}
