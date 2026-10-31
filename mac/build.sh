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
  # Optional, for GIF reactions (Gifs.swift): a GIPHY key, or a Tenor one.
  giphy="$(grep -E '^GIPHY_API_KEY=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  tenor="$(grep -E '^TENOR_API_KEY=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "${giphy:-}" ] && /usr/libexec/PlistBuddy -c "Add :GroveGiphyKey string $giphy" "$app/Contents/Info.plist"
  [ -n "${tenor:-}" ] && /usr/libexec/PlistBuddy -c "Add :GroveTenorKey string $tenor" "$app/Contents/Info.plist"
  # Noctus's Supabase project, for signing in. The anon key is a public key by
  # design; the account's own token is what opens anything.
  supa="$(grep -E '^EXPO_PUBLIC_NOCTUS_SUPABASE_URL=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  anon="$(grep -E '^EXPO_PUBLIC_NOCTUS_SUPABASE_ANON_KEY=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "${supa:-}" ] && /usr/libexec/PlistBuddy -c "Add :GroveSupabaseURL string $supa" "$app/Contents/Info.plist"
  [ -n "${anon:-}" ] && /usr/libexec/PlistBuddy -c "Add :GroveSupabaseAnon string $anon" "$app/Contents/Info.plist"
fi
cp AppIcon.icns "$app/Contents/Resources/AppIcon.icns"

# Signed with a local certificate when there is one, so the signature names
# the same certificate every build. macOS ties Accessibility, the microphone
# and Automation to that: ad-hoc signing changes on every rebuild, and a grant
# made before one silently stops applying while Settings still shows it on —
# which is exactly how ⌘K stopped working. Make the identity once with
# mac/make-signing-identity.sh.
if security find-identity -p codesigning 2>/dev/null | grep -q "Grove Local Signing"; then
  codesign --force --deep --sign "Grove Local Signing" "$app"
else
  echo "No Grove Local Signing identity: signing ad-hoc. Permissions will reset on each rebuild."
  codesign --force --deep --sign - "$app"
fi
echo "Built $app"

if [ "${1:-}" = "--run" ]; then
  pkill -x Grove 2>/dev/null || true
  sleep 0.5
  open "$app"
fi
