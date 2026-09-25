#!/usr/bin/env bash
# Runs the e2e suite against each "<directus version>:<database>" target.
# Usage: scripts/e2e.sh [target ...]   e.g. scripts/e2e.sh 12.4.0:postgres 11.0.0:sqlite
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
	TARGETS=(11.0.0:sqlite 11.9.3:postgres 11.17.4:mysql 11.17.4:postgres 12.0.0:sqlite 12.4.0:postgres 12.4.0:mysql)
fi

COMPOSE=(docker compose -f test/e2e/docker-compose.yml)
export DIRECTUS_PORT=${DIRECTUS_PORT:-8155} MAILPIT_PORT=${MAILPIT_PORT:-8125}
export DIRECTUS_URL="http://localhost:$DIRECTUS_PORT" MAILPIT_URL="http://localhost:$MAILPIT_PORT"

pnpm build >/dev/null

results=()
failed=0

for target in "${TARGETS[@]}"; do
	version=${target%%:*}
	db=${target##*:}

	case "$db" in
		sqlite) export DB_CLIENT=sqlite3 DB_HOST= DB_PORT= ;;
		postgres) export DB_CLIENT=pg DB_HOST=postgres DB_PORT=5432 ;;
		mysql) export DB_CLIENT=mysql DB_HOST=mysql DB_PORT=3306 ;;
		*) echo "Unknown database: $db" >&2; exit 1 ;;
	esac

	export DIRECTUS_VERSION=$version
	echo "::: Directus $version on $db"

	"${COMPOSE[@]}" --profile "$db" down -v --remove-orphans >/dev/null 2>&1 || true
	[ "$db" = sqlite ] || "${COMPOSE[@]}" --profile "$db" up -d --wait "$db" >/dev/null
	"${COMPOSE[@]}" --profile "$db" up -d mailpit directus >/dev/null

	for _ in $(seq 1 90); do
		curl -sf "$DIRECTUS_URL/server/health" >/dev/null && break
		sleep 2
	done

	if pnpm exec vitest run --config vitest.e2e.config.ts --reporter=verbose; then
		results+=("PASS  $version $db")
	else
		results+=("FAIL  $version $db")
		failed=1
		"${COMPOSE[@]}" logs directus | tail -50
	fi

	"${COMPOSE[@]}" --profile "$db" down -v --remove-orphans >/dev/null 2>&1
done

printf '\n%s\n' "${results[@]}"
exit $failed
