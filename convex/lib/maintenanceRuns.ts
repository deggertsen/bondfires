export type MaintenanceRunStatus = 'running' | 'complete' | 'failed'

/** A fresh running lease prevents cron overlap; terminal or stale runs may restart. */
export function canStartMaintenanceRun(
  existing: { status: MaintenanceRunStatus; updatedAt: number } | null,
  now: number,
  leaseMs: number,
): boolean {
  return !existing || existing.status !== 'running' || existing.updatedAt < now - leaseMs
}

/**
 * A page checkpoint is accepted exactly once. The stored cursor identifies
 * the page the durable action is currently allowed to process.
 */
export function isExpectedMaintenancePage(
  storedCursor: string | undefined,
  processedCursor: string | undefined,
): boolean {
  return storedCursor === processedCursor
}
