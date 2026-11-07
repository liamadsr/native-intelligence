import { Avatar, AvatarImage, AvatarFallback } from '@dial8/ui'

export function WithImage() {
  return (
    <Avatar>
      <AvatarImage
        src="https://i.pravatar.cc/80?img=12"
        alt="Liam Alizadeh"
      />
      <AvatarFallback>LA</AvatarFallback>
    </Avatar>
  )
}

export function Fallback() {
  return (
    <Avatar>
      <AvatarFallback>SK</AvatarFallback>
    </Avatar>
  )
}

export function Row() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Avatar>
        <AvatarImage src="https://i.pravatar.cc/80?img=5" alt="Sarah" />
        <AvatarFallback>SK</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>MR</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>PD</AvatarFallback>
      </Avatar>
    </div>
  )
}
