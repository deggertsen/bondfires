import { describe, expect, it } from 'vitest'
import { canStartMaintenanceRun, isExpectedMaintenancePage } from './maintenanceRuns'

describe('maintenance run leases', () => {
  const now = 10_000
  const leaseMs = 1_000

  it('rejects overlap while a running lease is fresh', () => {
    expect(canStartMaintenanceRun({ status: 'running', updatedAt: 9_500 }, now, leaseMs)).toBe(
      false,
    )
  })

  it('allows terminal and expired runs to restart', () => {
    expect(canStartMaintenanceRun({ status: 'complete', updatedAt: now }, now, leaseMs)).toBe(true)
    expect(canStartMaintenanceRun({ status: 'failed', updatedAt: now }, now, leaseMs)).toBe(true)
    expect(canStartMaintenanceRun({ status: 'running', updatedAt: 8_999 }, now, leaseMs)).toBe(true)
  })

  it('accepts each cursor checkpoint once and rejects a retried stale page', () => {
    expect(isExpectedMaintenancePage(undefined, undefined)).toBe(true)
    expect(isExpectedMaintenancePage('next-page', undefined)).toBe(false)
    expect(isExpectedMaintenancePage('next-page', 'next-page')).toBe(true)
    expect(isExpectedMaintenancePage('final-page', 'next-page')).toBe(false)
  })
})
