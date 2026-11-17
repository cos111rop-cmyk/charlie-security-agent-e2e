# Requirements Traceability Matrix

Charlie StoreOS Security Agent: traceability from the four source documents to the test suite.

**Source documents**

| Short name | Document |
|---|---|
| **SPEC** | *Charlie - StoreOS Security Agent* requirements document (full specification, change log, API definitions) |
| **TECH** | *Charlie Security Agent Technical Reference with Playwright Automation* |
| **STUDY** | *Charlie StoreOS Security Agent Study Guide* |
| **LAYMAN** | *Charlie High Level Layman Breakdown Summary* |

STUDY, LAYMAN and TECH are summaries of SPEC. Where they disagree with SPEC, this suite follows SPEC (see section 5).

## 1. How to read this document

* **Automated**: a Playwright test asserts the requirement. Core tests are numbered `01`-`37` in their titles and referred to here as `T01`-`T37` (file `tests/security-agent.e2e.spec.ts`). Numbers are kept stable when a test is removed, so there are gaps; see "Retired core test IDs" below. Specification tests carry a requirement tag such as `[BAR-05]` in the title (file `tests/spec-coverage.e2e.spec.ts`).
* **Mock only**: the test needs the mock agent's control plane (fault injection or state inspection). It is skipped against a live agent.
* **Manual**: the requirement is about the installer, operating system, files, hardware, cloud back end or screen layout. It cannot be proven through the WebSocket API. A manual test case (`MTC-nn`) is written in section 4 so it can still be executed and signed off.
* **Spec gap**: the specification does not define the behaviour, so no pass/fail can be written. Listed in section 5.

### Coverage column

Every row in section 2 has a **Coverage** label, taken from which tests actually run with `USE_MOCK_AGENT=false`:

| Label | Meaning |
|---|---|
| **mock + live** | At least one listed test runs against a live agent in the default, read-only live mode. |
| **mock + live †** | The only live-capable tests change data, so they run live only with `ALLOW_LIVE_MUTATIONS=true` on a disposable terminal. |
| **mock-only** | Every listed test is skipped against a live agent, or the assertion for this requirement runs only on the mock. A pass says nothing about the real agent. |
| **manual only** | No automated test; covered only by a manual case in section 4. |

A note in brackets after a label means only part of the row runs live. Totals across section 2 (130 requirements, with the 20-row translation table in 2.7 counted once): 31 **mock + live**, 21 **mock + live †**, 73 **mock-only**, 5 **manual only**. Behaviour the specification does not define (liveness failure, attempt limits and lock-out, barcode reuse) has no row here and no test; see section 5, items 13, 20 and 21.

### Run summary

| Mode | Command | Result |
|---|---|---|
| Mock agent (default) | `npm test` | 127 executed, 127 pass |
| Live agent, read-safe | `USE_MOCK_AGENT=false AGENT_WS_URL=ws://<ip>:8080 npm test` | 26 executed, 101 skipped (need fault injection or data changes) |
| Live agent, data changes allowed (disposable terminal only) | add `ALLOW_LIVE_MUTATIONS=true` | 43 executed, 84 skipped (need fault injection) |

The live-mode figures were obtained by running live mode against the mock's WebSocket port (last re-checked 2026-11-17 on `main` at `146f1a4` plus LOG-06: 26 and 43 executed, 0 failed), so they prove the live subset does not depend on mock-only features. They are **not** a run against a real StoreOS agent. A run against a real agent is still required before sign-off.

### Retired core test IDs

These numbered tests were removed because a tagged test asserts the same thing. Their numbers are not reused.

| Retired | Now covered by | Merged into the tagged test |
|---|---|---|
| T02 | LOG-01 | 9502 error code; ErrorLog entry's `actionPerformed` and `errorCode` |
| T19 | UPL-01, UPL-02 | nothing (already covered) |
| T21 | HDL-01, HDL-02 | nothing (already covered) |
| T22 | DBF-01 | `/healthCheck` returns 200 in Memory mode |
| T24 | TMP-01 | incomplete payload (`employeeId` + `firstName` only) |
| T29 | CFG-03 | empty `configurations: {}` object |
| T31 | TRM-01 | nothing (already covered) |
| T32 | TRM-01 | the untouched transaction returns action code 102 |
| T33 | BIO-04 | `statusCode` 400 for multiple faces |

T10 was reduced to its 1:1 face-mismatch check; its capture-timeout and glasses-guidance checks are covered by BIO-05 and UIG-01.

