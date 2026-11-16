# How QA certifies TLSTOR-836 and TLSTOR-838

storeOS 14.0 · epic TLSTOR-834 · components: `privateid-edge-component` and PID Central
(`privateid-cryptonets-js`). Edge base path below is `/storeossecurity/v2`.

Everything here runs against a **deployed build in the lab**. Nothing needs a source checkout except
the two verification scripts, and both ship inside the image at `/app/scripts`.

---

## 0. Read this first — three preconditions

Each of these has silently invalidated a run before.

**1. Ask the store what it is actually running.**

```sh
curl -sk -H "x-api-key: $KEY" "$EDGE/storeossecurity/v2/config-status" | jq .
```

Read `source` first. **`.env` is only a boot default.** Where an attribute is provisioned, the
attributes service overrides the file at runtime and wins silently — that is how the circuit breaker
came to be off on a store where every config file said `true`. Certifying against the file instead of
this endpoint certifies a build that is not running.

**2. Check the build identity.** `config-status` reports `store.edgeVersion`; it must match the
artefact under test. For anything MongoDB-related the same applies to Central — see §3.

**3. Know which way the circuit breaker is set.** `circuitBreaker.enabled` in the same response. It
changes what the IdP timing test can prove — see §1.

---

## The short answer — one call covers both tickets

The deployed build certifies itself. One suite covers the 836 timeouts and the 838 limiter from
inside the artefact you deployed.

```sh
# start the run — returns 202 {"runId": "..."}
curl -sk -X POST "$EDGE/storeossecurity/v2/self-test" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"suite":"resiliency"}'

# pull the report — json | txt | html
curl -sk -H "x-api-key: $KEY" \
  "$EDGE/storeossecurity/v2/self-test/$RUNID/report?format=html" \
  -o edge-resiliency-report.html
```

14 checks. Rows are named `836 config:` (what this build loaded), `836 live:` (what it measured) and
`838:` (the limiter). It reports the configured bound, then **measures** it — the point being that the
original defect was a timeout that existed in configuration and was never passed down to the call.
Only a measurement separates those two states.

**Side effect:** for the length of one timeout per probe this edge believes its Siteminder — then its
PingFederate — is unreachable, so a concurrent `/health-idp` reports that dependency DOWN. The suite
restores the setting afterwards. `{"suite":"resiliency","probeIdp":false}` runs the read-only half.

Read **COULD NOT RUN** as distinct from PASS and from FAIL. A probe that could not establish its
precondition reports as not-run, never as a pass.

For the whole evidence pack rather than these two tickets:
`node scripts/certify-release.js --base $EDGE --path $BASE --configure --l3`.
**`--configure` is not optional in a client environment** — the two over-HTTP probes need opposite
rate-limiter states, and without it the runner declines to run them.

---

## 1. TLSTOR-836 — PingFederate and Siteminder

Your instinct is right, you change the IdP URL. One refinement is the difference between a real test
and a green result that proves nothing.

**Do not** point the URL at a host that does not exist. DNS failure or connection-refused comes back
in milliseconds — that exercises the error path, not the timeout, and an *unbounded* build passes it
too.

You need a **blackhole**: something that accepts the TCP connection and never answers. On any host the
edge can reach:

```sh
nc -l 9099          # leave it running; it accepts and says nothing
```

Repoint the IdP at it. Both attributes are runtime-changeable — no restart, no redeploy:

```sh
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"SiteMinderSSOUrl":"http://<blackhole>:9099",
       "PingBaseUrl":"http://<blackhole>:9099"}'
```

Two catches on `loadRemoteConfig`:

- The body is **merged over the whole fetched attribute set**, so send every attribute you want kept in
  the same call — anything omitted reverts to the attributes service's answer.
- It is **not durable**. The next scheduled reload undoes it. Convenient here (it cleans up after
  itself), but it is a testing lever, not configuration.

Now make one authentication call and time it.

- **Pass:** the call is abandoned at the applied bound — see the note below on why that is not simply
  10 s. Corroborate in the log rather than trusting the stopwatch; the service writes its own line,
  timed on its own clock: `Siteminder Refresh API call failed in 10005 ms`.
- **Fail:** the request hangs until something upstream gives up. That was the shipped behaviour before
  this ticket.

