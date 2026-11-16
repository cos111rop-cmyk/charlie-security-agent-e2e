# How QA validates TLSTOR-835: a separate circuit breaker per API

Epic TLSTOR-834 · storeOS 14.0 · Manual test guide (Postman / curl plus the register agent)

**What is being tested.** Associate login (`/authenticate/credentials`) now has its own circuit
breaker, `authenticate-credentials-service`, separate from the shared `backend-service` breaker that
covers face match, barcode, enrollment and other forwarded traffic. That gives the store two
outage modes:

| What is down | What the store must do |
|---|---|
| **Only the login services** (PingFederate and Siteminder, as Central sees them) | Only login changes route. The store logs the associate in by calling PingFederate and Siteminder itself. Face match, barcode and everything else keep going through Central |
| **Central itself** (unreachable, or MongoDB unusable: code 1515; this guide tests the unreachable case) | The store serves everything locally |

Everything below can be done by hand. The edge is changed at runtime over HTTP. Central dev is
changed through environment variables plus a container restart.

---

## 0. Environment

```sh
export EDGE=https://t68641app.stores.cvs.com:1443/storeossecurity/v2
export CENTRAL=https://internal-non-prod.rtl-qa-instoreexp.cvshealth.com/dev/node/v2/storeOsAgent
export KEY='<edge API key for this store>'
export STORE=68641            # confirm against store.storeId in config-status (§2)
export WS='<workstation name of the lab register>'
```

`-k` is used in the commands below because the store certificate is issued by an internal CA. If
you have that CA bundle, use `--cacert <bundle>` instead.

All edge calls send the same headers the agent sends. Postman users can copy them as-is:

```
x-api-key: $KEY
x-api-version: v2
X-Workstation-Name: $WS
X-Correlation-ID: qa-835-<something unique per call>
Content-Type: application/json
```

**Who sends what**
- **The register agent** is the source of truth for anything a cashier does: login, face match,
  barcode. Use it for every "the associate can still work" check.
- **Postman/curl** is for the admin and read calls (`config-status`, `circuit-breaker/*`, `health`,
  `loadRemoteConfig`) and for quickly sending the 6 or more logins needed to trip the breaker.
- Don't rely on the old shared Postman collection. It has drifted from what the agent sends, and it
  contains real credentials. Build the requests from this page.

---

## 1. Preconditions. Check every one; each can invalidate the whole run

| # | Precondition | How to check |
|---|---|---|
| P1 | Central dev is built from **`fix-separate-rate-limiters`**, not `develop` | `curl -sk "$CENTRAL/health"`: the body must contain `statusCode`, `ready`, `dependencies`. A body with only `status`/`uptime` is a `develop` build, and scenario B step 3 cannot be read |
| P2 | The edge forwards to Central dev | §2 read calls, plus the Central container log shows the edge's requests arriving. The cloud URL must end in `/node/v2/storeOsAgent`, or every forwarded call returns 404 |
| P3 | The circuit breaker is **on** at the edge | `GET $EDGE/circuit-breaker/status` returns `enabled: true` and lists `authenticate-credentials-service` |
| P4 | **The edge container can reach PingFederate and Siteminder itself** | A normal login works (§3 A0). The fallback is the store calling the login services directly; if the edge host has no route to them, scenario B fails, and that is an environment problem, not a code defect |
| P5 | Face/barcode tests use a **normal enrolled associate**, not a temp-registration one | Central changes temp-registration behaviour when both login services are down, which would muddy the isolation result |
| P6 | Nobody else is using Central dev during scenarios B and C, or this store during B–E | B and C restart Central; B–E send the store into fallback |

---

## 2. Read calls. Use these after every step

```sh
# Which breakers exist, and their state (CLOSED / OPEN / HALF_OPEN)
curl -sk "$EDGE/circuit-breaker/status" -H "x-api-key: $KEY" -H "X-Correlation-ID: qa-835-status"

# Effective settings: circuitBreaker.blocks, minRequests, timeWindowMs, where values came from
curl -sk "$EDGE/config-status" -H "x-api-key: $KEY"

# Edge health, including its cached view of Central and edgeCircuitBreakers
curl -sk "$EDGE/health" -H "x-api-key: $KEY"

# Central's own readiness: statusCode 200 / 1510 ALL_DOWN / 1513 PING_DOWN / 1514 SM_DOWN / 1515 CENTRAL_DOWN
curl -sk "$CENTRAL/health"
```

