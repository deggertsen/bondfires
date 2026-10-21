import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Provider IDs remain in historical records and old client contracts. Runtime
// code must never require provider secrets or return/fetch provider URLs again.
describe('retired media provider boundary', () => {
  it('has no Mux service URLs or credential reads in server and mobile runtime code', () => {
    const offenders = []
    for (const root of ['convex', 'apps/mobile', 'packages/app', 'packages/ui']) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', 'build', 'dist', '.expo', 'ios', 'android'].includes(entry.name))
            continue
          const path = resolve(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
            if (
              /(?:api|stream|image)\.mux\.com|process\.env\.MUX_/.test(readFileSync(path, 'utf8'))
            )
              offenders.push(path)
          }
        }
      }
      walk(resolve(root))
    }
    expect(offenders).toEqual([])
  })
})
