import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from '@dial8/ui'

export function Closed() {
  return (
    <div style={{ width: '100%', maxWidth: 240 }}>
      <Select defaultValue="in-progress">
        <SelectTrigger>
          <SelectValue placeholder="Select status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="todo">Todo</SelectItem>
          <SelectItem value="in-progress">In progress</SelectItem>
          <SelectItem value="in-review">In review</SelectItem>
          <SelectItem value="done">Done</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function Open() {
  return (
    <div style={{ width: '100%', maxWidth: 240, minHeight: 260 }}>
      <Select defaultValue="liam" open>
        <SelectTrigger>
          <SelectValue placeholder="Assign to" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Team</SelectLabel>
            <SelectItem value="liam">Liam</SelectItem>
            <SelectItem value="ana">Ana</SelectItem>
            <SelectItem value="marcus">Marcus</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="unassigned">Unassigned</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
