# Repository Intelligence Lite

Bondfires uses a small, deterministic repository-intelligence layer to make validation,
change impact, external boundaries, and releases easier to understand. It is intentionally
not a selective-CI system: the complete validation suite still runs for every pull request.

## Commands

```bash
yarn validate
yarn repo:impact
yarn repo:impact --base origin/main --head HEAD
yarn repo:impact --staged --format json
```

`yarn validate` performs typechecking, the complete unit-test suite, Convex generated-binding
freshness, repository-specific invariant checks, and a non-mutating Biome check.

`yarn repo:impact` is advisory. It maps a Git diff to checks, tests, builds, deployments, and
reviews, and explains the rule or external boundary behind every action. Unknown files broaden
the plan to full validation and require classification; they never silently produce an empty
plan.

## Model

[`repository-intelligence.json`](../repository-intelligence.json) is the reviewed source of
semantic facts that cannot be recovered reliably from imports alone:

- Change classification rules and their required actions
- External providers and cross-repository contracts
- Environment-variable ownership
- Release-order and compatibility boundaries
- Documentation that explains each boundary

Routine source reachability continues to come from TypeScript, Turbo, Convex code generation,
and Expo. The registry should contain only relationships that those tools cannot express.

When adding a tracked file in a new area, add or extend a rule. When adding a `process.env` key,
register it under the external boundary that owns it. `yarn check:repo` enforces both requirements.

## Trust model

The impact plan uses reviewed declarations and is safe to use for planning and explanation. It
does not authorize skipping pull-request validation, native release checks, deployment checks,
or compatibility review. If the repository grows enough for selective execution to become
valuable, impact plans should first run in shadow mode and be compared with complete CI results.

## Release evidence

`scripts/release.sh` runs `yarn validate` before changing `app.json`, committing, deploying, or
building. Once the version commit is created, it writes an ignored manifest under
`apps/mobile/build/` containing the Git revision, Convex target, requested platforms, artifacts,
submissions, timestamps, and final status. A failed release records its failure before exiting.