**The number to expect is not the number in the config.** The bound handed to axios is
`calculateAxiosTimeout(0.9, IDP_REQUEST_TIMEOUT_MS)`, and it depends on the breaker:

| Circuit breaker | Applied bound | At the shipped defaults |
|---|---|---|
| Disabled (shipped default) | `IDP_REQUEST_TIMEOUT_MS x 0.9` | **9 s**, not 10 |
| Enabled | `min(CB_TIMEOUT x 0.9, IDP_REQUEST_TIMEOUT_MS)` | 10 s |

Axios must fail before the breaker or the error arrives as `CircuitBreakerTimeoutError`, which is
indistinguishable from a backend failure at the point where it is counted. That is what the 0.9 buys.
The resiliency report prints the expected bound it used alongside the measured one, so read that
rather than computing it.

**Precondition 3 matters here.** With the circuit breaker **enabled**, the breaker's own timer abandons
a hung call even if no axios bound was ever set — so the probe cannot distinguish a bounded call from
an unbounded one and a pass means nothing. The shipped default is *disabled*, which is where the result
is conclusive. The self-test report states which state it ran under; read that line first.

Why this was missed originally: **a circuit breaker is not a timeout.** All five newly-bounded calls
were already wrapped in one, which looks like a time limit and is not — it ships disabled, and when
disabled it passes the call straight through.

**The value:** `IDP_REQUEST_TIMEOUT_MS`, default 10 000 ms, in **both** edge and Central. Restart
required; it is not a remote attribute. Do not tighten it on a hunch — Siteminder on store 68522 has
been observed at 272 ms, 433 ms, 2 233 ms and **6 348 ms** against that bound. Note also a PingFederate
login is a **four-call sequence**, so 10 s bounds one call, not the whole exchange.

---

## 2. TLSTOR-836 — MariaDB (edge)

Not environment variables. Query parameters on the connection URL, and the code only supplies a default
when the parameter is absent — so anything set explicitly in `DATABASE_URL` wins. Restart required.

| Parameter | Default | Why |
|---|---|---|
| `connection_limit` | 5 | INC0010990591 — idle edge sessions exhausted the server and took POS registers down. Also settable with `DB_POOL_MAX` |
| `connect_timeout` | 5 s | |
| `pool_timeout` | 20 s | The one that matters. At `0`, Prisma waits forever for a free connection |
| `socket_timeout` | 60 s | |

Two rows in the resiliency suite, and the second is the one to care about.

**Row 1 — `836 config: MariaDB carries its pool and timeout parameters`.** Necessary but weak on its
own, and the suite says so: **Prisma silently drops anything it does not recognise**, so a typo or a
parameter removed in a newer Prisma would still pass this.

**Row 2 — `836 live: MariaDB refuses callers at pool_timeout`.** The suite opens *its own* Prisma
client against the same database with a pool of one and a 1 s bound, holds the single connection with
`SELECT SLEEP(2)`, and races two more queries at it.

- **Pass:** the contenders are **refused** with Prisma `P2024` — "timed out fetching a new connection
  from the connection pool". Corroborating log line: `836 probe: MariaDB pool bound`, correlation ID
  `resiliency-probe`.
- **Fail:** nobody is refused — the pool queued them instead of failing them. That is the
  INC0010990591 shape: requests wait rather than fail, so nothing throws, so nothing downstream can
  react.

**Do not** test this by opening 5+ connections to exhaust the store's real pool. That reproduces
INC0010990591 on working registers — the store database is shared with other StoreOS schemas. The probe
uses a pool of *one* on its own client; the application's pool is never touched, nothing is written, no
table is read, and the cost is one extra connection held for about two seconds.

If `DATABASE_URL` is not `mysql://`, or the database is unreachable, the row reports **skipped** with
the reason — a fact about the environment, not a verdict on the build.

---

## 3. TLSTOR-836 — MongoDB (Central only)

**There is no MongoDB on the edge.** Mongo is PID Central's database, so this half is tested against a
deployed Central instance, not against a store. Central has its own admin self-test:

```sh
curl -s -X POST "$CENTRAL/node/admin/self-test" \
  -H "x-api-key: $CENTRAL_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"scenarios":["timeouts","mongoWaitQueue"]}'
```

Runs synchronously and returns the whole run. Two scenarios, two halves of one claim.

### `timeouts` — the values this process loaded, and that they nest

