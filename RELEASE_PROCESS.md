# Bondfires Release Process

## MANDATORY PRE-RELEASE AUDIT

**CRITICAL:** Never run `yarn release` without completing this audit first.

### 1. Navigation Integrity Check

All navigation MUST go through the centralized, type-safe route registry at
`apps/mobile/lib/routes.ts`. That module builds every target as a typed
`Href`, so a moved/renamed screen becomes a **compile error in one file**
(caught by `yarn typecheck`) instead of a runtime crash for users.

```bash
# 1. No unsafe route casts in source (these defeat typed routes). Expect ZERO hits.
grep -rn "as RelativePathString\|as ExternalPathString" \
  apps/mobile/app apps/mobile/components apps/mobile/lib

# 2. No raw path strings passed to the router or <Redirect>. Expect ZERO hits
#    outside apps/mobile/lib/routes.ts (the only place literals are allowed).
grep -rn "router\.\(push\|replace\)( *['\"\`]/\|href=['\"\`]/\|href={\`/" apps/mobile/app apps/mobile/components

# 3. Verify route files still match the registry's pathnames.
find apps/mobile/app -name "*.tsx" | sort
```

**What to verify:**
- Checks 1 and 2 return no results (all navigation flows through `routes.*`).
- All `routes.*` pathnames in `lib/routes.ts` resolve against the current file
  tree (guaranteed by `yarn typecheck` once route types are regenerated — see §2).
- Untrusted navigation (push notifications, deep links) goes through
  `resolveExternalRoute` / `resolveAuthRedirect`, never a raw cast.
- Deep linking paths work (notifications, auth redirects).
- Tab navigation and stack navigation properly configured.

> **Why this matters:** the navigation bug that created this document came from a
> hardcoded path surviving a file move. Centralized typed routes turn that whole
> class of bug into a failed `yarn typecheck`.

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