## 2. Automated coverage by requirement

### 2.1 WebSocket protocol (SPEC "WebSocket API common definitions", TECH sec. 2)

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| Every request has a correlationID; every response reflects it | SPEC correlationID | T01, PRO-01, PRO-02 | **mock + live** |
| Concurrent requests are distinguished by correlationID | SPEC correlationID 3.1 | PRO-02 | **mock + live** |
| `path` echoed in the response | SPEC path | T01, PRO-01 | **mock + live** |
| Response has top-level `statusCode` (200 success, 400 failure) | SPEC response | PRO-01 and every endpoint test | **mock + live** |
| Response is inside `response`, with `actionResult`, and `errorInfo` on errors | SPEC response | PRO-01 | **mock + live** |
| `timeTaken` on every response | SPEC response 15.5 | T01, PRO-01 | **mock + live** |
| `processingMs` on biometric auth, biometric enrollment, barcode auth | SPEC Metrics | T08, PRO-04 | **mock + live** (T08 covers biometric auth read-only; barcode auth and enrollment, via PRO-04, need `ALLOW_LIVE_MUTATIONS`) |
| Malformed frame does not take the agent down | robustness | PRO-03 (mock only) | **mock-only** |

### 2.2 Logging (SPEC "Logging", "SecurityLog Info", "ErrorLog Info")

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| Successful `/healthCheck` is not in SecurityLog | SPEC Logging 17.2 | T01 | **mock-only** (T01 runs live, but its SecurityLog check runs only on the mock) |
| Failed `/healthCheck` goes to ErrorLog, not SecurityLog | SPEC Logging 18.2 | LOG-01 | **mock-only** |
| All other calls are logged in SecurityLog with appId `StoreOS`, employeeId, storeId, machineId, timestamp, correlationId, timeTakenMs, actionResult string | SPEC SecurityLog | LOG-02, LOG-04 | **mock-only** |
| Errors are logged in ErrorLog with errorCode, errorMessage, correlationId, timeTakenMs | SPEC ErrorLog | LOG-01, LOG-03 | **mock-only** |
| Passwords are never in responses or logs (API level) | SPEC Important pt 9 | LOG-05 (file-level check: MTC-06) | **mock-only** |
| `sosToken`, barcode PINs, barcodes and PING/SM tokens (access, id, refresh, session) never appear in SecurityLog or ErrorLog, on success or failure paths (API level) | SPEC Important pt 9 (same principle as passwords) | LOG-06 (file-level check: MTC-06) | **mock-only** |

### 2.3 Health (SPEC `/healthCheck`, `/healthStatusUpdate`)

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| `/healthCheck` returns service, camera, database connection, `databaseMode`, `uiStatus` | SPEC healthCheck; Dec 10 2025 | T01, HEA-01 | **mock + live** |
| `databaseMode` is `Memory` after a DB failure | SPEC healthCheck; DB failure | DBF-01 | **mock-only** |
| IDP outage reported as `idpStatus` DOWN / `allServicesDown` / 1515 while still returning 200 | SPEC healthCheck; Jul 29 2025 | HEA-02 | **mock-only** |
| `uiStatus` is -1 without a graphical session | SPEC healthCheck | HEA-03 | **mock-only** |
| Health check failure returns 9502 | SPEC healthCheck | LOG-01 | **mock-only** |
| `/healthStatusUpdate` heartbeat is pushed to connected clients without a request | SPEC healthStatusUpdate 4.2 | HSU-01 | **mock-only** |
| Event-driven update on camera change | SPEC healthStatusUpdate 4.4 | HSU-02 | **mock-only** |
| Event-driven update on connectivity change | SPEC healthStatusUpdate 4.4 | HSU-03 | **mock-only** |
| Heartbeat interval configurable in the .ini file | SPEC healthStatusUpdate 4.1 | MTC-04 | **manual only** |

### 2.4 `/authenticate/credentials`

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| Regular employee success: 601, `isBiometricRegistered`, `userInfo` | SPEC credentials; TECH TC02 | T03 | **mock + live** |
| Invalid password: 651/6501 | SPEC credentials failure | T04, CRD-04 | **mock + live** |
| Missing mandatory field: 9510 | SPEC (common) | T04 | **mock + live** |
| IDP unreachable: 6503 | SPEC credentials failure; Nov 5 2025 | T05 | **mock-only** |
| `isLogin=true` stores credentialType `credentials` and credentialRefId = correlationID | SPEC credentials | T03, CRD-02 | **mock + live** |
| `isLogin=false` returns previously stored values, or omits them when nothing is stored | SPEC credentials 4.3.1 | CRD-01, CRD-02 | **mock + live †** (CRD-01, "omits when nothing is stored", is mock-only) |
| Temporary employee (`isTempEmployee=true`) uses the temp-employee flow and returns `sosToken` | SPEC credentials | CRD-03 | **mock-only** |
| Temp employee `sponsorId` returned only when `isLogin=true` | SPEC credentials | T37 | **mock-only** |
| Password never cached or logged | SPEC credentials note | LOG-05 | **mock-only** |

