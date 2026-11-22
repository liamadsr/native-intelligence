'use client'

import { useSyncExternalStore } from 'react'
import type { WorkbookController } from '@/lib/spreadsheets/controller'

/** Redraw when the workbook changes in any way (a selection too). Returns its version. */
export function useWorkbook(workbook: WorkbookController): number {
  return useSyncExternalStore(workbook.subscribe, workbook.getVersion, workbook.getVersion)
}
