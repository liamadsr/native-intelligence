import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  Badge,
} from '@native-intelligence/ui'

export function Default() {
  return (
    <Table style={{ width: '100%', maxWidth: 520 }}>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Assignee</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>ENG-142</TableCell>
          <TableCell>Extract presentational UI into a package</TableCell>
          <TableCell>Liam</TableCell>
          <TableCell><Badge>In progress</Badge></TableCell>
        </TableRow>
        <TableRow>
          <TableCell>ENG-138</TableCell>
          <TableCell>Ship onboarding guided tour</TableCell>
          <TableCell>Sarah</TableCell>
          <TableCell><Badge variant="secondary">In review</Badge></TableCell>
        </TableRow>
        <TableRow>
          <TableCell>ENG-131</TableCell>
          <TableCell>Fix waveform slowdown on long captures</TableCell>
          <TableCell>Marcus</TableCell>
          <TableCell><Badge variant="outline">Backlog</Badge></TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

export function WithFooter() {
  return (
    <Table style={{ width: '100%', maxWidth: 520 }}>
      <TableCaption>Actions completed in the current cycle.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Cycle</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead style={{ textAlign: 'right' }}>Completed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Cycle 14</TableCell>
          <TableCell>Engineering</TableCell>
          <TableCell style={{ textAlign: 'right' }}>9</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Cycle 14</TableCell>
          <TableCell>Design</TableCell>
          <TableCell style={{ textAlign: 'right' }}>4</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={2}>Total</TableCell>
          <TableCell style={{ textAlign: 'right' }}>13</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}