### 2.5 `/register/biometric`

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| Missing employeeId or loginCorrelationID: 9510 | SPEC register biometric 4.1 | T07 | **mock + live** |
| employeeId not in cache: 6500 | SPEC 4.2 | T07 | **mock + live** |
| loginCorrelationID not in SecurityLog: 6500 | SPEC 4.3 | T07 | **mock + live** |
| loginCorrelationID of a failed login: 6501 | SPEC 4.4 | RGB-02 | **mock-only** |
| loginCorrelationID must come from `/authenticate/credentials` or `/register/tempEmployee` | SPEC 4.4.1 | RGB-03, T06 | **mock + live** |
| Success returns 100 "Face Enrollment Successful" | SPEC | T06, RGB-01 | **mock + live †** |
| `consentVersion` and `state` are optional | SPEC register biometric table | RGB-01, T06, T23 | **mock + live †** |
| Temp-employee duplicate profile: 1511 | SPEC 6.5 | T25, T26 | **mock + live †** |
| Poor image quality during enrollment: 1502 | SPEC | T26 | **mock-only** |
| UI cannot start: 9500 | SPEC non-graphical | RGB-04 | **mock-only** |
| Closing the UI returns 9509 | SPEC UI definition | UI-01 | **mock-only** |
| Offline enrollment only for temporary (`tempRegistration`) users | SPEC offline temp | TMP-06, T23 | **mock-only** |

### 2.6 `/authenticate/biometric`

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| 1:1 match when employeeId given; success code 102, `modelUsed`, `processingMs` | SPEC biometric | T08 | **mock + live** |
| 1:N search when employeeId omitted; returns uuid and userInfo | SPEC biometric 9-10 | BIO-01 | **mock-only** |
| employeeId not in cache: 1506; 1:N no match: 1506 | SPEC biometric 8.2, 11.4 | BIO-02 | **mock-only** |
| Face mismatch: 153/1505 | SPEC biometric 10 | T10, TWN-02, OFF-02 | **mock-only** |
| Capture timeout: 153/1504 | SPEC failure case | BIO-05 | **mock-only** |
| Interim re-scan prompts: 1503 no face, 1501 multiple faces, 1502 poor quality | SPEC register biometric 6.3 | BIO-04 | **mock-only** |
| Interim 1500 sent once for passive 1:N | SPEC biometric 4.6.4 | T09 | **mock-only** |
| No interim when authentication completes inside the delay window | SPEC biometric 4.6.3 | BIO-06 | **mock-only** |
| `liveness` and `liveness_reco` flags accepted | SPEC biometric payload | T08, BIO-01 | **mock + live** |
| `isLogin` semantics (credentialType `biometric`, stored values) | SPEC biometric | BIO-03 | **mock + live †** |
| Expired token, IDP reachable: 153/1509 with userInfo | SPEC biometric 8 | BIO-07 | **mock-only** |
| Expired token, IDP down: 153/1510 with userInfo | SPEC biometric 8 | BIO-08, OFF-02 | **mock-only** |
| No sessionToken and no access_token: 1510 with userInfo | SPEC biometric 5.2 | BIO-09 | **mock-only** |
| DB error: 950/9524 and automatic switch to Memory mode | SPEC DB failure | DBF-01 | **mock-only** |
| After the switch the agent keeps serving requests | SPEC DB failure 2 | DBF-01 | **mock-only** |
| Closing the UI: 9509 | SPEC UI definition | UI-01 | **mock-only** |

### 2.7 CVS feedback message translation (SPEC "Feedback Messages", TECH sec. 4)

All 20 rows of the table are asserted individually (`[UIG-01]`). Row "Invalid face background" maps to "N/A" in the spec, meaning no message; see section 5.

Coverage: **mock-only**. Every translation test drives the mock's `simulateVisionCode` hook, so none of them runs against a live agent.

