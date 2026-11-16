# How QA certifies TLSTOR-837 — consolidated health & edge circuit breaker reporting

storeOS 14.0 · epic TLSTOR-834 · components: `privateid-edge-component` (store, branch
`certify/storeos-14-final`) and PID Central (`privateid-cryptonets-js`). Edge base path below is
`/storeossecurity/v2`.

Every method below was confirmed against the routes actually mounted in `src/routes.js` in both
repos — not carried over from PrivateID's own internal deployment fork
(`charlie-edge-server`/`charlie-cryptonets-js`), which shares history with this codebase but is not
the same one. If you've tested against that fork before: `x-employee-id: 9999995`–`9999998` and
`POST /status-config` don't exist here — the header is silently ignored (no route reads it), not
rejected, so pointing a request at either without checking first fails quietly rather than loudly.

---

## 0. Read this first

**Ask the store what it's actually running**, before anything else:

```sh
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/config-status" | jq .
```

`.env` is only a boot default — the attributes service can override any of the values below at
runtime and wins silently. Certifying against the file instead of this endpoint certifies a build
that isn't running. Confirm `store.edgeVersion` matches the artefact under test, and check
`circuitBreaker.enabled` — it changes what several rows below can prove (see §3).

## 1. The four endpoints, what each one actually answers

| Endpoint | Answers | Drives its HTTP status from |
|---|---|---|
| Central `GET /node/health` | Liveness only. No dependency check | Always `200` |
| Central `GET {basePath}/health-idp` | IDP + Mongo, cached (5 min UP / 60 s DEGRADED; Mongo on its own 10 s TTL) | `200`, or `207` if both IDPs are down. **Never `503`** |
| Central `GET {basePath}/health` | Same underlying check as `/health-idp`, different status contract | `503` when the database is unusable, `200` otherwise |
| Edge `GET {basePath}/health` | MariaDB (live) merged with Central's cached snapshot | `503` only when MariaDB itself is down |
| Edge `GET {basePath}/health-idp` | Pure pass-through of Central's `/health-idp`, MariaDB + edge breakers merged in | Same as Central's `/health-idp` — never `503` from the edge merge itself |

Read the body's `statusCode` on any of them for the real signal regardless of HTTP status:
`1515` CENTRAL_DOWN, `1510` ALL_DOWN, `1513` PING_DOWN, `1514` SM_DOWN, `1516` EDGE_DOWN, `200` OK.

**One gating rule specific to `/health-idp` that trips people up:** its `statusCode` only carries
the real value when the request arrives with `x-edge-forwarded: true`. Call it directly and it is
unconditionally `1516`, whatever Central's actual state is.

```sh
# Direct — statusCode is 1516 no matter what, this is expected
curl -sk "$CENTRAL/node/health-idp" | jq .statusCode

# Through the edge — the edge sets x-edge-forwarded itself when it relays, so this carries the real code
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/health-idp" | jq .statusCode
```

## 2. Verify the edge merge — safe on any deployed environment

Nothing here writes data or holds a connection open; safe against shared or production stores.

**2a. `{basePath}/health` reports MariaDB and Central's cached snapshot, not nulls**

```sh
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/health" | jq .
```

Pass looks like: `dependencies.mariaDb` present (`"UP"` on a healthy store), `circuitBreakers`,
`allServicesDown`, `centralDegraded`, `checkedAt` all populated — not `null` — once the store has
been up longer than one poll interval (`CONNECTIVITY_CHECK_INTERVAL`, 30 s by default; see §4 to
check or change it). `null` on a store that's been running for minutes is a real defect, not
expected behavior — it was never designed to stay null.

**2b. `{basePath}/health-idp` carries the edge's own fields merged onto Central's relayed body**

```sh
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/health-idp" | jq '{dependencies, edgeCircuitBreakers, statusCode}'
```

