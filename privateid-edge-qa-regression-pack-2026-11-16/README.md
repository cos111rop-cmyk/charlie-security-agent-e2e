# PrivateID Edge — QA Regression Pack

A regression suite for the PrivateID edge component that you can run directly, as a Postman collection or with one shell command, and add your own cases to.

It covers every endpoint a real client calls (the StoreOS agent and the SOS UI's agent-down fallback). It checks them in both dispatch modes: store **offline** (served by the edge's own local handlers) and **online** (forwarded to Central). It also walks a full temp-employee lifecycle end to end.

## What's in the pack

| File | What it is |
|---|---|
| `postman/privateid-edge-regression.postman_collection.json` | The suite. Import into Postman, or run headless with Newman. |
| `postman/privateid-edge.postman_environment.json` | Environment template. Fill in the edge address, API key and store. |
| `run-regression.sh` | One-command runner (Newman). Runs both modes and writes JUnit XML for CI. |
| `guides/` | Manual test guides for the resiliency tickets the automated suite can't fully exercise (see *Not covered*). |

## Quick start

### Option A: Postman (interactive)

1. Import the collection and the environment.
2. In the environment, set `edgeBase`, `apiKey`, `storeId` and `targetEnvironment` (see *Safety*).
3. Run folder **00 Preflight** first. Read the `config-status` response before anything else (see *Before you trust a result*).
4. Run folders with the Collection Runner. Run each one twice, once with `forwardToCloud=false` and once with `true`.

### Option B: one command (headless, CI-ready)

Needs Node 18+. Newman is fetched by `npx` on first run, or set `NEWMAN` to a Newman you already have.

```bash
# Read-only. Safe against a live store.
EDGE=http://<edge-host>:8080 API_KEY=<key> STORE_ID=<store> ./run-regression.sh store

# Full regression on a UAT / non-production edge. Writes test data.
EDGE=… API_KEY=… STORE_ID=… TARGET=uat ./run-regression.sh uat

# Everything, including the destructive contract rows. Non-production only.
EDGE=… API_KEY=… STORE_ID=… TARGET=uat ./run-regression.sh full

# The edge tests itself: no requests from your side except start, poll and report.
EDGE=… API_KEY=… STORE_ID=… ./run-regression.sh selftest
```

The exit code is 0 only if every request and assertion passed. Results go to `./qa-results/<timestamp>/`, one JUnit `.xml` per run, for Jenkins, Azure DevOps or any JUnit-aware CI. `REPORT_JSON=1` adds Newman's full JSON per run. That file contains the API key in plain text, so treat it as a secret.

### Option C: nothing installed (curl only)

The edge has a built-in self-test API that runs the same tables from inside the deployed edge:

```bash
H="X-Api-Key: $KEY"; B="$EDGE/storeossecurity/v2"
RUN=$(curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"suite":"table","modes":["offline","online"],"nonDestructiveOnly":true}' "$B/self-test" | jq -r .runId)
curl -s -H "$H" "$B/self-test/$RUN" | jq '{status,passed,failed}'           # poll until status=complete
curl -s -H "$H" "$B/self-test/$RUN/report?format=html" -o self-test.html   # the report
```

The suites are `table` (read-only), `resiliency` (send `"probeIdp": false` for the read-only half), `integrity` (send `"probeWrites": false` for read-only) and `temp` (writes test data; the edge must have `SELF_TEST_ALLOW_DESTRUCTIVE=true`).

## Profiles and folders

| Folder | Writes? | Safe at a live store? | In profile |
|---|---|---|---|
| **00 Preflight**: config-status, version, health, health-idp, api-key-status | no | yes | store, uat, full |
| **01 Contract, store-safe**: every read-only client endpoint | no | yes | store, uat, full |
| **02 Contract, non-destructive extras**: predict-embedding | no | UAT only | uat, full |
| **03 Contract, WRITES**: enrol, delete, register, syncLogs, generate-barcode | **yes** | **no** | full |
| **04 Journey, temp employee end to end** | **yes** | **no** | uat, full |
| **05 Self-test API** | table, resiliency and integrity: no; temp: yes | read-only suites only | selftest |
| **99 Templates**: a starting point for your own cases | n/a | n/a | n/a |

### What a pass means

There are two kinds of check, and they make different claims.

- **Contract (01–03)** checks that the edge accepts what a real client sends. A request fails if any of these happen:
  - the route isn't mounted (Express 404);
  - the client is refused on auth (401/403);
  - a valid body is rejected by schema validation (400 "… is not allowed", "… is required" and similar).

  A business answer is *not* a failure. "Barcode data does not exist" or "Employee not found" against test data that isn't on this store means the endpoint works. This is deliberate: the barcode outage was a valid request rejected by a schema, and that's what this layer catches. Agent endpoints that send a body also get an **"api_key in body probe"** variant, which reproduces that exact outage.
- **Journey (04)** makes positive claims. It creates a fresh temp employee each run (`T` plus 9 digits, never a real associate), then:
  - authenticates the employee locally, with no IdP involved;
  - enrols a face on both models (mbfv1 and res100);
  - proves 1:1 and 1:N matches on each model resolve to the uuid it just enrolled;
  - proves each model does **not** match the other model's vector;
  - registers and scans a barcode, and checks the roster;
  - runs the SOS UI's keyless fallback (verify-credentials, generate-barcode, verify-barcode).

  Every step must return 2xx, and the run stops at the first broken prerequisite.

## Before you trust a result

