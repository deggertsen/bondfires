import { describe, expect, it } from 'vitest'
import { classifyDisableMuxLiveStreamStatus } from '../videos'

describe('classifyDisableMuxLiveStreamStatus', () => {
  it("treats 404 as 'missing' so an already-deleted stream is reaped, not retried forever", () => {
    expect(classifyDisableMuxLiveStreamStatus(404)).toBe('missing')
  })

  it("treats 2xx as a successful 'disabled'", () => {
    expect(classifyDisableMuxLiveStreamStatus(200)).toBe('disabled')
    expect(classifyDisableMuxLiveStreamStatus(204)).toBe('disabled')
  })

  it("treats other 4xx as 'error' (leave the row for the next cron tick)", () => {
    expect(classifyDisableMuxLiveStreamStatus(400)).toBe('error')
    expect(classifyDisableMuxLiveStreamStatus(401)).toBe('error')
    expect(classifyDisableMuxLiveStreamStatus(429)).toBe('error')
  })

  it("treats 5xx as 'error' so transient Mux failures are retried, not reaped", () => {
    expect(classifyDisableMuxLiveStreamStatus(500)).toBe('error')
    expect(classifyDisableMuxLiveStreamStatus(503)).toBe('error')
  })
})
