#!/usr/bin/env bash
#
# One-command regression run against a deployed PrivateID edge.
#
#   EDGE=http://<edge-host>:8080 API_KEY=<key> STORE_ID=<store> ./run-regression.sh store
#
# Profiles
#   store     00 Preflight + 01 store-safe contract, both dispatch modes. Read-only — safe at a live store.
#   uat       store + 02 non-destructive + 04 temp-employee journey, both modes. WRITES test data.
#   full      uat + 03 destructive contract rows. WRITES. Non-production only.
#   selftest  05: the edge runs its own read-only suites (table, resiliency, integrity) and reports.
#
# Environment
#   EDGE         required  edge origin, e.g. http://10.1.2.3:8080 (no trailing slash)
#   API_KEY      required  EDGE_API_KEY for this store
#   STORE_ID     required  the store this edge serves
#   TARGET       store     store | uat | dev | local. Writing profiles refuse unless uat, dev or local.
#   BASE_PATH    /storeossecurity/v2
#   EMPLOYEE_ID            a TEST employee for the contract rows (optional; never a real associate)
#   PASSWORD               that employee's password (optional)
#   MODES        "offline online"
#   OUT          ./qa-results/<timestamp>
#   NEWMAN       newman command; default "npx --yes newman@6.2.1"
#   REPORT_JSON  set to 1 to also write Newman's full JSON per run. It contains the API key in plain
#                text (Newman records the environment), so it is off by default.
#
# Exit code: 0 only if every request and every assertion passed. Results: JUnit XML per run (for CI)
# in $OUT. JUnit carries no request headers or environment values.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COLLECTION="$HERE/postman/privateid-edge-regression.postman_collection.json"
ENVIRONMENT="$HERE/postman/privateid-edge.postman_environment.json"

PROFILE="${1:-}"
: "${TARGET:=store}"
: "${BASE_PATH:=/storeossecurity/v2}"
: "${MODES:=offline online}"
: "${OUT:=./qa-results/$(date +%Y%m%d-%H%M%S)}"
: "${NEWMAN:=npx --yes newman@6.2.1}"

F_PRE="00 Preflight — what is this store actually running"
F_SAFE="01 Contract — store-safe (read-only, OK at a live store)"
F_UAT="02 Contract — non-destructive extras (UAT)"
F_WRITE="03 Contract — WRITES (non-production only)"
F_JOURNEY="04 Journey — temp employee end to end (WRITES, UAT/non-prod)"

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

[ -n "$PROFILE" ] || usage
for v in EDGE API_KEY STORE_ID; do
	[ -n "${!v:-}" ] || { echo "error: $v is required" >&2; usage; }
done

case "$PROFILE" in
	store) PER_MODE=("$F_PRE" "$F_SAFE") ;;
	uat) PER_MODE=("$F_PRE" "$F_SAFE" "$F_UAT" "$F_JOURNEY") ;;
	full) PER_MODE=("$F_PRE" "$F_SAFE" "$F_UAT" "$F_WRITE" "$F_JOURNEY") ;;
	selftest) PER_MODE=() ;;
	*) usage ;;
esac

if [[ "$PROFILE" == uat || "$PROFILE" == full ]] && [[ ! "$TARGET" =~ ^(uat|dev|local)$ ]]; then
	echo "error: profile '$PROFILE' writes test data. Set TARGET=uat, dev or local (it is '$TARGET')." >&2
	echo "       Never run it against a production store." >&2
	exit 2
fi

mkdir -p "$OUT"
COMMON=(
	-e "$ENVIRONMENT"
	--env-var "edgeBase=$EDGE"
	--env-var "basePath=$BASE_PATH"
	--env-var "uiBasePath=$BASE_PATH"
	--env-var "apiKey=$API_KEY"
	--env-var "storeId=$STORE_ID"
	--env-var "targetEnvironment=$TARGET"
	--reporters "cli,junit${REPORT_JSON:+,json}"
)
[ -n "${EMPLOYEE_ID:-}" ] && COMMON+=(--env-var "employeeId=$EMPLOYEE_ID")
[ -n "${PASSWORD:-}" ] && COMMON+=(--env-var "password=$PASSWORD")

FAILED=0
SUMMARY=()

run() { # label, then newman args
	local label="$1"
	shift
	echo
	echo "=== $label"
	# shellcheck disable=SC2086
	$NEWMAN run "$COLLECTION" "${COMMON[@]}" \
		--reporter-junit-export "$OUT/$label.xml" \
		${REPORT_JSON:+--reporter-json-export "$OUT/$label.json"} \
		"$@"
	local code=$?
	[ $code -eq 0 ] && SUMMARY+=("PASS  $label") || { SUMMARY+=("FAIL  $label (exit $code)"); FAILED=1; }
}

if [ ${#PER_MODE[@]} -gt 0 ]; then
	FOLDER_ARGS=()
	for f in "${PER_MODE[@]}"; do FOLDER_ARGS+=(--folder "$f"); done
	for mode in $MODES; do
		case "$mode" in
			offline) ftc=false ;;
			online) ftc=true ;;
			*) echo "error: unknown mode '$mode'" >&2; exit 2 ;;
		esac
		run "$PROFILE-$mode" "${FOLDER_ARGS[@]}" --env-var "forwardToCloud=$ftc"
	done
fi

if [ "$PROFILE" = selftest ]; then
	# The edge runs both modes itself inside the table suite; these are read-only.
	run "selftest-table" --folder "Self-test: table"
	run "selftest-resiliency" --folder "Self-test: resiliency (read-only half)"
	run "selftest-integrity" --folder "Self-test: integrity (read-only)"
fi

echo
echo "=== summary ($PROFILE, target=$TARGET, edge=$EDGE)"
printf '%s\n' "${SUMMARY[@]}"
echo "results: $OUT"
exit $FAILED