Reports what the running instance actually has, then asserts the ordering. Each timer must fire inside
the next one out, so a stall surfaces at the innermost layer that can describe it rather than as a
socket hang:

```
Mongo wait queue   2s
 < maxTimeMS       4s
  < server select  5s
   < connect      10s
    < Mongo socket 15s
     < Mongo CB    20s
      < Central -> CryptoNets  25s
       < Edge -> cloud (axios) 27s
        < Edge breaker         30s
```

All `MONGO_*` and `CB_MONGO_*` values are environment variables on Central and need a restart.
`waitQueueTimeoutMS` was previously **unset**, which the driver treats as "wait forever" — that is the
2026-07-29 incident in one line.

### `mongoWaitQueue` — the driver honours the setting

Opens its *own* client with `maxPoolSize: 1` and `waitQueueTimeoutMS: 1`, warms the pool, then races
five concurrent `ping`s through it.

- **Pass:** four of the five are **rejected** with `MongoWaitQueueTimeoutError`. One connection, five
  callers — four must lose the race and be refused rather than queued.
- **Why 1 ms and not the shipped 2 000 ms:** the claim is that the setting is *honoured*, and 1 ms
  proves that in milliseconds instead of holding connections open for two seconds. That the running
  process loaded 2 000 is the `timeouts` scenario's job. The two together are the whole claim.

Safe on a shared instance: read-only `ping`, the app's pool untouched, one extra connection for a few
milliseconds. What is **not** safe is the obvious manual version — saturating the real pool
manufactures the exact incident this exists to certify, on someone else's environment.

