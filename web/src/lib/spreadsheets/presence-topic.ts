/** The Realtime topic of a spreadsheet's presence room. Migration 689's policies read the id back out of it. */
export function spreadsheetPresenceTopic(spreadsheetId: string): string {
  return `spreadsheet-presence:${spreadsheetId.toLowerCase()}`
}
