#!/bin/sh
# Installs the mando agent binary for this machine.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/yosoyvilla/mando/main/install.sh | sh
#
# Detects OS/arch, downloads the matching binary from the latest GitHub
# release, and installs it as `mando` on PATH.
set -e

REPO="yosoyvilla/mando"

fail() {
  echo "install.sh: $1" >&2
  exit 1
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) fail "unsupported OS: $(uname -s) (mando ships binaries for darwin and linux only)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) fail "unsupported architecture: $(uname -m) (mando ships x64 and arm64 binaries only)" ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET="mando-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

echo "Downloading ${ASSET} from the latest release..."
if ! curl -fsSL "$URL" -o "$TMP_FILE"; then
  fail "download failed: $URL (check that a release exists for this platform)"
fi

chmod +x "$TMP_FILE"

# macOS Gatekeeper quarantines anything downloaded by a browser or curl;
# without an Apple code-signing identity for this project, a
# self-installed binary would otherwise be blocked from running. This
# only clears the quarantine flag on the file we just downloaded.
if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "$TMP_FILE" 2>/dev/null || true
fi

INSTALL_DIR="/usr/local/bin"
INSTALL_PATH="${INSTALL_DIR}/mando"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP_FILE" "$INSTALL_PATH"
elif command -v sudo >/dev/null 2>&1; then
  echo "Elevated permissions are needed to write to ${INSTALL_DIR}."
  sudo mv "$TMP_FILE" "$INSTALL_PATH"
  sudo chmod +x "$INSTALL_PATH"
else
  INSTALL_DIR="${HOME}/.local/bin"
  INSTALL_PATH="${INSTALL_DIR}/mando"
  mkdir -p "$INSTALL_DIR"
  mv "$TMP_FILE" "$INSTALL_PATH"
  chmod +x "$INSTALL_PATH"
  echo "Installed to ${INSTALL_PATH}."
  echo "Add it to your PATH if it isn't already, for example:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo "mando installed at ${INSTALL_PATH}"
echo ""
echo "Next steps:"
echo "  mando install-command             # registers the /mando command with opencode"
echo "  mando connect --hub <your-hub-url>"
