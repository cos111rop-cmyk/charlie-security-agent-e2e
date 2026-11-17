# Running the suite against a real Charlie StoreOS Security Agent

This guide covers only the tests that run against a real agent. The rest of the suite (86 tests) runs only against the built-in mock agent and says nothing about a real agent; see [What is not covered](#what-is-not-covered).

| Suite | Command | Tests | Safe on |
|---|---|---|---|
| Live, no records created | `npm run test:live` | 27 | Any agent, with the side effects listed below |
| Live, data-changing | `npm run test:live:mutating` | 44 (the 27 above plus 17) | A disposable test terminal only |

Each test carries a tag: `@live` (in both suites) or `@live-mutating` (data-changing suite only). A test that is run in a mode its tag does not allow fails with an explanation instead of silently skipping.

## Prerequisites

* **Node.js 20 or later** and npm. From the repository root run `npm ci` once.
* **Network access** from the machine running the tests to the agent's WebSocket port (default `8080`).
* **The agent's address** in `AGENT_WS_URL`, for example `ws://<terminal-ip>:8080`. The live suites refuse to start without it.
* **Test accounts on the agent.** The tests use fixed test data; create it on the terminal (or adjust the IDs in the tests) before running:

| Account | Needed by | What it must be |
|---|---|---|
| `rt00001`, password `SecretPassword123` | both suites | A regular employee with an enrolled face and valid PING and SM tokens |
| `expired_emp_01` | both suites (test 15) | An employee whose stored PING and SM tokens have expired |
| `twin_emp_01` | data-changing suite (test 12) | Any second employee; used to check that a barcode is refused for the wrong employee (6524) |
| `unknown_999` | both suites | Must **not** exist on the agent |

* **A person at the camera** for the face tests: the person enrolled as `rt00001` for test 08, and in the data-changing suite also for `[PRO-04]`, `[RGB-01]`, `[BIO-03]`, `06` and `35` (the last two enroll and then scan a temporary employee).

## Run without creating records

```bash
AGENT_WS_URL=ws://<terminal-ip>:8080 npm run test:live
```

Windows PowerShell:

```powershell
$env:AGENT_WS_URL = 'ws://<terminal-ip>:8080'
npm run test:live
```

These tests create and delete no records, but some do change state on the agent:

* **Last-login state:** tests `03` and `08` log in as `rt00001` with `isLogin: true`, which updates that account's stored login type and reference.
* **Store assignment:** test `14` assigns the terminal's store and workstation to `rt00001` (`assignStore: true`).
* **Log upload:** the four `[UPL-01]` tests ask the agent to upload its `error`, `info`, `debug` and `all` logs.

The remaining tests only send requests that the agent must reject, or that read data.

## Run the data-changing tests (disposable terminal only)

```bash
AGENT_WS_URL=ws://<disposable-terminal-ip>:8080 npm run test:live:mutating
```

On top of the run above, this suite:

* registers temporary employees with unique IDs (prefixes `T0059_`, `T_DUP_`, `T_VALID_`, `T_FORGET_`, `T_FGT_`) and enrolls faces for some of them;
* enrolls a face for `rt00001` again and stores new login state for it;
* creates short-lived barcodes for `rt00001` (PIN `4354`);
* calls `/forgetMe` on the temporary employees it created, and on `unknown_999`.

It never deletes `rt00001` or any other pre-existing profile, but do not run it on a terminal in use by a store.

The older form `USE_MOCK_AGENT=false [ALLOW_LIVE_MUTATIONS=true] npm test` still selects the same suites.

## Reading the results

The console shows one line per test. `npm run report` opens the HTML report with the request and response details of any failure. A failure means the agent's response differed from the specification, or the test data above is missing. Check the account table first.

## What is not covered

The live suites check the request and response contract only. They do **not** cover:

* **Anything that needs fault injection or the agent's internal state** (86 mock-only tests): IDP and database outages, offline mode and revalidation, headless mode, digital-twin decisions, face-capture prompts and the guidance translation table, transaction termination, camera control, configuration restarts, and the contents of the SecurityLog and ErrorLog (including the checks that passwords, tokens, PINs and barcodes never reach them).
* **Installer, operating system, hardware and back-end behaviour**: written as manual cases `MTC-01` to `MTC-23` in [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md), section 4.
* **Behaviour the specification does not define yet**, which has no test at all: attempt limits and lock-out, liveness failure (spoof attempts), and whether a barcode can be reused after a successful scan (section 5, items 13, 20 and 21).
