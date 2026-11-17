# Charlie StoreOS Security Agent — End-to-End Playwright Automation Suite

Portable, self-contained TypeScript + Playwright WebSocket E2E test suite for the **Charlie StoreOS Security Agent** specification. Against the built-in mock agent it exercises every endpoint, error code, UI guidance translation, and resilience scenario in the specification. Against a real agent only a subset runs; see [What this suite covers: mock vs. live](#what-this-suite-covers-mock-vs-live).

## Documentation and traceability
* [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md) maps every requirement in the four source documents to an automated test (`T01`-`T37`, or a tagged ID such as `[BAR-05]`) or to a written manual test case, marks each automated requirement as **mock-only** or **mock + live**, and lists the places where the source documents disagree.
* `tests/security-agent.e2e.spec.ts` holds the core end-to-end scenarios; `tests/spec-coverage.e2e.spec.ts` holds the requirement-tagged specification tests.
* [`README-LIVE.md`](README-LIVE.md) is the stand-alone guide for running the live suites against a real agent.

## What this suite covers: mock vs. live

The suite runs in three modes, one Playwright project each, and the coverage differs between them. Every test carries exactly one mode tag, and each project selects tests by tag:

| Project | Command | Tests that run | Tags selected |
|---|---|---|---|
| `mock` (default) | `npm test` or `npm run test:mock` | 130 | all |
| `live` | `AGENT_WS_URL=ws://<ip>:8080 npm run test:live` | 27 | `@live` |
| `live-mutating` | `AGENT_WS_URL=ws://<ip>:8080 npm run test:live:mutating` | 44 | `@live`, `@live-mutating` |

The remaining 86 tests are tagged `@mock-only`. A live run lists only the tests it can run; nothing is reported as skipped. A test that runs in a mode its tag does not allow, or a test without a mode tag, fails with an explanation (see `tests/fixtures.ts`).

**Mock mode** runs the tests against `mock-server/server.ts`, a stand-in for the agent. It checks that the suite's reading of the specification is consistent and that the test client works. A passing mock run does **not** show that the real agent behaves this way. 86 tests rely on mock-only controls (simulated failures and state inspection) and cannot run against a real agent.

**Live mode** is the evidence about the actual agent, and today it covers a subset of the specification. Treat the live counts above as the true measure of agent coverage. Prerequisites, test accounts and side effects of the live suites are in [`README-LIVE.md`](README-LIVE.md).

The requirement-by-requirement mapping is in [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md). Each automated requirement there is marked **mock-only** or **mock + live**.

## What's Covered (130 automated tests against the mock agent)
Every area below is exercised against the mock agent. Most of it is **mock-only**; see [What this suite covers: mock vs. live](#what-this-suite-covers-mock-vs-live) for what also runs against a real agent.

- **Protocol & Audit Logging**: JSON envelope (`correlationID`, `path`, `statusCode`, `timeTaken`, `processingMs`), `/healthCheck` exclusion from `SecurityLog`, and failure routing to `ErrorLog`.
- **All 15 WebSocket Endpoints**:
  - `/healthCheck` & `/healthStatusUpdate`
  - `/authenticate/credentials` (regular & temp employee, `isLogin`, IDP outage `6503`)
  - `/register/biometric` (`loginCorrelationID` verification, `consentVersion`, `state`, `9510`/`6500`/`6501`/`1511`)
  - `/authenticate/biometric` (1:1 & 1:N, passive `uiDelay` intermediate `1500` frame, `liveness` / `liveness_reco`, vision guidance translations, `1504`/`1505`/`1506`)
  - `/register/barcode` & `/authenticate/barcode` (13-char `BI...` format, PIN enforcement, case-insensitivity, `employeeId` mismatch `6524`, expiry `6522`)
  - `/register/tempEmployee`
  - `/userinfo` (`assignStore: true` store/workstation sync)
  - `/user/token` (`PING` & `SM` token retrieval and auto-refresh)
  - `/notify/bio-camera` (`ON`/`OFF` hardware state & `9520` guard)
  - `/setConfiguration` (dynamic updates & self-restart on critical keys)
  - `/terminate/transaction` (`9503` invalid correlationID validation, cancelling an in-flight transaction)
  - `/uploadLogs` (`error`, `info`, `debug`, `all` delta sync)
  - `/forgetMe` (cache wipe + UUID revocation)
- **Advanced Edge & Resilience Modes**:
  - **Digital Twin Detection (`1512`)**: 1:N challenge, unverified 1:1 challenge, and clearance after secondary credential auth.
  - **Headless / Non-Graphical Mode (`9500`)**: Blocks UI endpoints while keeping credential & PIN-barcode auth alive.
  - **Database Failure Fallback (`9524` -> `Memory` Mode)**: Verifies automatic switch from `DB` to `Memory` mode.
  - **Offline Temp Registration & Revalidation**: Local offline enrollment/auth followed by online `storeIdMismatch: true` (`1509`).

## Test Organisation and Tags
Every specification test carries a requirement tag in its title so results can be traced back to the source documents (full mapping in [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md)):

| Tag | Area | Tag | Area |
|---|---|---|---|
| `PRO` | Protocol envelope | `TWN` | Digital twin (1512) |
| `LOG` | SecurityLog / ErrorLog rules | `BAR` | Barcode register / authenticate |
| `HEA` | `/healthCheck` | `TMP` | Temp employee and revalidation |
| `HSU` | `/healthStatusUpdate` heartbeat and events | `TRM` | `/terminate/transaction` |
| `RGB` / `UI` | Biometric register / authenticate | `USR` | `/userinfo` |
| `CRD` | Credentials | `FGT` | `/forgetMe` |
| `BIO` | Biometric edge cases | `UPL` | `/uploadLogs` |
| `UIG` | 20-row CVS feedback translation table | `CFG` | `/setConfiguration` |
| `OFF` | Offline mode | `TOK` | `/user/token` |
| `DBF` | Database fallback (9524) | `CAM` / `HDL` | Camera notify / headless mode |

Run a single area with `npm test -- -g "BAR-"`. Items an API test cannot prove (installer, systemd, log rollover, camera hardware, outgoing headers) are written as manual cases `MTC-01`..`MTC-23` in the traceability document.

## Project Layout
```
mock-server/server.ts                 Spec-compliant mock agent + HTTP control plane (/__test/*)
tests/ws-client.ts                    WebSocket client and helpers (waitForFrame, uniqueId, control)
tests/fixtures.ts                     `test` with the mode guard (fails tests run in the wrong mode)
tests/security-agent.e2e.spec.ts      Core end-to-end scenarios (T01-T37, with gaps for retired IDs)
tests/spec-coverage.e2e.spec.ts       Requirement-tagged specification tests
docs/REQUIREMENTS_TRACEABILITY.md     Requirement -> test matrix, manual cases, open questions
playwright.config.ts                  Config: mock / live / live-mutating projects (starts the mock in mock mode)
README-LIVE.md                        Client guide for running the live suites
.github/workflows/e2e.yml             CI: type-check, run suite, upload report
```

## Configuration
| Variable | Default | Purpose |
|---|---|---|
| `AGENT_WS_URL` | `ws://127.0.0.1:8080` | Agent WebSocket URL; required by the `live` and `live-mutating` projects |
| `USE_MOCK_AGENT` | unset | Alias: `false` selects the `live` project |
| `ALLOW_LIVE_MUTATIONS` | unset | Alias: with `USE_MOCK_AGENT=false`, `true` selects the `live-mutating` project |

`--project` and the aliases must agree; a conflicting combination, or more than one `--project`, stops the run with an error.
| `HEARTBEAT_MS` | `60000` (`400` in tests) | Mock heartbeat interval for `/healthStatusUpdate` |

## Continuous Integration
GitHub Actions (`.github/workflows/e2e.yml`) installs with `npm ci`, type-checks with `tsc --noEmit`, runs the suite against the mock agent (once, and in a second job twice in a row with `--repeat-each=2` and no retries, to catch order-dependent tests), and uploads `playwright-report/` and `test-results/` as artifacts. It uses read-only permissions and a 10-minute timeout.

## Quick Start (Anyone Can Run Out of the Box)

### 1. Run Against the Built-in Spec-Compliant Mock Agent (Zero External Dependencies)
```bash
npm install
npm test
```
Playwright automatically boots the local WebSocket mock agent on `ws://127.0.0.1:8080`, executes all 130 tests, and shuts it down.

### 2. Run Against a Live StoreOS Ubuntu 22 Security Agent
```bash
AGENT_WS_URL=ws://<storeos-terminal-ip>:8080 npm run test:live
```
Runs the 27 `@live` tests, which create and delete no records (a few update login state, store assignment or trigger a log upload; see [`README-LIVE.md`](README-LIVE.md)).

Tests that create, change or delete data (temp registration, face enrollment, barcode creation, `/forgetMe`) are tagged `@live-mutating` and run only in the `live-mutating` project. Use it on a disposable test terminal only:
```bash
AGENT_WS_URL=ws://<ip>:8080 npm run test:live:mutating
```
On Windows PowerShell, set the variable first (`$env:AGENT_WS_URL='ws://<ip>:8080'`) and then run the npm script. The older form `USE_MOCK_AGENT=false [ALLOW_LIVE_MUTATIONS=true] npm test` still works.
