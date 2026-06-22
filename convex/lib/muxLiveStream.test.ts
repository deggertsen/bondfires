import { describe, expect, it } from 'vitest'
import { classifyDisableStatus } from './muxLiveStream'

describe('classifyDisableStatus', () => {
  it("treats 404 as 'missing' so an already-deleted stream is reaped, not retried forever", () => {
    expect(classifyDisableStatus(404)).toBe('missing')
  })

  it("treats 2xx as a successful 'disabled'", () => {
    expect(classifyDisableStatus(200)).toBe('disabled')
    expect(classifyDisableStatus(204)).toBe('disabled')
  })

  it("treats other 4xx as 'error' (leave the row for the next cron tick)", () => {
    expect(classifyDisableStatus(400)).toBe('error')
    expect(classifyDisableStatus(401)).toBe('error')
    expect(classifyDisableStatus(429)).toBe('error')
  })

  it("treats 5xx as 'error' so transient Mux failures are retried, not reaped", () => {
    expect(classifyDisableStatus(500)).toBe('error')
    expect(classifyDisableStatus(503)).toBe('error')
  })
})
