#!/bin/bash
#
# Builds Grove.app from this package with the command-line tools alone.
#
#   mac/build.sh            build into mac/build/Grove.app
#   mac/build.sh --run      build, then quit any running copy and open it
#
# The model key for the Mac's own fallback (Thinking.swift) is read from the
# repo's .env at build time and written into the built Info.plist only — it is
# never in a file under version control. Without one, ⌘K still works while the
# phone is connected, and says so when it is not.

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
app="$here/build/Grove.app"

cd "$here"
swift build -c release

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp .build/release/Grove "$app/Contents/MacOS/Grove"
# SwiftPM's resource bundle (panel.html) sits beside the binary in the build
# products; Bundle.module looks for it inside the app's Resources.
cp -R .build/release/Grove_Grove.bundle "$app/Contents/Resources/"
cp Info.plist "$app/Contents/Info.plist"

if [ -f "$root/.env" ]; then
  key="$(grep -E '^EXPO_PUBLIC_GEMINI_API_KEY=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  model="$(grep -E '^EXPO_PUBLIC_GEMINI_MODEL=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "${key:-}" ] && /usr/libexec/PlistBuddy -c "Add :GroveGeminiKey string $key" "$app/Contents/Info.plist"
  [ -n "${model:-}" ] && /usr/libexec/PlistBuddy -c "Add :GroveModel string $model" "$app/Contents/Info.plist"
fi

# Ad-hoc signed: enough for this Mac. macOS may ask for permissions again
# after a rebuild, because the signature changes.
codesign --force --deep --sign - "$app"
echo "Built $app"

if [ "${1:-}" = "--run" ]; then
  pkill -x Grove 2>/dev/null || true
  sleep 0.5
  open "$app"
fi
