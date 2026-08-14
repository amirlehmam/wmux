#!/usr/bin/env bash
#
# install-npiperelay.sh — Download npiperelay.exe (SHA-256 pinned) into WSL2 so
# the wmux CLI / `wmux bridge` can reach the Windows \\.\pipe\wmux named pipe via
# WSL interop (see src/cli/wmux.ts → connectViaNpiperelay).
#
# npiperelay.exe is a small open-source Windows binary that forwards a named pipe
# to its own stdin/stdout; WSL2 executes it via interop, so no socat/Unix-socket
# pre-setup is needed. This script only installs the binary — the CLI spawns it.
#
# Idempotent: re-running is a no-op when the installed binary's hash matches.
#
# Usage:
#   bash scripts/install-npiperelay.sh
#
# Requires: curl, sha256sum (both available via apt).

set -euo pipefail

# ── Pinned release (albertony/npiperelay v1.11.4) ─────────────────────────────
NPIPERELAY_VERSION="v1.11.4"
NPIPERELAY_URL="https://github.com/albertony/npiperelay/releases/download/${NPIPERELAY_VERSION}/npiperelay_windows_amd64.exe"
NPIPERELAY_SHA256="cea82cf5c9c22a28bef8075750acb7958f766393baebff4597cf21442f71c4b3"
NPIPERELAY_CHECKSUMS_URL="https://github.com/albertony/npiperelay/releases/download/${NPIPERELAY_VERSION}/npiperelay_checksums.txt"
NPIPERELAY_CHECKSUMS_SHA256="313973839744601ae73eb3597f62c9adb5f9e6985e97b4054ed18701f2cb5df7"
# ──────────────────────────────────────────────────────────────────────────────

INSTALL_DIR="${HOME}/.local/bin"
NPIPERELAY_BIN="${INSTALL_DIR}/npiperelay.exe"

echo "wmux npiperelay install"
echo "======================="
echo "  version : ${NPIPERELAY_VERSION}"
echo "  target  : ${NPIPERELAY_BIN}"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────
for cmd in curl sha256sum; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found. Install with: sudo apt-get install $cmd"
    exit 1
  fi
done

# ── Skip when the pinned binary is already present and verified ────────────────
mkdir -p "${INSTALL_DIR}"

if [[ -f "${NPIPERELAY_BIN}" ]]; then
  existing_hash="$(sha256sum "${NPIPERELAY_BIN}" | awk '{print $1}')"
  if [[ "${existing_hash}" == "${NPIPERELAY_SHA256}" ]]; then
    echo "[OK] npiperelay.exe already present and hash verified."
    exit 0
  fi
  echo "[!] Existing npiperelay.exe hash mismatch (got ${existing_hash}), re-downloading..."
fi

# ── Verify the checksums file itself before trusting it ────────────────────────
echo "[+] Downloading checksums file..."
tmp_checksums="$(mktemp)"
trap 'rm -f "${tmp_checksums:-}" "${tmp_bin:-}"' EXIT
curl -fsSL "${NPIPERELAY_CHECKSUMS_URL}" -o "${tmp_checksums}"
actual_checksums_hash="$(sha256sum "${tmp_checksums}" | awk '{print $1}')"
if [[ "${actual_checksums_hash}" != "${NPIPERELAY_CHECKSUMS_SHA256}" ]]; then
  echo "ERROR: Checksums file hash mismatch!"
  echo "  expected: ${NPIPERELAY_CHECKSUMS_SHA256}"
  echo "  got:      ${actual_checksums_hash}"
  exit 1
fi

# Confirm the pinned binary hash is listed in the (now trusted) checksums file.
if ! grep -q "${NPIPERELAY_SHA256}" "${tmp_checksums}"; then
  echo "ERROR: Expected binary hash not found in checksums file — pinned hash outdated?"
  exit 1
fi

# ── Download the binary and re-verify its hash ────────────────────────────────
echo "[+] Downloading npiperelay_windows_amd64.exe..."
tmp_bin="$(mktemp)"
curl -fsSL "${NPIPERELAY_URL}" -o "${tmp_bin}"
actual_hash="$(sha256sum "${tmp_bin}" | awk '{print $1}')"
if [[ "${actual_hash}" != "${NPIPERELAY_SHA256}" ]]; then
  echo "ERROR: Downloaded binary hash mismatch!"
  echo "  expected: ${NPIPERELAY_SHA256}"
  echo "  got:      ${actual_hash}"
  exit 1
fi

mv "${tmp_bin}" "${NPIPERELAY_BIN}"
chmod +x "${NPIPERELAY_BIN}"
echo "[OK] npiperelay.exe installed to ${NPIPERELAY_BIN} (sha256 ${actual_hash})"