Pass looks like: `dependencies.mariaDb` present alongside Central's own `smService`/`pingService`/
`mongoDb` keys, and `edgeCircuitBreakers` present as its own top-level object — separate from
Central's `circuitBreakers`, never merged into it (both name breakers `ping-service`/
`siteminder-service` for their own respective outbound calls; a merge would let one silently
overwrite the other under an identical key).

**2c. The two edge endpoints agree with each other on the edge-owned fields**

Fetch both back to back and diff `dependencies.mariaDb` and `edgeCircuitBreakers` — they read the
same two live sources on every call, so they should never disagree at the same moment.

## 3. Verify `edgeCircuitBreakers` is null exactly when the breaker is disabled

`edgeCircuitBreakers` is `null` **only** when `CircuitBreakerManager.isEnabled()` is false — a
different fact from "enabled, nothing open," which reports populated breakers all `CLOSED`.
Collapsing the two would make a store where the breaker never runs at all look identical to one
running healthy.

```sh
# 1 — confirm current state
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/config-status" | jq .circuitBreaker.enabled

# 2 — flip it, runtime, no restart (reverts at the next scheduled reload)
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerEnabled":"N"}'

# 3 — confirm the effect
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/health" | jq .edgeCircuitBreakers
# expect: null

curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"CircuitBreakerEnabled":"Y"}'

curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/health" | jq .edgeCircuitBreakers
# expect: an object, one entry per known service, each CLOSED/OPEN/HALF_OPEN
```

`loadRemoteConfig`'s body is merged over the whole fetched attribute set — send every attribute
you want kept in the same call, same caveat as every other lever in this repo.

You can also read and reset breakers directly, without going through health at all:

```sh
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/circuit-breaker/status" | jq .
curl -sk -X PUT -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/circuit-breaker/reset-all"
```

## 4. Verify the poll interval and cache TTLs are live-changeable

**4a. Connectivity poll interval** (`ConnectivityCheckIntervalMs`, default 30 000 ms, bounded
5 000–300 000). Requires `REMOTE_CONFIG_REQUEST_CONNECTIVITY_INTERVAL=true` to be set on this
store for the attributes-service channel to apply it — Channel 1 (`loadRemoteConfig`) works either
way as the direct test lever.

```sh
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"ConnectivityCheckIntervalMs":"5000"}'

curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/config-status" | jq '.timeouts | select(.connectivityCheckIntervalMs != null)'
```

Pass looks like: `config-status` reports the new value, its boot default, and that it's overridden.
Corroborate live by watching `checkedAt` on `{basePath}/health` advance roughly every 5 s instead
of every 30 s.

**Trap:** an out-of-range value (`<5000` or `>300000`) is *dropped*, not clamped — the store keeps
the previous value and logs `Ignoring out-of-range ConnectivityCheckIntervalMs`. If the interval
doesn't change, check the log before assuming the POST failed.

**4b. Health cache TTLs** (`HealthCacheTtlUpMs`/`HealthCacheTtlDegradedMs`, defaults 300 000 / 
60 000). This is what governs how long `{basePath}/health-idp`'s pass-through reuses a cached
Central response instead of forwarding fresh.

```sh
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"HealthCacheTtlUpMs":"10000","HealthCacheTtlDegradedMs":"5000"}'

curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/config-status" | jq '.timeouts | select(.healthCacheTtlUpMs != null)'
```

Pass looks like: `config-status` reflects the new values. This is also the regression check for
the bug fixed alongside this lever — before the fix, a remote change here silently did nothing
because the values had been captured into a module-level const at import time; confirming the
change takes effect at all is confirming that fix, not just the lever.

## 5. A real Central database problem, end to end — lab only

Layer 1 (config-only) checks above prove the wiring exists. This proves it reports a genuine
failure correctly, all the way through both edge endpoints.

Use the Docker drill already documented in `docs/mongo-resilience-summary.md` and referenced in
`docs/qa-test-guide-836-838.md` §7c — stand up a throwaway MongoDB, point a **lab** Central at it,
then `docker pause` or `docker update --cpus 0.05` to simulate the 2026-07-29 shape (fully frozen,
or slow-not-dead). **Never against a shared or production database** — this manufactures the exact
incident it exists to certify.

