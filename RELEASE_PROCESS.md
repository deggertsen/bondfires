# Bondfires Release Process

## MANDATORY PRE-RELEASE AUDIT

**CRITICAL:** Never run `yarn release` without completing this audit first.

### 1. Navigation Integrity Check

```bash
# Check for hardcoded navigation paths that might be broken
grep -r "/(main)/" apps/mobile/ --include="*.tsx" --include="*.ts" -n

# Verify all paths match current file structure
find apps/mobile/app -name "*.tsx" | head -20
```

**What to verify:**
- All navigation paths exist in current file structure
- No references to moved/deleted screen files
- Deep linking paths work (notifications, auth redirects)
- Tab navigation and stack navigation properly configured

### 2. TypeScript Compilation

```bash
# Must pass 100% - no exceptions
yarn typecheck
```

**If using Expo typed routes:**
```bash
cd apps/mobile
npx expo start --clear  # Regenerates .expo/types/router.d.ts
# Stop server after route types regenerate
yarn typecheck  # Verify compilation passes
```

### 3. Build Health Check

```bash
# Verify import paths (especially after file moves)
find apps/mobile -name "*.tsx" -exec grep -l "convex/_generated" {} \;

# Check for correct relative import depths
grep -r "from.*convex/_generated" apps/mobile/app/ -n
```

**What to verify:**
- Import paths correct after any file restructuring
- No orphaned components or broken references
- Environment variables set in eas.json production profile
- Permissions properly configured in app.json

### 4. Configuration Audit

```bash
# Check app.json for hardcoded screen references
grep -r "screen\|route" apps/mobile/app.json apps/mobile/eas.json

# Verify deep linking configuration
grep -r "scheme\|link" apps/mobile/app.json
```

## Release Command

Only after all audit steps pass:

```bash
yarn release        # patch bump (most common)
yarn release:minor  # minor bump
yarn release:major  # major bump
```

## Post-Release Monitoring

1. **EAS Build Dashboard:** https://expo.dev/accounts/deggertsen/projects/bondfires/builds
2. **Android:** Internal testing track (completed status)
3. **iOS:** App Store Connect review process
4. **Version tracking:** Monitor for crashes/issues in first 24 hours

## Common Issues Caught by Audit

- **Navigation routing failures** after file restructuring
- **TypeScript compilation errors** from stale typed routes
- **Import path breaks** when components move
- **Deep linking failures** from hardcoded paths in configs
- **Environment variable misconfigurations**

## Emergency Hotfix Process

If critical issues found after release:

1. **Fix immediately** - don't wait
2. **Run full audit** on hotfix
3. **Version bump** (patch increment)
4. **Fast-track release** with `yarn release`
5. **Monitor deployment** closely

---

**Established:** 2026-02-19 after critical navigation routing bug reached users
**Last Updated:** 2026-02-19