### 2.8 Digital Twin (SPEC "Digital Twin Biometric Authentication")

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| 1:N single match on a non-twin: authenticate | SPEC decision logic | TWN-01 | **mock-only** |
| 1:N single match on a twin: 1512 | SPEC decision logic | T11, TWN-01 | **mock-only** |
| 1:N multiple matches: 1512 | SPEC decision logic | TWN-01 | **mock-only** |
| 1:1 face mismatch: 1505 (even for a twin) | SPEC decision logic | TWN-02 | **mock-only** |
| 1:1 non-twin: authenticate | SPEC decision logic | TWN-02 | **mock-only** |
| 1:1 twin, `periodic_interval_minutes = 0`: 1512 | SPEC decision logic | TWN-03 | **mock-only** |
| 1:1 twin, `last_authenticated_at` missing: 1512 | SPEC decision logic | T11, TWN-05 | **mock-only** |
| 1:1 twin, interval expired: 1512; inside interval: authenticate | SPEC decision logic | TWN-04 | **mock-only** |
| Biometric success does not refresh `last_authenticated_at` | SPEC key points | TWN-04 | **mock-only** |
| `last_authenticated_at` updated by credentials, barcode, and `/userinfo` with `assignStore` | SPEC key points | T11, TWN-06 | **mock-only** |
| Missing twin fields default to `unknown`, `[]`, `null` | SPEC cache requirements | MTC-22 | **manual only** |
| TECH TC04 (twin 1:1 gets 1512) | TECH | T11, TWN-05 | **mock-only** |

### 2.9 Barcodes (`/register/barcode`, `/authenticate/barcode`)

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| Barcode is `BI` + 11 random alphanumeric characters (13 total), unique | SPEC register barcode 6 | T12, BAR-04 | **mock + live †** |
| Success returns 602, barcodeData, firstName, middleName, lastName ("" if unknown) | SPEC register barcode 7 | BAR-01 | **mock + live †** |
| Missing employeeId or validity: 652/9510 | SPEC register barcode 4.2 | BAR-02 | **mock + live** |
| employeeId not in cache: 652/6500 | SPEC register barcode 4.4 | T27 | **mock + live** |
| Expired temp profile cannot create a barcode | SPEC register barcode 4.4.3 | BAR-08 | **mock-only** |
| PIN: 4 digits, string, numbers only | SPEC register barcode 5.2 | T27 | **mock + live** |
| PIN mandatory when `FallBackAuthWithPinEnabled=Y`, optional when `N` | SPEC register/authenticate barcode | BAR-03 | **mock-only** |
| `validity` (seconds) controls expiry; expired barcode: 653/6522 | SPEC authenticate barcode 4.4 | T13, BAR-05 | **mock + live †** |
| Success returns 603 | SPEC authenticate barcode | T12, BAR-07 | **mock + live †** |
| Barcode matching is case-insensitive | SPEC Jan 3 2025 | T12 | **mock + live †** |
| Wrong PIN: 6523 | SPEC authenticate barcode | T12, LOG-03 | **mock + live †** (LOG-03 is mock-only) |
| employeeId in payload must match the barcode owner: 6524 | SPEC Oct 9 2026 | T12 | **mock + live †** |
| employeeId in payload is optional | SPEC authenticate barcode note; TECH TC03 | BAR-07 | **mock + live †** |
| Missing barcodeData: 653/9510; unknown barcode: 6522 | SPEC authenticate barcode 4.3 | BAR-06 | **mock + live** |
| `isLogin=true` stores credentialType `barcode` | SPEC authenticate barcode | BAR-07 | **mock + live †** |
| Temp-registered barcode usable offline with PIN, rejected (6522) once IdPs are back | SPEC offline temp 2-3 | TMP-02 | **mock-only** |
| Barcode with PIN works in headless mode; without PIN returns 9500 | SPEC non-graphical 4.4 | HDL-01, HDL-02 | **mock-only** |
| TECH TC03 (create and validate) | TECH | T12, BAR-07 | **mock + live †** |

### 2.10 Temporary and offline employees

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| `/register/tempEmployee` success returns 900 | SPEC tempEmployee | T06 | **mock + live †** |
| Empty or incomplete payload: 951/9510 | SPEC tempEmployee 4.2 | TMP-01 | **mock + live** |
| Duplicate temp profile: 1511 | SPEC | T25 | **mock + live †** |
| Offline registration, enrollment and biometric authentication for temp users | SPEC offline 1-2 | T23 | **mock-only** |
| Valid profile authenticates; expired profile rejected with 1506 | SPEC biometric 8.1.4 | T35, T36 | **mock + live †** (T36, the expired-profile case, is mock-only) |
| Revalidation, same store: success, local profile replaced | SPEC offline 3 | TMP-03 | **mock-only** |
| Revalidation, other store: 1509 with `storeIdMismatch: true`, not cached | SPEC offline 3 | T23, TMP-04 | **mock-only** |
| Revalidation, no profile: 1506 | SPEC offline 3 | TMP-05 | **mock-only** |

