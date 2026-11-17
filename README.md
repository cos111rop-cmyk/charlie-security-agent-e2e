# Charlie StoreOS Security Agent — End-to-End Playwright Automation Suite

Portable, self-contained TypeScript + Playwright WebSocket E2E test suite for the **Charlie StoreOS Security Agent** specification. Against the built-in mock agent it exercises every endpoint, error code, UI guidance translation, and resilience scenario in the specification. Against a real agent only a subset runs; see [What this suite covers: mock vs. live](#what-this-suite-covers-mock-vs-live).

## Documentation and traceability
* [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md) maps every requirement in the four source documents to an automated test (`T01`-`T37`, or a tagged ID such as `[BAR-05]`) or to a written manual test case, marks each automated requirement as **mock-only** or **mock + live**, and lists the places where the source documents disagree.
* `tests/security-agent.e2e.spec.ts` holds the core end-to-end scenarios; `tests/spec-coverage.e2e.spec.ts` holds the requirement-tagged specification tests.

## What this suite covers: mock vs. live

The suite runs in two modes, and the coverage differs between them.

| Mode | Command | Tests that run |
|---|---|---|
| Mock (default) | `npm test` | 126 of 126 |
| Live, read-only | `USE_MOCK_AGENT=false npm test` | 26 (the other 100 are skipped) |
| Live, with data-changing tests | `USE_MOCK_AGENT=false ALLOW_LIVE_MUTATIONS=true npm test` | 43 (the other 83 are skipped) |

**Mock mode** runs the tests against `mock-server/server.ts`, a stand-in for the agent. It checks that the suite's reading of the specification is consistent and that the test client works. A passing mock run does **not** show that the real agent behaves this way. 100 tests rely on mock-only controls (simulated failures and state inspection) and cannot run against a real agent.

**Live mode** is the evidence about the actual agent, and today it covers a subset of the specification. Treat the live counts above as the true measure of agent coverage.

The requirement-by-requirement mapping is in [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md). Each automated requirement there is marked **mock-only** or **mock + live**.

## What's Covered (126 automated tests against the mock agent)
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
tests/security-agent.e2e.spec.ts      Core end-to-end scenarios (T01-T37, with gaps for retired IDs)
tests/spec-coverage.e2e.spec.ts       Requirement-tagged specification tests
docs/REQUIREMENTS_TRACEABILITY.md     Requirement -> test matrix, manual cases, open questions
playwright.config.ts                  Config (starts the mock agent automatically)
.github/workflows/e2e.yml             CI: type-check, run suite, upload report
```

## Configuration
| Variable | Default | Purpose |
|---|---|---|
| `USE_MOCK_AGENT` | `true` | `false` runs against a real agent |
| `AGENT_WS_URL` | `ws://127.0.0.1:8080` | Agent WebSocket URL for live runs |
| `ALLOW_LIVE_MUTATIONS` | unset | Must be `true` to run data-changing tests against a live agent |
| `HEARTBEAT_MS` | `60000` (`400` in tests) | Mock heartbeat interval for `/healthStatusUpdate` |

## Continuous Integration
GitHub Actions (`.github/workflows/e2e.yml`) installs with `npm ci`, type-checks with `tsc --noEmit`, runs the suite against the mock agent, and uploads `playwright-report/` and `test-results/` as artifacts. It uses read-only permissions and a 10-minute timeout.

## Quick Start (Anyone Can Run Out of the Box)

### 1. Run Against the Built-in Spec-Compliant Mock Agent (Zero External Dependencies)
```bash
npm install
npm test
```
Playwright automatically boots the local WebSocket mock agent on `ws://127.0.0.1:8080`, executes all 126 tests, and shuts it down.

### 2. Run Against a Live StoreOS Ubuntu 22 Security Agent
```bash
USE_MOCK_AGENT=false AGENT_WS_URL=ws://<storeos-terminal-ip>:8080 npm test
```
*(Tests marked `test.skip(!IS_MOCK, ...)` need the mock control plane and are skipped automatically. A read-only live run executes 26 of the 126 tests; see [What this suite covers: mock vs. live](#what-this-suite-covers-mock-vs-live).)*

**Live runs are read-safe by default.** Tests that create, change or delete data on the agent (temp registration, barcode creation, `/setConfiguration`, `/forgetMe`) are skipped against a live agent. Only set `ALLOW_LIVE_MUTATIONS=true` on a disposable test terminal:
```bash
USE_MOCK_AGENT=false ALLOW_LIVE_MUTATIONS=true AGENT_WS_URL=ws://<ip>:8080 npm test
```
On Windows PowerShell, set the variables first (`$env:USE_MOCK_AGENT='false'; $env:AGENT_WS_URL='ws://<ip>:8080'`) and then run `npm test`.