**Check the Central build first.** Confirm the instance carries the timeout work (merged as PR #117).
If `timeouts` reports no wait-queue value, or a 45 s socket, you are on an older Central and every
result after that is meaningless. **Neither half of TLSTOR-836 delivers the ticket alone** — the edge
can be perfect while Central is unbounded.

**Central's other integrations.** Central → PingFederate and Central → Siteminder use the same
`IDP_REQUEST_TIMEOUT_MS` (10 s) and the same blackhole method as §1. Central → CryptoNets core is
`PI_SERVER_REQUEST_TIMEOUT_MS`, 25 s, set **deliberately below** the edge's effective 27 s so Central
gives up first and the edge receives a classifiable error instead of timing out on an open socket.

---

## 4. TLSTOR-838 — the sync-log rate limit

**Before you start, two things.**

- **The limiter ships switched off.** Run the live verification without enabling it and every batch
  comes back 2xx, nothing is refused, and the run proves nothing. This is the likeliest way to waste an
  afternoon on this ticket.
- **Lab store only, never production.** A refused batch is *lost*: the StoreOS agent derives success
  from the transport rather than the HTTP status, ignores `Retry-After`, and deletes the records it was
  holding unconditionally. That loss is accepted by direction, but it is not something to inflict on a
  live store for a test.

### Layer 1 — inside the deployed build, no traffic to Central

Already covered by the `resiliency` suite above. Six rows:

| Row | What it establishes |
|---|---|
| `838: the limiter is present in this build` | Reports the live rate, burst and concurrency, and whether it is in force on *this* store. Off is not a defect; missing from the build is |
| `838: auth routes are outside the limiter's scope` | **The one that matters most.** `syncLogs` in scope; `predict-embedding` and `authenticate-barcode` out of it. Asserted on every run whatever the limiter's state |
| `838: allows the configured burst` | Batches within the allowance are forwarded |
| `838: refuses past the burst, with a retry interval` | Refusal carries a `Retry-After` of at least 1 s |
| `838: the concurrency cap holds and then frees` | A leaked slot turns the limiter into a permanent outage, so it is its own row |
| `838: no slots left in flight afterwards` | Same failure mode, checked after the fact |

The last four run **only when the limiter is off**. With it in force the suite deliberately leaves the
live bucket alone rather than resetting token state belonging to real traffic, and points at Layer 2.

### Layer 2 — live, over HTTP. This is the acceptance evidence

The unit tests prove the limiter's arithmetic. The contract sweep sends one request per scenario so it
never reaches a limit, and the journey posts no sync batches. None of them shows what a real caller
sees. This does.

```sh
# 1 — turn it on. Runtime, no restart, reverts at the next reload
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"SyncRateLimitEnabled":"Y","SyncRateLimitPerMinute":"60",
       "SyncRateLimitBurst":"20","SyncMaxConcurrent":"2"}'

# 2 — run it. The script is in the image at /app/scripts
EDGE_API_KEY=$KEY node /app/scripts/verify-sync-rate-limit.js \
  --base "$EDGE" --out syncLogs-rate-limit-evidence.txt

# 3 — turn it back off
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"SyncRateLimitEnabled":"N"}'
```

It posts 30 batches back to back, probes authentication, then waits out the advertised interval and
re-sends. Five checks, exit 0 on a clean pass, and it writes the transcript you attach to the sign-off.

| Check | Expected |
|---|---|
| Batches that pass the limiter are accepted by Central | 2xx, roughly the first 20 |
| The limiter engages before the run completes | 429 for the rest |
| Every 429 carries a `Retry-After` of at least 1 s | header present, >= 1 |
| **Authentication is not rate limited while sync is** | any status *except* 429 |
| A batch re-sent after `Retry-After` is accepted | 2xx |

Row four is the acceptance criterion the ticket actually asks for — real-time auth prioritised over
sync. A 4xx there is a **pass**: it means the endpoint served the request and rejected the fixture
credentials. Only a 429 fails it.

### The three numbers, and how to play with them

It is a **token bucket**. One token is one forwarded batch. The bucket holds `burst` tokens, starts
full, and refills continuously at `ratePerMinute` — computed from elapsed time on each request, not
by a timer ticking in the background.

| Attribute | Env var | Default | Accepted range | What it controls |
|---|---|---|---|---|
| `SyncRateLimitEnabled` | `SYNC_RATE_LIMIT_ENABLED` | `false` | `Y`/`N`, `true`/`false`, `1`/`0` | The switch |
| `SyncRateLimitPerMinute` | `SYNC_RATE_LIMIT_PER_MINUTE` | 60 | 1 – 60000 | **Refill rate.** 60/min = 1 token/sec, added continuously, not in a once-a-minute lump. This is the sustained ceiling |
| `SyncRateLimitBurst` | `SYNC_RATE_LIMIT_BURST` | 20 | 1 – 10000 | **Bucket size.** How many back-to-back batches a store that has been quiet may send before the rate starts to bite |
| `SyncMaxConcurrent` | `SYNC_MAX_CONCURRENT` | 2 | 1 – 100 | **In-flight cap.** How many forwards may be open at once. Completely independent of the bucket |

Three mechanics that decide what you will see:

- **Concurrency is checked before rate.** If both would refuse, the refusal is attributed to
  concurrency. Both produce the same `429` + `Retry-After`; the log line `sync-log forward rate
  limited` carries `reason: "concurrency"` or `reason: "rate"`, which is the only way to tell them
  apart from outside.
- **`Retry-After` is derived, not fixed:** `ceil((1 - tokens) * 60 / ratePerMinute)`, floored at 1 s.
  Lower the rate and the advertised wait gets visibly longer. That is deliberate — retuning the rate
  can never leave a `Retry-After` that invites the agent back while the bucket is still empty.
- **Refusal does not consume a token.** The bucket keeps refilling while a store is being refused,
  which is why recovery is predictable.

#### Five experiments that produce visibly different results

Each is one `loadRemoteConfig` call, then re-run `verify-sync-rate-limit.js`.

| # | Send | What changes, and what it proves |
|---|---|---|
| 1 | `{"SyncRateLimitEnabled":"Y","SyncRateLimitPerMinute":"60","SyncRateLimitBurst":"20","SyncMaxConcurrent":"2"}` | The baseline. First ~20 batches 2xx, the rest 429, `Retry-After: 1` |
| 2 | `…"SyncRateLimitBurst":"3"` | Refusal arrives at **batch #4** instead of #21. Proves burst is the bucket size, nothing more |
| 3 | `…"SyncRateLimitPerMinute":"6","SyncRateLimitBurst":"3"` | `Retry-After` jumps to **10 s** (`60 / 6`). Proves the interval tracks the rate rather than being a hardcoded constant — and the script's recovery check now actually waits |
| 4 | `…"SyncRateLimitPerMinute":"1","SyncRateLimitBurst":"1"` | Almost everything is refused. Now hit `/authenticate-barcode`. **It must not return 429.** This is the ticket's real acceptance criterion under the harshest setting you can configure |
| 5 | `…"SyncMaxConcurrent":"1","SyncRateLimitPerMinute":"60000","SyncRateLimitBurst":"10000"` | The bucket is now effectively bottomless, so any refusal is attributable to concurrency alone. Fire batches **in parallel** and check the log says `reason: "concurrency"` |

Experiment 5 needs parallel sends. `verify-sync-rate-limit.js` posts sequentially and awaits each
response, so it will never hold two forwards open at once and will report no refusals:

```sh
for i in $(seq 1 10); do
  curl -sk -o /dev/null -w "%{http_code}\n" -X POST "$EDGE/storeossecurity/v2/syncLogs" \
    -H "x-api-key: $KEY" -H "Content-Type: application/json" -H "x-forward-to-cloud: true" \
    -d '{"table_name":"ErrorLog","records":[{"actionPerformed":"concurrency-probe","cvs_correlation_id":"concurrency-probe-'"$i"'-'"$(date +%s000)"'","storeId":"00000","errorTimestamp":'"$(date +%s000)"',"errorMessage":"concurrency probe"}]}' &
done; wait
```

#### Four traps when changing these

- **Out of range is dropped, not clamped.** Send `0` or `70000` for the rate and it is *ignored* — the
  store keeps whatever it had, and you are testing the old value while believing you set a new one.
  Look for `Ignoring out-of-range SyncRateLimitPerMinute` in the log. It refuses to coerce on purpose:
  silently substituting a number nobody asked for is how a store ends up throttled at a rate no one
  can account for. (`0` is specifically excluded because a rate of 0 refuses everything, a burst of 0
  refuses the first batch of every quiet period, and `maxConcurrent` 0 refuses permanently.)
- **An unrecognised switch value is dropped too.** `Y`, `N`, `true`, `false`, `1`, `0` and real
  booleans are understood; anything else logs `Ignoring unrecognised SyncRateLimitEnabled` and keeps
  the current value. This is not hypothetical — a strict `=== "Y"` comparison is exactly what made the
  circuit breaker report DISABLED on store 68522 while the attributes service said it was on.
- **The bucket does not reset when you change the config.** Lowering the burst clamps the bucket down
  on the next request, but raising it does *not* refill instantly — it fills at `ratePerMinute`. There
  is no reset endpoint. Between experiments either wait `burst ÷ (ratePerMinute ÷ 60)` seconds for a
  full bucket, or restart the container.
- **Always confirm what actually took effect.** `GET {basePath}/config-status` returns a
  `syncRateLimit` block with `enabled`, `ratePerMinute`, `ratePerSecond`, `burst`, `maxConcurrent`,
  `shippedDefault` and `requestsRemoteAttribute`. Read it after every change; do not assume the POST
  landed.

### Four things that bite a hand-rolled curl version

- **`x-forward-to-cloud: true` is required.** The limiter guards the forward to Central, so a run in
  offline mode refuses nothing and proves nothing. The script sends it; a manual run must too.
- **Timestamps must be epoch milliseconds**, not an ISO string. Central accepts a number, a
  `{$numberLong}`, or `"YYYY-MM-DD HH:mm:ss.SSS"` — an ISO string matches none of those, so every batch
  comes back 400 while the probe happily counts them as forwarded.
- **429 and 503 are different answers, separated on purpose.** `429` means the store is sending too
  fast while Central is healthy. `503` + `Retry-After` means Central could not be reached. Seeing 503s
  means Central is down; that is not the limiter.
- **`/syncLogs` now validates fields before the limiter ever sees the request (TLSTOR-641).** Every
  record needs `actionPerformed`, `cvs_correlation_id`, and `storeId` (`table_name` at the top
  level), or the batch gets `400` from the edge itself, locally, before it counts against anything.
  `verify-sync-rate-limit.js`'s own `batch()` already sends all three; the hand-rolled example above
  does too, as of this update. A `400` where you expected `429` almost always means a field is
  missing, not that the limiter didn't engage — check the response body before assuming the limiter
  is broken. See `docs/tlstor-641-brief.md` for the schema and its own QA table.

### Behaviour change worth telling whoever reads the logs

`/syncLogs` used to answer `201 "Inserted N records"` when it could not forward, having written the
batch to the store's MariaDB. There is no upsync from a store, so that copy could never reach Central —
it was not deferred delivery, it was an unreadable copy accumulating in the database whose connection
pressure caused INC0010990591. It is now refused with `503` and nothing is written. Anything treating
`2xx` as "delivered" will now see `503` during a Central outage, which is the point.

---

## 5. Where every value lives, and how to change it

There are three channels. Which one applies depends on the value, and picking the wrong one is the
most common reason a change appears to do nothing.

### Channel 1 — `POST {basePath}/loadRemoteConfig` (immediate, no restart)

The QA lever. Takes effect on the very next request.

```sh
curl -sk -X POST "$EDGE/storeossecurity/v2/loadRemoteConfig" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"SyncRateLimitEnabled":"Y","SyncRateLimitPerMinute":"120"}'
```

Two things about it that are not obvious:

- **The body is merged over the whole fetched attribute set.** Send every attribute you want kept in
  one call — anything omitted reverts to whatever the attributes service says.
- **Whether it survives the next scheduled reload depends on the opt-in flag**, and this catches
  people out in both directions. For a normal attribute (`CircuitBreakerEnabled`, `PingBaseUrl`,
  `SiteMinderSSOUrl`) the reload re-fetches and overwrites your value, so it is a testing lever, not
  configuration. For the three **opt-in** attribute groups below, a hand-POSTed value *persists*
  across reloads while the flag is off — the edge is not asking the service for that attribute, so it
  cannot read the service's silence as an instruction to revert. Once the flag is on, an absent
  attribute does revert to the boot default, which is what makes the attribute able to clear an
  override.

### Channel 2 — the attributes service (production path, per store)

The real mechanism for a store. Takes effect on that store's next scheduled reload. Most of the
groups below are **opt-in**: the edge only asks for them when a boot flag is set.
`CircuitBreakerConfig` is the exception, asked for by default since `2555f4b`.

| Attributes | Requires |
|---|---|
| `CloudRequestTimeoutMs` | `REMOTE_CONFIG_REQUEST_CLOUD_TIMEOUT=true` |
| `SyncRateLimitEnabled`, `SyncRateLimitPerMinute`, `SyncRateLimitBurst`, `SyncMaxConcurrent` | `REMOTE_CONFIG_REQUEST_SYNC_RATE_LIMIT=true` |
| `RouteTimeouts` | `REMOTE_CONFIG_REQUEST_ROUTE_TIMEOUTS=true` |
| `IdpRequestTimeoutMs` | `REMOTE_CONFIG_REQUEST_IDP_TIMEOUT=true` — new since this list was first written; closes the "3 only" gap `IDP_REQUEST_TIMEOUT_MS` used to have on the edge |
| `ApiKeyEnforcement` | `REMOTE_CONFIG_REQUEST_API_KEY_ENFORCEMENT=true` — same, closes `API_KEY_ENFORCEMENT`'s old "3 only" gap |
| `CircuitBreakerConfig` | **on by default** — opt out with `REMOTE_CONFIG_REQUEST_CIRCUIT_BREAKER_CONFIG=false` or `{"RequestCircuitBreakerConfig":"N"}`. A JSON blob, merged (not replaced) into the global `CB_*` baseline and any named block; see `docs/http-error-codes-and-circuit-breaker.md` §6 |

`EdgeValidationEnabled` and `EdgeValidationEnforcedPaths` are **not** behind an opt-in flag — both are
always in the fetched attribute set, so setting either on the attributes service (or via Channel 1)
takes effect on the very next fetch with no flag to turn on first. See
`docs/tlstor-641-brief.md` for what they do and how to test them.

**Provision the attribute first, then set the flag.** They are gated deliberately: asking the service
for an attribute it does not recognise can fail the *whole* fetch and drop **every** value back to
`.env`. Setting the flag against an unprovisioned attribute is how a single test change takes a store
off its remote configuration entirely.

### Channel 3 — environment variables (restart required)

Boot defaults. Remember the golden rule: **`.env` is only a boot default.** Where an attribute is
provisioned, the attributes service overrides the file at runtime and wins silently.

### Which channel for which value

| Value | Default | Channel |
|---|---|---|
| `SiteMinderSSOUrl`, `PingBaseUrl` | per store | 1 or 2 — runtime, no restart |
| `CircuitBreakerEnabled` | `false` | 1 or 2 — runtime, no restart |
| `SyncRateLimitEnabled` / `PerMinute` / `Burst` / `MaxConcurrent` | off · 60 · 20 · 2 | 1, or 2 behind its opt-in flag; env vars `SYNC_RATE_LIMIT_*` / `SYNC_MAX_CONCURRENT` need a restart |
| `IDP_REQUEST_TIMEOUT_MS`, Central | 10 000 ms | **3 only, on Central.** Central has no inbound remote-config channel of its own — this stays a pure boot default there |
| `IDP_REQUEST_TIMEOUT_MS`, edge | 10 000 ms | 3, or `IdpRequestTimeoutMs` behind its opt-in flag — **no longer edge-only-at-boot** as of this update. Asked-aware absent: an explicit `NOT_FOUND` (or anything non-numeric) reverts to the `.env` default rather than being ignored |
| `CLOUD_REQUEST_TIMEOUT_MS` | 30 000 ms (20 000 post-RCA) | 3, or `CloudRequestTimeoutMs` behind its opt-in flag. The bound actually handed to axios is `ceiling x 0.9` |
| `ROUTE_TIMEOUTS` — per-route cloud bound | unset | 3, or `RouteTimeouts` behind its opt-in flag. Form: `"/authenticate/credentials=15000,/syncLogs=8000"`, cloud paths not mounted paths |
| `CB_TIMEOUT`, `CB_MIN_REQUESTS`, `CB_TIME_WINDOW`, `CB_*_THRESHOLD`, `CB_RESET_TIMEOUT`, `CB_AUTHENTICATE_CREDENTIALS_*` (and any other per-block override) | see §0 | 3, or `CircuitBreakerConfig` (requested by default) — **no longer edge-only-at-boot.** One JSON blob merges into the global baseline and/or a named block; a `NOT_FOUND`/non-object value is skipped rather than merged |
| `API_KEY_ENFORCEMENT` | `warn` | 3, or `ApiKeyEnforcement` behind its opt-in flag — **no longer edge-only-at-boot** |
| `EDGE_VALIDATION_ENABLED` / `EdgeValidationEnabled` | `false` | 1 or 2 — no opt-in flag needed, always fetched |
| `EDGE_VALIDATION_ENFORCED_PATHS` / `EdgeValidationEnforcedPaths` | unset (= every route, once enabled) | 1 or 2 — no opt-in flag needed. `""` explicitly means "no scope"; omitted means "leave scope as it is" |
| MariaDB `connection_limit` / `connect_timeout` / `pool_timeout` / `socket_timeout` | 5 · 5 s · 20 s · 60 s | **3 only** — query parameters on `DATABASE_URL`, plus `DB_POOL_MAX` for the pool size |
| Central `MONGO_*`, `CB_MONGO_*`, `PI_SERVER_REQUEST_TIMEOUT_MS` | see §3 | **3 only**, on Central |

Two rules that apply to every timeout above:

- **A route override is applied verbatim**, not multiplied by 0.9 — the shared bound already is
  `ceiling x 0.9`, so feeding a typed 15000 through the same path would quietly give 13500.
- **Everything is still capped by the circuit breaker.** Axios must fail before the breaker, or the
  error arrives as `CircuitBreakerTimeoutError` and is indistinguishable from a backend failure where
  it gets counted. Ask for more than `CB_TIMEOUT x 0.9` and you get `CB_TIMEOUT x 0.9`, with a warning
  in the log naming what you asked for. Going higher means raising `CB_TIMEOUT` too.

And after every change, on every environment: **`GET {basePath}/config-status` is the only artefact
that says what a store is actually running**, and which source each value came from.

---

## 6. What a clean run does not establish

State these rather than let them be assumed:

- **Behaviour under concurrent load**, multi-store or fleet-scale. These probes bound a hang; they do
  not characterise load.
- **That the values are correctly tuned** for production latency. Whether 10 s is right for a healthy
  PingFederate is a question for observed production timings — which is why every value is tunable per
  environment without a rebuild.
- **The agent's 429 handling.** The edge-side contract is correct; its counterpart is not built yet.
  The agent deletes the batch regardless of the response.
- **Connect-phase timeouts as a separate bound.** The HTTP client in both components exposes one
  whole-request timeout, which is what has been set. It bounds the connect phase as part of the request
  rather than separately.

---

Source of record: `docs/release-sign-off-storeos-14.md` §4–§5 and
`docs/client-environment-certification-runbook.md`. Every figure here came from a run, not from ticket
text.