While the drill runs, poll all four endpoints and confirm they agree:

```sh
watch -n2 'echo "--- central /health ---"; curl -sk "$CENTRAL_LAB/storeossecurity/v2/health" | jq "{status,statusCode,centralDegraded}";
echo "--- central /health-idp ---"; curl -sk -H "x-edge-forwarded: true" "$CENTRAL_LAB/storeossecurity/v2/health-idp" | jq "{status,statusCode,centralDegraded}";
echo "--- edge /health ---"; curl -sk -H "x-api-key: $KEY" "$EDGE_LAB/storeossecurity/v2/health" | jq "{status,statusCode,centralDegraded,circuitBreakers}";
echo "--- edge /health-idp ---"; curl -sk -H "x-api-key: $KEY" "$EDGE_LAB/storeossecurity/v2/health-idp" | jq "{status,statusCode,centralDegraded,circuitBreakers}"'
```

Pass looks like:

- Central `/health` flips to `503` / `statusCode:1515` / `centralDegraded:true` within seconds.
- Central `/health-idp` (called with `x-edge-forwarded:true`, matching how the edge actually calls
  it) reports the same body-level `1515`/`centralDegraded:true`, but stays on `200`/`207` — the
  known, deliberate HTTP-status inconsistency between the two, not a bug.
- Edge `/health` picks up the same `centralDegraded:true`/`1515` within one poll interval of
  Central flipping (up to `CONNECTIVITY_CHECK_INTERVAL`, tighten it via §4a first if you don't want
  to wait 30 s). Edge's own HTTP status stays `200` — MariaDB is fine, this store is degraded, not
  unable, and demoting it to `503` would pull a still-useful store out of rotation.
- Edge `/health-idp` reflects the same `1515`/`centralDegraded:true` immediately (checked fresh
  every call, not cached the same way).
- After `docker unpause` (or removing the CPU limit), all four recover to `UP`/`200`/`false` on
  their own within roughly 30–60 s — nobody restarts anything.

## 6. MariaDB down on the edge — lab only, restart required

`DATABASE_URL` is a boot-time value (Channel 3 only, no remote lever). To test:

1. Point a **lab** edge's `DATABASE_URL` at an unreachable host and restart it — do not do this
   against a store with real traffic; every route behind `checkDatabaseAvailability` refuses
   during this window, not just health.
2. Poll both edge endpoints.

Pass looks like:

- `{basePath}/health`: `503`, `ready:false`, `statusCode:1516`, `dependencies.mariaDb:"DOWN"`.
- `{basePath}/health-idp`: HTTP status **unchanged** from whatever Central would otherwise report
  (the merge doesn't touch it), but body `statusCode` forced to `1516` regardless of Central's own
  code, and `dependencies.mariaDb:"DOWN"` present — this is how you tell this `1516` apart from
  Central's own no-header `1516` case, which never carries a `mariaDb` key at all.

## 7. What this doesn't prove

- **Fleet-scale behavior.** Every check here is one store, one Central instance. It doesn't
  characterize ~10,000 stores polling at once.
- **That 30 s / 5 min / 60 s are the right numbers for production.** They're now tunable per store
  without a rebuild specifically so that question can be answered from real observed timing later,
  not guessed at now.
- **TLSTOR-950.** The store agent's own read of these endpoints is a separate ticket; nothing here
  certifies that the agent acts correctly on what it receives.

---
Source of record: `docs/tlstor-837-brief.md`, `docs/tlstor-834-pending-items.md`, and the routes
actually mounted in `src/routes.js` in both repos as of `certify/storeos-14-final`
(privateid-edge-component) — verified directly against source, not carried over from a sibling
codebase. Every endpoint and config key name here was grepped and read, not assumed.
