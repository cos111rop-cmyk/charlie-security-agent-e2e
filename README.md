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