### 2.11 Offline mode (SPEC "Offline Mode Support", "Agent Offline Resilience")

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| Offline 1:1 and 1:N succeed from cache with valid tokens | SPEC offline | OFF-01 | **mock-only** |
| Offline expired token: 1510 with cached userInfo, no refresh | SPEC offline | OFF-02 | **mock-only** |
| Offline unknown user: 1506; mismatch: 1505 | SPEC offline | OFF-02 | **mock-only** |
| Logs queue as pending offline and are synced afterwards | SPEC local log storage | OFF-03 | **mock-only** |
| CloudHealthMonitor, LogReplayEngine backoff | SPEC resilience | MTC-13, MTC-14 | **manual only** |

### 2.12 Remaining endpoints

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| `/userinfo` returns profile; store_id/workstation only with `assignStore` | SPEC userinfo | T14, USR-02 | **mock + live** (the "no store_id without `assignStore`" check is mock-only) |
| `/userinfo` unknown employee: 651/6500 (with and without `assignStore`) | SPEC userinfo failure | USR-01, T20 | **mock + live** |
| `/userinfo` returns credentialType and credentialRefId | SPEC userinfo step 6 | USR-02 | **mock + live †** |
| `/userinfo` 90-minute refresh with `DisableUserSync` / `SilentModeEnabled` | SPEC userinfo step 3 | MTC-23 | **manual only** |
| `/terminate/transaction` unknown target: 950/9503 | SPEC terminate | T18 | **mock + live** |
| `/terminate/transaction` cancels an in-flight transaction (200/900) | SPEC terminate 4.3-4.4 | TRM-01 | **mock-only** |
| Only the targeted transaction is terminated | SPEC terminate 4.3 | TRM-01 | **mock-only** |
| Transaction that is not terminated completes normally | SPEC terminate | TRM-01 | **mock-only** |
| `/forgetMe` success removes the profile; later lookups return 6500 | SPEC forgetMe | T20 | **mock + live †** |
| `/forgetMe` unknown employee: 651/6500; `deleteFaceId` optional | SPEC forgetMe 4.2-4.3 | FGT-01, FGT-02 | **mock + live †** |
| `/forgetMe` deletion failure: 9506, profile kept | SPEC forgetMe 4.4 | FGT-03 | **mock-only** |
| `/uploadLogs` accepts `error`, `info`, `debug`, `all` | SPEC uploadLogs | UPL-01 | **mock + live** |
| `/uploadLogs` rejects other or missing `logType` | SPEC uploadLogs 8.1 | UPL-02 | **mock + live** |
| `/setConfiguration` applies settings; empty payload rejected | SPEC setConfiguration | CFG-02, CFG-03 | **mock + live** (only CFG-03, the empty-payload rejection, runs live; CFG-02, applying settings, is mock-only) |
| Restart only when a restart-requiring key actually changes | SPEC automatic self-restart | T17, CFG-01 | **mock-only** |
| `/user/token` returns PING and SM tokens with `createdAt` and `expiresIn` | SPEC user/token | T15, TOK-01 | **mock + live** |
| `/user/token` single type returns one token | SPEC user/token note | TOK-01 | **mock + live** |
| `/user/token` partial availability returns the available tokens with 200 | SPEC user/token 3 | TOK-02 | **mock-only** |
| `/user/token` errors: 6500, 9510, 1510 | SPEC user/token | T34 | **mock-only** (T34 asserts 6500 and 9510 before it skips on a live agent, but it is reported as skipped) |
| `/notify/bio-camera` ON/OFF return 706; idempotent | SPEC notify camera | T16, CAM-01 | **mock-only** |
| Camera OFF and no VV camera open: scan turns camera on and proceeds | SPEC notify camera 2 | T16 | **mock-only** |
| Camera OFF and VV camera open: 952/9520 | SPEC notify camera 2 | CAM-03 | **mock-only** |
| `DisableCamera` / `SilentModeEnabled`: ON returns success but camera stays off | SPEC notify camera 1 | CAM-02 | **mock-only** |

