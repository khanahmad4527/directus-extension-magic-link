#!/usr/bin/env bash
# Runs the e2e suite against each "<directus version>:<database>[:mode]" target.
# Modes: (none) pages on with a full PUBLIC_URL; defaults: a default Directus (pages off, PUBLIC_URL "/");
# nourl: pages on without a full PUBLIC_URL; upgrade: start the published 1.0.0 first, then this build.
# Usage: scripts/e2e.sh [target ...]   e.g. scripts/e2e.sh 12.5.0:postgres 12.5.0:sqlite:defaults
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
	TARGETS=(
		11.0.0:sqlite 11.9.3:postgres 11.17.4:mysql 11.17.4:postgres 12.0.0:sqlite 12.4.0:postgres 12.5.0:postgres 12.5.0:mysql
		12.5.0:sqlite:defaults 12.5.0:sqlite:nourl 11.0.0:sqlite:upgrade 12.5.0:postgres:upgrade 12.5.0:mysql:upgrade
	)
fi

COMPOSE=(docker compose -f test/e2e/docker-compose.yml)
export DIRECTUS_PORT=${DIRECTUS_PORT:-8155} MAILPIT_PORT=${MAILPIT_PORT:-8125}
export DIRECTUS_URL="http://localhost:$DIRECTUS_PORT" MAILPIT_URL="http://localhost:$MAILPIT_PORT"

pnpm build >/dev/null

wait_for_directus() {
	for _ in $(seq 1 90); do
		curl -sf "$DIRECTUS_URL/server/ping" >/dev/null && return 0
		sleep 2
	done

	echo "Directus didn't start" >&2
	return 1
}

results=()
failed=0

for target in "${TARGETS[@]}"; do
	IFS=: read -r version db mode <<<"$target"
	export E2E_MODE=${mode:-full}

	case "$E2E_MODE" in
		full | upgrade) export MAGIC_LINK_ENABLE_PAGES=true E2E_PUBLIC_URL="$DIRECTUS_URL" ;;
		defaults) export MAGIC_LINK_ENABLE_PAGES=false E2E_PUBLIC_URL=/ ;;
		nourl) export MAGIC_LINK_ENABLE_PAGES=true E2E_PUBLIC_URL=/ ;;
		*) echo "Unknown mode: $mode" >&2; exit 1 ;;
	esac

	case "$db" in
		sqlite) export DB_CLIENT=sqlite3 DB_HOST= DB_PORT= ;;
		postgres) export DB_CLIENT=pg DB_HOST=postgres DB_PORT=5432 ;;
		mysql) export DB_CLIENT=mysql DB_HOST=mysql DB_PORT=3306 ;;
		*) echo "Unknown database: $db" >&2; exit 1 ;;
	esac

	export DIRECTUS_VERSION=$version E2E_EXTENSION_DIR=../..
	echo "::: Directus $version on $db${mode:+ ($mode)}"

	"${COMPOSE[@]}" --profile "$db" down -v --remove-orphans >/dev/null 2>&1 || true
	[ "$db" = sqlite ] || "${COMPOSE[@]}" --profile "$db" up -d --wait "$db" >/dev/null

	if [ "$E2E_MODE" = upgrade ]; then
		previous=$(mktemp -d)
		(cd "$previous" && npm pack directus-extension-magic-link@1.0.0 --silent >/dev/null && tar xzf ./*.tgz)

		E2E_EXTENSION_DIR="$previous/package" "${COMPOSE[@]}" --profile "$db" up -d mailpit directus >/dev/null
		wait_for_directus

		# 1.0.0 creates its table at startup; this also leaves a row from it behind
		curl -sf "$DIRECTUS_URL/magic-link/request" -H 'content-type: application/json' -d '{"email":"upgrade@example.com"}' >/dev/null

		"${COMPOSE[@]}" --profile "$db" up -d --force-recreate directus >/dev/null
		rm -rf "$previous"
	else
		"${COMPOSE[@]}" --profile "$db" up -d mailpit directus >/dev/null
	fi

	if wait_for_directus && pnpm exec vitest run --config vitest.e2e.config.ts --reporter=verbose; then
		results+=("PASS  $target")
	else
		results+=("FAIL  $target")
		failed=1
		"${COMPOSE[@]}" logs directus | tail -50
	fi

	"${COMPOSE[@]}" --profile "$db" down -v --remove-orphans >/dev/null 2>&1
done

printf '\n%s\n' "${results[@]}"
exit $failed
