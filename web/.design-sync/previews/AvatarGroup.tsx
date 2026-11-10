import { AvatarGroup, Avatar, AvatarImage, AvatarFallback } from '@native-intelligence/ui'

export function Default() {
  return (
    <AvatarGroup max={4}>
      <Avatar>
        <AvatarImage src="https://i.pravatar.cc/80?img=12" alt="Liam" />
        <AvatarFallback>LA</AvatarFallback>
      </Avatar>
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
    </AvatarGroup>
  )
}

export function Overflow() {
  return (
    <AvatarGroup max={3}>
      <Avatar>
        <AvatarFallback>LA</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>SK</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>MR</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>PD</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>JT</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>RN</AvatarFallback>
      </Avatar>
    </AvatarGroup>
  )
}