### 2.13 Non-graphical (headless) mode (SPEC "Security Agent non-graphical mode")

| Requirement | Source | Tests | Coverage |
|---|---|---|---|
| UI-dependent calls return 950/9500 with message "UI cannot be initialized" | SPEC | HDL-01 | **mock-only** |
| `/healthCheck`, `/terminate/transaction`, `/register/barcode`, `/authenticate/barcode` with PIN, `/authenticate/credentials`, `/userinfo`, `/forgetMe` keep working | SPEC non-graphical 4 | HDL-02 | **mock-only** |
| Agent starts and accepts connections without a graphical target | SPEC non-graphical 1-2 | MTC-03 | **manual only** |

## 3. Sample payloads from TECH section 6

| TECH test | Result in this suite |
|---|---|
| TC01 health check | Covered by T01 |
| TC02 credentials success | Covered by T03 |
| TC03 barcode create and validate | Covered by T12 and BAR-07 |
| TC04 twin returns 1512 | Covered by T11 and TWN-05 |
| TC05 terminate an unknown target returns 200 | **Not followed.** SPEC defines 400/9503 for an unknown target. T18 asserts 9503; TRM-01 covers the successful terminate. See section 5, item 1. |

## 4. Manual test cases

These requirements cannot be proven through the WebSocket API. Each case lists the steps and the expected result so it can be signed off in the client's environment.