Reset all edge breakers to CLOSED (do this at the start of each scenario):

```sh
curl -sk -X PUT "$EDGE/circuit-breaker/reset-all" -H "x-api-key: $KEY"
# or just one:
curl -sk -X PUT "$EDGE/circuit-breaker/reset/authenticate-credentials-service" -H "x-api-key: $KEY"
```

**Edge log lines to look for:**

| Line | Meaning |
|---|---|
| `metrics:local-fallback` with `reason: backend-503` | Central said it couldn't serve, so the edge answered locally |
| `metrics:local-fallback` with `reason: backend-unreachable-…` | Central didn't answer at all, so the edge answered locally |
| `Applied circuit breaker global.<key> from remote config` | A `CircuitBreakerConfig` change was applied |
| `Applied circuit breaker block '<name>' from remote config` | A per-API breaker was added or retuned |
| `Cloud reachable but central reports CENTRAL_DOWN (1515)` | The store switched to fully local mode |

---

## 3. Scenarios

### A0. Baseline login (run first, and again whenever in doubt)

```sh
curl -sk -X POST "$EDGE/authenticate/credentials" \
  -H "x-api-key: $KEY" -H "x-api-version: v2" -H "X-Workstation-Name: $WS" \
  -H "X-Correlation-ID: qa-835-a0" -H "Content-Type: application/json" \
  -d '{"employeeId":"<test associate id>","password":"<password>","store_id":"'"$STORE"'","is_login_operation":true}'
```

Pass: 200 with the associate's profile, and the Central log shows the request. Then repeat from the
real register.

### A. Settings (no outage needed; safe)

**A1. Only login has its own breaker**

`GET $EDGE/config-status` → `circuitBreaker.blocks`:

- exactly one entry, `authenticate-credentials-service`
- `routes: ["/authenticate/credentials"]`, `minRequests: 5`, `batch: true`
- **no** `backend-sync-service`, and **no** `syncBlock` key (`/syncLogs` uses the shared breaker)

`GET $EDGE/circuit-breaker/status` lists five breakers: `backend-service`,
`authenticate-credentials-service`, `config-service`, `ping-service`, `siteminder-service`.

**A2. Remote settings are merged, not replaced**

```sh
curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerConfig":{"global":{"minRequests":7}}}'
```

Pass: `config-status` shows `circuitBreaker.minRequests: 7`, and `authenticate-credentials-service`
is still present and unchanged. The log shows `Applied circuit breaker global.minRequests`.

**A3. Retune just the login breaker**

```sh
curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerConfig":{"blocks":{"authenticate-credentials-service":{"minRequests":4}}}}'
```

Pass: only that block's `minRequests` changes to 4. The global value is untouched.

**A4. A bad value is reported, not applied**

```sh
curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerConfig":"not json"}'
```

Pass: the response contains `circuitBreakerConfigWarnings`, and `config-status` is unchanged.

**A5. Empty / `NOT_FOUND` is ignored**

```sh
curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerConfig":"NOT_FOUND"}'
```

Pass: no change, no warning, and the store does **not** revert to defaults.

**A6. Production path: attributes service (needs CVS)**

Ask CVS to set `CircuitBreakerConfig` for store 68641 to a recognisable value, e.g.
`{"global":{"minRequests":6},"blocks":{"authenticate-credentials-service":{"minRequests":4}}}`.
Wait for the scheduled reload (or restart the edge). Pass: `config-status` shows 6 and 4.

**A7. Per-store off switch (needs CVS)**

Ask CVS to set `RequestCircuitBreakerConfig` = `N` for store 68641, wait one scheduled reload, then
change `CircuitBreakerConfig` and wait for another. Pass: the change does **not** reach
`config-status`. Set it back to `Y` afterwards.

