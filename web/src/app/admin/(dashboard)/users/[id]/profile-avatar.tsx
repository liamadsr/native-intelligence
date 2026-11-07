'use client'

import { useState } from 'react'
import Image from 'next/image'
import { User } from 'lucide-react'

interface ProfileAvatarProps {
  avatarUrl: string | null
  displayName: string
  initials: string
}

export function ProfileAvatar({ avatarUrl, displayName, initials }: ProfileAvatarProps) {
  const [imgError, setImgError] = useState(false)
  const showAvatar = avatarUrl && !imgError

  return (
    <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      {showAvatar ? (
        <Image
          src={avatarUrl}
          alt={displayName}
          fill
          className="object-cover"
          unoptimized
          onError={() => setImgError(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-lg font-medium text-muted-foreground">
          {initials || <User className="h-6 w-6" />}
        </div>
      )}
    </div>
  )
}
