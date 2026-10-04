#!/usr/bin/env bash
set -euo pipefail

SIDECARS=(buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz)
HOST=$(rustc -vV | sed -n 's|host: ||p')
TARGET=${1:-$HOST}
if [[ "$TARGET" != *windows* ]]; then
    SIDECARS+=(buzz-backend-kubernetes)
    BUILD_HINT="cargo build --release -p buzz-acp -p buzz-agent -p buzz-backend-kubernetes -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli"
else
    BUILD_HINT="cargo build --release -p buzz-acp -p buzz-agent -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli"
fi
BINARIES_DIR="desktop/src-tauri/binaries"

# When --target is passed explicitly to cargo (even if it matches the host),
# binaries land in target/<triple>/release/. Without --target, they land in
# target/release/. The script receives the target as $1 only when cargo was
# invoked with --target, so use the qualified path whenever $1 is set.
if [[ -n "${1:-}" ]]; then
    SRC_DIR="target/${TARGET}/release"
else
    SRC_DIR="target/release"
fi

# MSVC emits <name>.exe; Tauri's externalBin then expects binaries/<name>-<triple>.exe.
if [[ "$TARGET" == *windows* ]]; then
    EXE=".exe"
else
    EXE=""
fi

missing=()
toosmall=()
for bin in "${SIDECARS[@]}"; do
    src="$SRC_DIR/${bin}${EXE}"
    if [[ ! -f "$src" ]]; then
        missing+=("${bin}${EXE}")
        continue
    fi
    # AN EXISTENCE CHECK IS NOT ENOUGH. Measured 2026-10-03: six 0-byte sources passed this script with
    # exit 0 and were copied into the bundle with mode 755 - the exact shape the app accepts as a real
    # command - so the shipped DMG carried six empty sidecars. 1000000 B is the same floor
    # deploy/buzz/rollback/rollback-artefact-check.sh applies to a shipped binary.
    size=$(wc -c <"$src" | tr -d ' ')
    if [[ "$size" -lt 1000000 ]]; then
        toosmall+=("${bin}${EXE}=${size}B")
    fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Error: missing release binaries in $SRC_DIR: ${missing[*]}" >&2
    echo "Run '$BUILD_HINT' first." >&2
    exit 1
fi
if [[ ${#toosmall[@]} -gt 0 ]]; then
    echo "Error: release binaries are too small to be real (floor 1000000 B): ${toosmall[*]}" >&2
    echo "A 0-byte or truncated sidecar copied into the bundle is accepted as a real command, and the" >&2
    echo "resulting app cannot spawn agents. Rebuild with '$BUILD_HINT' and check for a stale target dir." >&2
    exit 1
fi

mkdir -p "$BINARIES_DIR"
for bin in "${SIDECARS[@]}"; do
    destination="$BINARIES_DIR/${bin}-${TARGET}${EXE}"
    cp "$SRC_DIR/${bin}${EXE}" "$destination"

    # cp preserves the mode of an existing destination on macOS. Generated
    # sidecar placeholders may not be executable, so make the bundled Unix
    # binaries executable explicitly.
    if [[ -z "$EXE" ]]; then
        chmod 755 "$destination"
    fi
done
echo "Sidecars bundled for $TARGET"