> `loadRemoteConfig` notes: the body is merged over the attributes-service answer, and it is **not
> durable**. The next scheduled reload restores the attributes-service values. After A2–A5, either
> wait for that reload or send the defaults back (§4).

---

### B. Login services down at Central only: the main 835 test

**Important:** Central only returns 503 when **both** PingFederate and Siteminder are unreachable.
If only one is down, Central fills in a fallback response and returns 200, so the edge sees nothing
and its breaker never moves. **Break both.**

1. **Make recovery testable first.** The breaker otherwise stays OPEN for 10 minutes. Set this
   **before** tripping it, because changing settings rebuilds the breakers:

   ```sh
   curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
     -d '{"CircuitBreakerConfig":{"global":{"resetTimeout":60000}}}'
   curl -sk -X PUT "$EDGE/circuit-breaker/reset-all" -H "x-api-key: $KEY"
   ```

2. **Central dev:** set these env vars and restart the container:

   ```
   SITEMINDER_URL=http://127.0.0.1:9
   pingEnv=http://127.0.0.1:9
   ```

   Port 9 inside the container refuses the connection immediately. That is what we want here:
   fast, unambiguous "unreachable". Note the current values first so you can restore them.

3. **Confirm Central's state:** `curl -sk "$CENTRAL/health"` → HTTP **200**, `statusCode: 1510`
   (ALL_DOWN), `centralDegraded: false`. It must **not** be 1515. A 1515 means Central dev's own
   MongoDB is unhealthy, which sends the whole store local and invalidates this scenario. Stop and
   get Central dev healthy before continuing.

4. **Trip the login breaker.** Send 6 logins within 2 minutes (the breaker needs at least 5
   requests, 80% of them failing, inside a 120 s window):

   ```sh
   for i in 1 2 3 4 5 6; do
     curl -sk -o /dev/null -w "login $i -> %{http_code} in %{time_total}s\n" \
       -X POST "$EDGE/authenticate/credentials" \
       -H "x-api-key: $KEY" -H "x-api-version: v2" -H "X-Workstation-Name: $WS" \
       -H "X-Correlation-ID: qa-835-b-$i" -H "Content-Type: application/json" \
       -d '{"employeeId":"<test associate id>","password":"<password>","store_id":"'"$STORE"'","is_login_operation":true}'
   done
   ```

   **Pass: every login returns 200.** The edge log shows `metrics:local-fallback` /
   `reason: backend-503` for each one. The associate is logged in by the store's own call to the
   login services, even before the breaker opens.

5. `GET $EDGE/circuit-breaker/status`:
   - `authenticate-credentials-service` → **OPEN**
   - `backend-service` → **CLOSED** ← the isolation check. If this is OPEN, it's a defect: login
     failures are leaking into the shared breaker.

6. **From the real register:**
   - log in → succeeds
   - face match and barcode → succeed, and the **Central log shows those requests**. They must be
     forwarded to Central, not served locally.

7. Log in a few more times → still 200, and the **Central log shows no new
   `/authenticate/credentials` requests**. The open breaker sends logins straight to the local
   path.

### C. Recovery

1. Central dev: restore the original `SITEMINDER_URL` and `pingEnv`, then restart.
2. `curl -sk "$CENTRAL/health"` → `statusCode: 200`.
3. Wait at least 60 s (the `resetTimeout` from B1), then log in from the register.
4. Pass: the breaker goes `HALF_OPEN` and then `CLOSED` over the next few logins. Logins appear in
   the Central log again.

### D. Central down: the store goes fully local

This is an edge-only change; Central is not touched. Point the edge at an address where nothing is
listening, which to the store looks exactly like Central being down:

```sh
curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CloudBaseUrl":"https://127.0.0.1:9/node/v2/storeOsAgent"}'
```

Then, within about 30 s (one edge health poll):

- `GET $EDGE/health` shows Central as unreachable
- the edge log shows `metrics:local-fallback` with `reason: backend-unreachable-…`
- **from the register: login, face match and barcode all succeed**, served by the edge itself
- nothing reaches Central

Restore: send the original `CloudBaseUrl`, or wait for the next scheduled reload, which restores it
from the attributes service. Confirm traffic reaches Central again.

