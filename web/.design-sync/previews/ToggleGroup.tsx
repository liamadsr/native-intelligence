import { ToggleGroup, ToggleGroupItem } from '@dial8/ui'

export function SingleSelect() {
  return (
    <ToggleGroup type="single" defaultValue="list" variant="outline">
      <ToggleGroupItem value="list">List</ToggleGroupItem>
      <ToggleGroupItem value="board">Board</ToggleGroupItem>
      <ToggleGroupItem value="calendar">Calendar</ToggleGroupItem>
    </ToggleGroup>
  )
}

export function MultiSelect() {
  return (
    <ToggleGroup type="multiple" defaultValue={['actions', 'decisions']} variant="outline">
      <ToggleGroupItem value="actions">Actions</ToggleGroupItem>
      <ToggleGroupItem value="decisions">Decisions</ToggleGroupItem>
      <ToggleGroupItem value="claims">Claims</ToggleGroupItem>
    </ToggleGroup>
  )
}