| ID | Requirement (source) | Steps | Expected result |
|---|---|---|---|
| MTC-01 | Standalone `.deb` installs on Core Ubuntu 22 with no prerequisites (SPEC Important pt 6; STUDY sec. 3) | On a clean Core Ubuntu 22 image run `sudo dpkg -i <agent>.deb`. Do not install any other package. | Install completes with no missing-dependency errors; service is installed. Bundled libraries are used; existing system libraries are linked where present. |
| MTC-02 | systemd unit matches the client definition (SPEC Important pt 13) | Inspect the unit file. Reboot, then shut down to `multi-user.target`. | `PartOf=graphical-session.target`, `After=network-online.target CVS_boot_master.service`, `Wants=network-online.target`, `WantedBy=multi-user.target`. The agent stops cleanly with no crash entry. |
| MTC-03 | Agent starts and accepts connections without a graphical target (SPEC non-graphical) | Boot the machine to a non-graphical target. Connect a WebSocket client and call `/healthCheck`, then `/authenticate/biometric` with `uiDelay: 0`. | Connection accepted; health check returns 200 with `uiStatus: -1`; the biometric call returns 9500. |
| MTC-04 | Face thresholds, heartbeat interval and capture timeout are configurable in `config.ini` (SPEC Important pt 7; healthStatusUpdate 4.1; register biometric 6.2) | Change a face threshold, the heartbeat interval and the 30 s capture limit. Restart. Observe behaviour. | New values take effect: threshold changes match/reject results, heartbeat arrives at the configured interval, capture times out at the configured limit. |
| MTC-05 | Debug log retention and rollover (SPEC Important pt 8) | Fill the debug log past 30 MB. Reinstall the package. | Log rolls over at 30 MB; rolled file stays in the same path; logs survive reinstall. |
| MTC-06 | No plaintext secrets in debug logs or the log database (SPEC Important pt 9) | Run `/authenticate/credentials` with a known password, a temporary-employee login (note the `sosToken`), `/user/token` for PING and SM (note each token), and `/register/barcode` + `/authenticate/barcode` with a known PIN, once with a wrong PIN. `grep` all debug log files and dump the SecurityLog and ErrorLog tables for each noted value. | None of the password, `sosToken`, PINs, barcode or PING/SM tokens is present. |
| MTC-07 | USB camera auto-reconnect (SPEC Important pt 10; STUDY sec. 3) | Unplug the USB camera, wait, plug it back in. Do not restart the service. Call `/healthCheck`, then `/authenticate/biometric`. | `cameraStatus` reports the disconnect, then recovery. Authentication works without a service restart. An event-driven `/healthStatusUpdate` is received on both changes. |
| MTC-08 | Ditto SDK initialization failure (SPEC Important pt 11) | Make the Ditto SDK fail to initialize. Authenticate. | The agent keeps running, bypasses the local cache and uses the cloud directly; the failure is logged. |
| MTC-09 | Self-restart writes config and logs (SPEC setConfiguration) | Change a restart-requiring key through `/setConfiguration`. Check `config.ini` and the logs. | New value saved in `config.ini`; log shows "Config changed for X. Restart required."; the agent restarts safely. Setting the same value again does nothing. |
| MTC-10 | `x-workstation-name` header on every outgoing API call (SPEC Workstation Name Header) | Capture outgoing traffic (proxy) while exercising every endpoint. | Every downstream request has `x-workstation-name` equal to the host name. |
| MTC-11 | `X-Correlation-ID` header on every outgoing API call (SPEC correlationID 3.4, 4.5) | Capture outgoing traffic while sending requests with known correlationIDs. | Every downstream request carries `X-Correlation-ID` equal to the request's correlationID. The ID is not stored in the cloud. |
| MTC-12 | Store ID retrieved on startup (SPEC Store ID) | (a) Start with `store_id` empty and the store API reachable. (b) Start with `store_id` present. (c) Start with the API down, then restore it. (d) Check `config.ini`. | (a) API called, value saved to `config.ini`. (b) API not called. (c) Retries until success; no user sync before success. (d) Value is never overwritten with `test_store`. |
| MTC-13 | CloudHealthMonitor and OFFLINE_MODE (SPEC resilience 1, 4) | Block the Edge server only, then the GCP backend only, then both. | One up: sync continues. Both down: agent enters OFFLINE_MODE, pauses sync, no token refresh or log sync. Recovers when a healthy endpoint returns. Checks run about every 30 s. |
| MTC-14 | LogQueueManager and LogReplayEngine (SPEC resilience 2-3) | Go offline, authenticate several times, restore connectivity, force sync failures. | Entries stored locally with status `pending`; replayed in batches with exponential backoff and jitter; at most 5 retries per log; successful entries marked synced. |
| MTC-15 | Delta log upload (SPEC Delta-Based Log Upload) | Upload logs, append new lines, upload again. Compare the bytes sent. | Only the new lines are sent on the second upload; nothing already uploaded is re-sent. |
| MTC-16 | Memory mode recovery after restart (SPEC Database Failure Handling 3) | Force a DB failure so the agent switches to Memory mode. Restart with the DB repaired, then with the DB still broken. | Repaired: back to DB mode. Still broken: remains in Memory mode and logs the failure. Fallback and recovery are logged and exposed as an event or metric. |
| MTC-17 | UI shows a Close (X) icon instead of a Back arrow (SPEC UI Definition; STUDY sec. 4) | Open the registration and authentication screens. Click the X. | An X is shown on all registration and authentication screens; clicking it closes the UI and the caller receives 9509. The two screenshots in the spec still show the old back arrow and are out of date. |
| MTC-18 | Passive authentication enhancements (SPEC biometric Enhancements) | Run passive 1:1 with `uiDelay > 0` and an unclear face. | Attention animation appears and does not steal focus; after it times out the video window opens with looser alignment, one image, anti-spoof at about 0.40; 1:1 uses the loose threshold range (1.05-1.20). |
| MTC-19 | Enrollment captures 5 frames; UUID cache de-duplication (SPEC register biometric 7) | Enroll a user. Enroll a second employeeId that the cloud maps to the same UUID. | 5 frames captured and converted to embeddings; after success the old employeeId entries for the same UUID are deleted and only the latest is kept. |
| MTC-20 | Embedding update on 1:N (SPEC biometric 10.1) | Run 1:N with `uiDelay: 0`, then with `uiDelay > 0`. | `uiDelay: 0`: embedding updated as 90% existing + 10% incoming. `uiDelay > 0`: not updated. |
| MTC-21 | Active capture timing (SPEC register biometric 6) | Use a covered camera. Time the responses with the default settings (`uiDelay` default 2.5 s, 30 s limit). | Interim 150 prompts about every limit/3 seconds; after 30 s a 153/1504 failure. |
| MTC-22 | Twin fields default when missing (SPEC Digital Twin cache requirements) | Cache a user with no twin fields, then authenticate. | The agent treats the user as `unknown`, no pairs, `last_twin_check_at` null, and does not crash. |
| MTC-23 | `/userinfo` 90-minute refresh (SPEC userinfo step 3) | Set `DisableUserSync` or `SilentModeEnabled` true. Use a profile whose last refresh is older than 90 minutes. | The profile is re-fetched from the back end and `lastRefresh` is updated; a profile under 90 minutes is returned from the cache. |

## 5. Discrepancies and open questions to confirm with the client

These are places where the documents contradict each other or leave a behaviour undefined. The suite follows SPEC. Each item should be confirmed before the suite is called final.