> **Not covered here: "Central up, MongoDB down" (code 1515).** Producing it needs Central's MongoDB
> connection broken, which QA can't change on Central dev. The store's handling of 1515 is covered
> by the edge's automated tests and by the TLSTOR-837 release. The difference from this scenario is
> only *how* the store learns Central is unusable (a 1515 answer instead of no answer). The result
> is the same: everything goes local.

**B together with D is the two-mode proof:** login down means only login reroutes; Central down
means everything goes local.

### E. A wrong password is still rejected during an outage (security check)

During scenario B (breaker OPEN), log in with a **wrong password**, from curl and from the register.

**Pass: the login is rejected.** The store's own call to PingFederate/Siteminder refuses it. **If a
wrong password is ever accepted, stop and report it as a release blocker.**

Also during normal operation (no outage): a wrong password returns a 4xx, and
`authenticate-credentials-service` does **not** count it as a failure. Ten wrong passwords in a row
must not open the breaker.

---

## 4. Put everything back

```sh
# Edge: restore the default breaker settings (same as what ships)
curl -sk -X POST "$EDGE/loadRemoteConfig" -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerConfig":{"global":{"failureThreshold":0.3,"openThreshold":0.8,"successThreshold":0.7,"halfOpenSuccessThreshold":0.7,"openToClosedSuccessThreshold":0.8,"openToHalfOpenSuccessThreshold":0.5,"timeWindow":120000,"minRequests":5,"testRequestPercentage":0.3,"resetTimeout":600000,"timeout":20000},"blocks":{"authenticate-credentials-service":{"envPrefix":"CB_AUTHENTICATE_CREDENTIALS","routes":["/authenticate/credentials"],"minRequests":5,"batch":true}}}}'
curl -sk -X PUT "$EDGE/circuit-breaker/reset-all" -H "x-api-key: $KEY"
```

- Central dev: original `SITEMINDER_URL` and `pingEnv`, then restart.
- Edge: original `CloudBaseUrl` if scenario D was run.
- If CVS changed attributes for A6/A7: `CircuitBreakerConfig` back to the value above (it must
  **not** contain `backend-sync-service`), and `RequestCircuitBreakerConfig` back to `Y`.
- `loadRemoteConfig` changes also revert on their own at the next scheduled reload, but Central's
  env changes don't.

---

## 5. Results sheet

| # | Check | Pass criteria | Result | Evidence (correlation ID / screenshot) |
|---|---|---|---|---|
| A1 | Only login has its own breaker | one block, `batch:true`, no sync block | | |
| A2 | Merge, not replace | global 7, block unchanged | | |
| A3 | Per-block tuning | only the block changes | | |
| A4 | Bad value rejected | warning returned, no change | | |
| A5 | `NOT_FOUND` ignored | no change, no warning | | |
| A6 | Attributes service applied | 6 / 4 in config-status | | |
| A7 | `RequestCircuitBreakerConfig=N` honoured | change not applied | | |
| B4 | Logins succeed while Central's login services are down | all 200, `backend-503` fallback in the log | | |
| B5 | Isolation | login breaker OPEN, `backend-service` CLOSED | | |
| B6 | Other traffic unaffected | face/barcode via Central succeed | | |
| B7 | Open breaker skips Central | no new login requests at Central | | |
| C | Recovery | HALF_OPEN → CLOSED, logins back at Central | | |
| D | Central unreachable → fully local | login/face/barcode succeed locally | | |
| E | Wrong password rejected during outage | rejected; 4xx doesn't trip the breaker | | |

---

## 6. Two questions for CVS, not QA

1. The breaker trips on a failure **rate** (80% once 5 requests have been seen, i.e. 4 of 5), not
   on a fixed failure count. Does that match the ticket's intent?
2. The four built-in breakers (`backend-service`, `config-service`, `ping-service`,
   `siteminder-service`) share one set of settings. Only per-API breakers such as the login one can
   be tuned on their own. Is that acceptable?

---
Epic TLSTOR-834 · Ticket TLSTOR-835 · Prepared by PrivateID Engineering.