1. **Read `config-status` (folder 00).** Remote config overrides the image's `.env` at runtime, and wins silently. `source` says where the live values came from, `store.edgeVersion` must be the build you mean to test, and `circuitBreaker.enabled` says whether breaker behaviour is in play.
2. **Use the right base path.** In the CVS fleet it's `/storeossecurity/v2`, which is the default. `/node/v2/storeOSAgent` is a legacy path.
3. **Use test identities.** `employeeId` for the contract rows must be a test account. The journey makes its own.

## Safety

- Folders **03** and **04** write. They refuse to run unless `targetEnvironment` is `uat`, `dev` or `local`. The template's default is `store`, so a fresh import can't write by accident. A refused request goes to an unroutable host, so nothing reaches the edge, and the run fails loudly.
- `run-regression.sh` enforces the same rule for the `uat` and `full` profiles through `TARGET`.
- Face enrolment in folder 03 only ever writes to `enrollEmployeeId`, which must be `T` plus 9 digits. The request refuses to send otherwise.
- Never commit a real API key or password into the collection or environment. Pass them at run time, as the script does.
- Newman's JSON reporter and Postman's exported run results record the environment, **including the API key**. Don't attach either to a ticket. The JUnit XML carries no headers or environment values.

## Adding your own test cases

1. **In Postman:** add requests to a folder of your own (or **99 Templates**). Every variable in the environment is available. The collection's pre-request script sets `{{profileExpiryTime}}` and `{{expireAt}}` per request. To apply the contract policy to your cases, copy folder 01's post-response script onto your folder.
2. **Keep your additions in a separate collection** (or a fork of this one). This collection is generated, and we'll send updated copies each release. Keeping your cases apart means an update never overwrites them.
3. **Cases that should run everywhere:** send them to PrivateID and we'll add them to the endpoint or journey table the collection is generated from. They then also run in our CI gate before every push, and in the edge's self-test API.

Run from the same files, CI, the self-test API and this collection can't disagree about what a client sends.

## Coverage

What this pack exercises directly:

| Area | Where |
|---|---|
| Every client-facing endpoint, both dispatch modes, both client header contracts (agent with key, SOS UI keyless) | 01–03 |
| Barcode-outage class: a closed schema rejecting `api_key` in the body | 01–03, probe variants |
| Temp-employee lifecycle: register, local auth, enrol both face models, 1:1, 1:N, cross-model negative, barcode, roster, lookup | 04 |
| SOS UI agent-down fallback (verify-credentials, generate-barcode, verify-barcode) | 01, 03, 04 |
| Build identity, effective runtime config, API key enforcement state, edge health, `/health-idp` answered locally | 00 |
| Store-68641 mass soft-delete regression (one enrolment must not soft-delete a store) | 05 integrity |
| TLSTOR-836 timeouts and TLSTOR-838 rate limit as configured in the running build | 05 resiliency |

**Not covered here.** These need fault injection or state the suite can't safely create on its own:

| Area | How it's verified today |
|---|---|
| Circuit breakers opening and recovering under real faults (TLSTOR-835/839) | `guides/qa-test-guide-835.md`, `guides/qa-test-guide-836-838.md` |
| CENTRAL_DOWN (1515) failover end to end | Needs Central's half running; `guides/qa-test-guide-837-consolidated-health.md` |
| `/health-idp` correctness in DOWN states, consolidated edge health | `guides/qa-test-guide-837-consolidated-health.md` |
| `/syncLogs` validation, excluded actions and rate limiting (the suite only checks that the route accepts a valid batch) | `guides/qa-test-guide-836-838.md` |
| `FallBackAuthWithPinEnabled` Y/N behaviour on barcode auth | Remote-config state; manual |
| Regular (non-temp) employee journey through PingFederate | Needs a synthetic identity provisioned in the IdP |
| Live resiliency probes (`probeIdp: true`): `/health-idp` reports DOWN while they run | 05 resiliency with `probeIdp: true`, on a non-production edge |

## Verified before shipping

PrivateID ran this pack, as shipped, against a real edge: a local MariaDB, with the online mode forwarded to the UAT backend. All profiles passed:

| Run | Requests | Assertions | Failed |
|---|---|---|---|
| store, offline / online | 17 / 17 | 42 / 42 | 0 |
| uat, offline / online | 38 / 38 | 77 / 76 | 0 |
| full, offline / online | 51 / 51 | 116 / 115 | 0 |
| selftest: table, resiliency, integrity | 12 | 12 | 0 |

**Negative controls (to show the checks can fail):**
- With the base path pointed at an unmounted prefix, all 12 store-safe requests failed the route check.
- With `targetEnvironment=store`, the write folders sent nothing to the edge; database row counts were unchanged before and after.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every request fails "route is mounted" | Wrong `basePath`. Use `/storeossecurity/v2`. |
| `400 Password is required for normal employees` on authenticate-credentials or verify-credentials | `password` is empty. Any non-empty value satisfies the contract check. |
| `400 Invalid Request` on delete-embedding | `uuid` is empty. The fake default is fine. |
| Journey stops at `embedding (enrol, temp)` saying credentials don't exist | The temp profile expired. `profileExpiryTime` is set per request by the collection pre-request script; make sure collection-level scripts are enabled. |
| Write folders fail on `write-guard-refused.invalid` | Working as intended: set `targetEnvironment` to `uat`, `dev` or `local`. |
| Online runs fail but offline pass | The edge can't reach Central. Check `config-status` and `/health`. |
