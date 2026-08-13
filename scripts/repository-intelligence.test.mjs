import { describe, expect, it } from 'vitest'
import {
  createImpactPlan,
  globToRegExp,
  loadIntelligenceConfig,
} from './lib/repository-intelligence.mjs'

describe('repository intelligence', () => {
  it('matches globstars at the repository root and below it', () => {
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true)
    expect(globToRegExp('**/*.md').test('docs/plan.md')).toBe(true)
    expect(globToRegExp('apps/mobile/**/*.ts').test('apps/mobile/lib/routes.ts')).toBe(true)
    expect(globToRegExp('apps/mobile/**/*.ts').test('convex/schema.ts')).toBe(false)
  })

  it('explains schema changes through rules and external boundaries', () => {
    const plan = createImpactPlan(['convex/schema.ts'], loadIntelligenceConfig())

    expect(plan.actions.map((action) => action.id)).toContain('convex-codegen-check')
    expect(plan.actions.map((action) => action.id)).toContain('client-compatibility-review')
    expect(plan.affectedBoundaries.map((boundary) => boundary.id)).toContain('convex-mobile-api')
    expect(plan.unknownFiles).toEqual([])
  })

  it('keeps documentation-only plans narrow', () => {
    const plan = createImpactPlan(['docs/example.md'], loadIntelligenceConfig())

    expect(plan.actions.map((action) => action.id)).toEqual(['documentation-review'])
  })

  it('does not treat generated-only corrections as backend deployments', () => {
    const plan = createImpactPlan(['convex/_generated/api.d.ts'], loadIntelligenceConfig())

    expect(plan.actions.map((action) => action.id)).toEqual(['convex-codegen-check', 'validate'])
    expect(plan.affectedBoundaries).toEqual([])
  })

  it('broadens unknown changes conservatively', () => {
    const plan = createImpactPlan(['unexpected/new-system.file'], loadIntelligenceConfig())

    expect(plan.unknownFiles).toEqual(['unexpected/new-system.file'])
    expect(plan.actions.map((action) => action.id)).toContain('validate')
    expect(plan.actions.map((action) => action.id)).toContain('unknown-change-review')
  })
})
