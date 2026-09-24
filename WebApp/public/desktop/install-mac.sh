#!/bin/bash
# Nexus Desk for Mac — installer.
#
#   Install / update:  curl -fsSL https://rsng-phoenix.github.io/Nexus/desktop/install-mac.sh | bash
#   Uninstall:         curl -fsSL https://rsng-phoenix.github.io/Nexus/desktop/install-mac.sh | bash -s -- --uninstall
#
# What it does (nothing else, no admin password):
#   1. downloads nexus-desk-mac.jxa (a short, readable script) from the Nexus site,
#   2. builds "Nexus Desk.app" in ~/Applications with macOS's own osacompile tool,
#   3. adds a start-at-login entry (~/Library/LaunchAgents), unless you pass --no-login,
#   4. opens it: look for the Nexus icon in the menu bar.

set -euo pipefail

NEXUS_URL="${NEXUS_URL:-https://rsng-phoenix.github.io/Nexus/}"
case "$NEXUS_URL" in */) ;; *) NEXUS_URL="$NEXUS_URL/" ;; esac
APP_DIR="${NEXUS_APP_DIR:-$HOME/Applications}"
APP="$APP_DIR/Nexus Desk.app"
BUNDLE_ID="io.github.rsng-phoenix.nexus-desk"
AGENT="$HOME/Library/LaunchAgents/$BUNDLE_ID.plist"
LOGIN=1
MODE=install

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE=uninstall ;;
    --no-login) LOGIN=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }

stop_running() {
  osascript -e 'tell application id "'"$BUNDLE_ID"'" to quit' >/dev/null 2>&1 || true
  pkill -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || true
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. On Windows use install-windows.ps1." >&2
  exit 1
fi

if [ "$MODE" = uninstall ]; then
  stop_running
  rm -f "$AGENT"
  rm -rf "$APP"
  defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
  say "Nexus Desk removed. Your tasks are untouched."
  exit 0
fi

command -v osacompile >/dev/null || { echo "osacompile is missing (it ships with macOS)." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading Nexus Desk…"
curl -fsSL "${NEXUS_URL}desktop/nexus-desk-mac.jxa" -o "$TMP/desk.jxa"
curl -fsSL "${NEXUS_URL}icons/icon-512.png" -o "$TMP/icon.png" || true
# Sanity check: it must be the Nexus Desk script, not an error page.
grep -q "Nexus Desk for Mac" "$TMP/desk.jxa" || { echo "Download failed (unexpected content)." >&2; exit 1; }

# Point the app at this Nexus address (JavaScript string, so escape backslashes and quotes).
ESCAPED="$(printf '%s' "$NEXUS_URL" | sed -e 's/[\\/&]/\\&/g' -e "s/'/\\\\'/g")"
sed "s/__NEXUS_URL__/$ESCAPED/" "$TMP/desk.jxa" > "$TMP/desk.js"

say "Building Nexus Desk.app…"
stop_running
mkdir -p "$APP_DIR"
rm -rf "$APP"
osacompile -l JavaScript -s -o "$APP" "$TMP/desk.js"

PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" >/dev/null 2>&1 || true; }
pb "Set :CFBundleIdentifier $BUNDLE_ID"
pb "Add :CFBundleIdentifier string $BUNDLE_ID"
pb "Set :CFBundleName Nexus Desk"
pb "Add :CFBundleDisplayName string Nexus Desk"
pb "Add :LSUIElement bool true"
pb "Set :LSUIElement true"
pb "Add :NSHighResolutionCapable bool true"

if [ -s "$TMP/icon.png" ] && command -v iconutil >/dev/null; then
  SET="$TMP/applet.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$TMP/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s * 2))
    if [ $d -le 512 ]; then sips -z $d $d "$TMP/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true; fi
  done
  if iconutil -c icns "$SET" -o "$APP/Contents/Resources/applet.icns" >/dev/null 2>&1; then
    # Use the Nexus icon instead of the default script icon from the asset catalog.
    rm -f "$APP/Contents/Resources/Assets.car"
    pb "Delete :CFBundleIconName"
  fi
fi

# Built on this Mac, so a local (ad-hoc) signature is all macOS needs.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

if [ "$LOGIN" = 1 ]; then
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$BUNDLE_ID</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>$APP</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
fi

open "$APP"
say "Nexus Desk is running — click the Nexus icon in the menu bar."
echo "  · Window ▸ float on top, sit on the desktop, size, transparency"
echo "  · Hot corner ▸ show / hide Nexus from a screen corner"
echo "  · First time: sign in with Google inside the Nexus window to see your tasks."
if [ "$LOGIN" = 1 ]; then echo "  · Starts at login (turn off from the menu)."; fi
exit 0
