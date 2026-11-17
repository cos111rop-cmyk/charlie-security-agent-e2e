# Charlie StoreOS Security Agent — End-to-End Playwright Automation Suite

Portable, self-contained TypeScript + Playwright WebSocket E2E test suite covering every endpoint, error code, UI guidance translation, and resilience scenario in the **Charlie StoreOS Security Agent** specification.

## Documentation and traceability
* [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md) maps every requirement in the four source documents to an automated test (`T01`-`T37`, or a tagged ID such as `[BAR-05]`) or to a written manual test case, and lists the places where the source documents disagree.
* `tests/security-agent.e2e.spec.ts` holds the core end-to-end scenarios; `tests/spec-coverage.e2e.spec.ts` holds the requirement-tagged specification tests.

## What's Covered (135 automated tests)
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
tests/security-agent.e2e.spec.ts      Core end-to-end scenarios (T01-T37)
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

## Known Limitations
* The mock agent is built from the specification documents, so a mock-mode pass shows the suite and documents agree, not that a real agent behaves as documented. Run against a real StoreOS terminal and execute the manual cases before sign-off.
* Where the source documents contradict each other, the tests follow the full specification; each case is listed in section 5 of the traceability document.
* `/register/tempEmployee` is marked "under review" in the specification and the Android permissions section is unfinished; these are only partly testable.

## Quick Start (Anyone Can Run Out of the Box)

### 1. Run Against the Built-in Spec-Compliant Mock Agent (Zero External Dependencies)
```bash
npm install
npm test
```
Playwright automatically boots the local WebSocket mock agent on `ws://127.0.0.1:8080`, executes all 135 tests, and shuts it down.

### 2. Run Against a Live StoreOS Ubuntu 22 Security Agent
```bash
USE_MOCK_AGENT=false AGENT_WS_URL=ws://<storeos-terminal-ip>:8080 npm test
```
*(Tests marked `test.skip(!IS_MOCK, ...)` automatically skip fault-injection hooks that require the mock control plane while running all live endpoint assertions.)*

**Live runs are read-safe by default.** Tests that create, change or delete data on the agent (temp registration, barcode creation, `/setConfiguration`, `/forgetMe`) are skipped against a live agent. Only set `ALLOW_LIVE_MUTATIONS=true` on a disposable test terminal:
```bash
USE_MOCK_AGENT=false ALLOW_LIVE_MUTATIONS=true AGENT_WS_URL=ws://<ip>:8080 npm test
```
On Windows PowerShell, set the variables first (`$env:USE_MOCK_AGENT='false'; $env:AGENT_WS_URL='ws://<ip>:8080'`) and then run `npm test`.
