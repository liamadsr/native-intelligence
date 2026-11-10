import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@native-intelligence/ui'

export function Single() {
  return (
    <Accordion type="single" defaultValue="actions" collapsible style={{ width: '100%', maxWidth: 380 }}>
      <AccordionItem value="actions">
        <AccordionTrigger>Action items (3)</AccordionTrigger>
        <AccordionContent>
          Ship onboarding tour · Draft Q3 roadmap · Follow up with Acme on pricing.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="decisions">
        <AccordionTrigger>Decisions (1)</AccordionTrigger>
        <AccordionContent>
          Team agreed to cut the legacy capture flow before the cycle ends.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="attendees">
        <AccordionTrigger>Attendees (4)</AccordionTrigger>
        <AccordionContent>Liam, Sarah, Marcus, and Priya joined the sync.</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

export function Multiple() {
  return (
    <Accordion
      type="multiple"
      defaultValue={['eng', 'design']}
      style={{ width: '100%', maxWidth: 380 }}
    >
      <AccordionItem value="eng">
        <AccordionTrigger>Engineering</AccordionTrigger>
        <AccordionContent>ENG-142 in progress · ENG-138 in review.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="design">
        <AccordionTrigger>Design</AccordionTrigger>
        <AccordionContent>DES-21 ready for handoff this cycle.</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
