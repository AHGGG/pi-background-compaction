# Real-engine regression tests

Run from this repository:

```sh
npm run test:integration -- /absolute/path/to/pi-extensions
```

The supplied checkout must contain `packages/pi-codex-compact/src/prepared-compaction-protocol.ts`
(version 1). An absent or incompatible checkout is an error, not a skipped suite.
The runner supplies test-only aliases to that checkout's engine and mock-Pi support.
Production source never imports those aliases or another extension's private files.
Set `REQUIRE_PREPARATION_DIAGNOSTICS=1` when checking a new diagnostics-capable engine;
this makes absence of the optional capability fail instead of testing the older-engine path.
Set `REQUIRE_CONSUMER_FAILURE_REPORTING=1` for the current reporting contract; it requires
exactly one automatic full report, inside the companion's final failure warning. Older engines
that provide diagnostics but ignore `failureReportOwner` may also print an earlier core report;
the companion still includes the details so copying its failure is sufficient. Engines without
diagnostics produce an explicit unavailable marker.

These tests load the real core and background factories together through Pi's event bus.
Providers and credentials are fixtures; no external model request is made. The native-runtime
suite uses Pi's real session runner with a local mocked provider transport.

| Suite | Preserved coverage |
| --- | --- |
| `async-compaction` | Preparation, foreground reuse, stale snapshots, authentication, suffix retention, cancellation |
| `async-memory` | Borrowed-history safety, active-input isolation, prefix fingerprints, exact-boundary mutation checks |
| `async-apply-latency` | Bounded validation, private-data-free timing, reentrant callbacks, commit-only success |
| `async-diagnostics` | Safe failure reasons, budget rejection, ordered binding diagnostics, logging controls |
| `async-failure-pause` | Failure versus invalidation, explicit resume, late callbacks, pause lifecycle |
| `auto-apply` | Idle input/settlement claims, cancellation, retry suppression, no extra inference |
| `midrun-auto-apply` | Serialized tool-batch drafts, exact ancestry, retained ready work, commit confirmation |
| `ready-after-retry` | Model-error deferral, successful retry, manual reuse, abort and one-attempt guards |
| `async-auto-apply-native` | Actual Pi session input, settlement and successful model-retry application without aborting active work |
| `engine-contract` | Both installation orders and core-alone foreground behavior |

The first eight suites were extracted from `pi-codex-compact` at commit
`16a0de7050b4746c653bde151fc80d1c3e35483a`. Direct calls to the former background job helpers
were replaced with the documented engine capture/start/adopt/draft protocol.
