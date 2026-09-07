import { describe, expect, it } from 'vitest'
import { scrubMonitoringError } from '../lib/monitoringPrivacy'

describe('Crashlytics JavaScript privacy', () => {
  it('scrubs text and copies no arbitrary error properties', () => {
    const error = Object.assign(
      new Error('person@example.com born 2008-08-31 at https://video.example/secret'),
      { cause: { token: 'secret' }, userId: 'private' },
    )
    error.stack =
      'Error: secret\n    at play (https://bundle.example/path/index.bundle?token=secret:1:456)\n    at start (/Users/person/project/index.bundle:1:200)\n    at anonymous (address at index.android.bundle:1:789)'
    const result = scrubMonitoringError(error)
    expect(result.message).not.toMatch(/person@example|2008-08-31|video.example/)
    expect(result.stack).not.toMatch(/secret|bundle.example|Users|project/)
    expect(result.stack).toContain('index.bundle:1:456')
    expect(result.stack).toContain('index.android.bundle:1:789')
    expect(result.cause).toBeUndefined()
    expect(Object.keys(result)).not.toContain('userId')
    expect(error.message).toContain('person@example.com')
  })
  it('does not serialize arbitrary thrown objects', () => {
    expect(scrubMonitoringError({ password: 'secret' }).message).toBe('Non-Error exception')
  })
  it('bounds error payloads', () => {
    const error = new Error('x'.repeat(5000))
    error.stack = Array(100).fill('at f (index.bundle:1:2)').join('\n')
    const result = scrubMonitoringError(error)
    expect(result.message.length).toBe(1000)
    expect(result.stack?.split('\n')).toHaveLength(31)
  })
})
