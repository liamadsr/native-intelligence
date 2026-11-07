/**
 * What `enrich_contact` tells the model, in one place: the registry entry
 * (what the eve agents advertise and `search_tools` finds) and the tool's own
 * definition (what the MCP bridge and the in-process tool sets advertise) both
 * use it, so the spend rule reads the same wherever the tool is offered.
 *
 * Import-free on purpose, like src/lib/browser-agent/task-instructions.ts: the
 * tool registry is plain data the client bundle reads.
 *
 * Within OpenAI's 1024 characters (tool-guides.test.ts); there is no
 * TOOL_GUIDES note for this tool.
 */
export const ENRICH_CONTACT_DESCRIPTION =
  'Look up one contact on the web and pull details onto their card (job title, department, LinkedIn, a short bio in their notes), filling only empty fields: what the Enrich button on the contact page does. ' +
  'Nothing is enriched on its own: each call runs one paid web search, so call it ONLY after the person said yes to enriching this contact in this conversation (they asked, or said yes to an offer such as the meeting prep\'s "pull details on <name>?"), with confirmed_with_user: true. Without that yes it refuses and runs nothing. Never decide it for them, and don\'t quote a price. ' +
  'One contact per call: if they said yes to several, one call each. ' +
  'It waits up to about 45 seconds and returns the fields it filled. If it comes back still running, what it finds lands on their card by itself: do not call it again. ' +
  'An already-enriched contact may be refreshed, but that rarely finds anything new, so say so when you offer. ENRICHMENT_PERMANENTLY_FAILED: this contact cannot be enriched; do not retry.'