1. **Terminate of an unknown transaction.** TECH TC05 expects 200 for an unknown `targetCorrelationID`; SPEC requires 400 / 9503. Suite follows SPEC.
2. **Camera OFF.** An earlier version of this suite expected 9520 whenever the camera was OFF. SPEC says the agent turns the camera back on and proceeds, and returns 9520 only when a VV camera is open. Corrected (T16, CAM-03).
3. **Multiple faces.** SPEC lists 1501 "Multiple face detected" for faces in frame and 1512 for ambiguous 1:N matches. An earlier test mixed the two. Corrected (BIO-04, TWN-01).
4. **1504 status code.** SPEC samples show `statusCode` 400 for enrollment timeout but 200 for authentication timeout. The suite asserts only the action and error codes (153/1504).
5. **Credentials when the IDP is down.** The Feb 9 2025 change log entry says 1510; the Nov 5 2025 entry changed the code to 6503. Suite uses 6503 (latest).
6. **Barcode response key.** SPEC sample spells it `crendentialType`. Suite expects `credentialType`.
7. **`idpStatus` position in `/healthCheck`.** SPEC samples place it inside `response` in some examples and at the root in others. The mock puts it at the root; HEA-02 asserts the root.
8. **`/register/tempEmployee` is marked "requirements still under review (Phase 2)".** Mandatory fields are not defined. The suite assumes `employeeId`, `firstName` and `sponserId` are required. The spelling `sponserId` (request) versus `sponsorId` (response) is as written in SPEC.
9. **Error codes missing from the TECH table:** 1503, 1515, 9502, 9506, 9509 appear in SPEC samples but not in TECH's error table.
10. **Which keys require a restart** (`setConfiguration`) is not listed. The mock assumes `backend_url` and `store_id`.
11. **`/healthStatusUpdate` interval units.** SPEC says "every x minutes" in one line and "x seconds" in another.
12. **`/authenticate/barcode` with PIN required but missing.** Error code not defined. The mock returns 9510.
13. **Attempt limits and lock-out are not defined.** `BarcodeScanMaxAttempts`, `AuthenticationFacialScanMaxAttempts` and `BiometricRegistrationFacialScanMaxAttempts` exist as settings, but SPEC does not say what happens when a limit is reached (error code, whether the barcode, user or terminal is locked, for how long, what resets the counter). The only rule is that a 6524 mismatch counts as a failed barcode attempt. The mock never reads these settings. **No test** until this is defined; a wrong-PIN loop could then run live with `ALLOW_LIVE_MUTATIONS=true`.
14. **Android permissions flow** is marked "To be filled" in SPEC. Nothing to test.
15. **"Invalid face background"** maps to "N/A" (no message) in SPEC. Not asserted.
16. **Barcode characters.** STUDY says "11-digit random barcodes"; SPEC says alphanumeric ("BIBP2RNY123"). Suite follows SPEC.
17. **Registration screens in SPEC** still show a back arrow although the change log replaced it with an X.
18. **Interim `1500` timing for passive 1:1** (`uiDelay > 0`): SPEC says the interim is sent once the delay expires without a match, for any authentication. The mock only emits it for 1:N, so T09 covers 1:N and BIO-06 covers the no-interim case for a fast 1:1.
19. **Refresh-token success path** during biometric authentication (expired access token, refresh succeeds) cannot be driven through the mock; covered by BIO-07/BIO-08 for the failure branches only.
20. **Liveness failure (spoof attempt) is not defined.** SPEC accepts the `liveness` and `liveness_reco` flags and MTC-18 mentions an anti-spoof threshold of about 0.40, but no response (action or error code) is defined for a failed liveness check. The mock accepts the flags and ignores them, and has no way to simulate a presentation attack. **No test** until the response is defined. Even then it is mock-only through the API; against a real agent it needs a physical presentation-attack test (printed photo, screen replay, mask) as a manual case.
21. **Barcode reuse after a successful authentication is not defined.** SPEC gives a `validity` in seconds but does not say whether a barcode is single-use. The mock accepts the same barcode again until it expires. **No test** until SPEC states whether a second use inside `validity` must succeed or fail (and with which code); it could then run live with `ALLOW_LIVE_MUTATIONS=true`.

## 6. Important limitation

The mock agent in `mock-server/` was written from the same documents. Tests that pass against it prove the suite and the documents agree with each other. They do not prove that the real agent behaves as documented. Run the suite against a real StoreOS terminal (section 1, run summary) and execute the manual cases before sharing results as verified.
