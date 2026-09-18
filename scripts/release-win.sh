#!/usr/bin/env bash
# Cross-builds the Windows desktop app from macOS/Linux and drops into release/:
#   StudyTracker-windows-portable.zip      just StudyTracker.exe (+ INSTALL.txt); unzip and double-click
#   StudyTracker_<version>_x64-setup.exe   NSIS installer (per-user, no admin) — best effort, see below
# One-time setup on macOS:
#   brew install nsis llvm lld
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
# The first build downloads the Windows SDK/CRT (~1 GB) into ~/Library/Caches/cargo-xwin.
# "LNK4099 Cannot use debug info for libcmt.lib" linker warnings are harmless.
set -euo pipefail
cd "$(dirname "$0")/.."
for d in /opt/homebrew/opt/llvm/bin /opt/homebrew/opt/lld/bin; do [ -d "$d" ] && export PATH="$d:$PATH"; done
for tool in clang-cl lld-link llvm-lib cargo-xwin; do
  command -v "$tool" >/dev/null || { echo "missing $tool (see comments at the top of $0)"; exit 1; }
done
export CI=true
TARGET=x86_64-pc-windows-msvc
OUT=src-tauri/target/$TARGET/release

# 1. the executable (no bundling yet, so an installer problem cannot block the portable zip)
npx tauri build --runner cargo-xwin --target $TARGET --no-bundle
mkdir -p release
rm -f release/StudyTracker-windows-portable.zip
TMP=$(mktemp -d)
cp "$OUT/studytracker.exe" "$TMP/StudyTracker.exe"
cp INSTALL.txt "$TMP/INSTALL.txt"
(cd "$TMP" && zip -qr "$OLDPWD/release/StudyTracker-windows-portable.zip" StudyTracker.exe INSTALL.txt)
rm -rf "$TMP"
echo "portable: release/StudyTracker-windows-portable.zip"

# 2. the NSIS installer. Homebrew's makensis can crash with std::bad_alloc on macOS;
#    the installer is optional, the GitHub release workflow builds it on a Windows runner.
if command -v makensis >/dev/null; then
  rm -f release/StudyTracker_*_x64-setup.exe
  if npx tauri bundle --target $TARGET --bundles nsis; then
    cp "$OUT"/bundle/nsis/*-setup.exe release/
    echo "installer: $(ls release/StudyTracker_*_x64-setup.exe)"
  else
    echo "WARNING: NSIS installer failed (portable zip is fine). Push a v* tag to build it via .github/workflows/release.yml."
  fi
else
  echo "makensis not installed; skipping the installer (brew install nsis)"
fi
ls -la release/
