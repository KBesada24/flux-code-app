#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/.local/bin"
ICONS_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
DESKTOP_DIR="$HOME/.local/share/applications"

echo "==> Building T3 Code..."
cd "$REPO_ROOT"
bun run build:desktop

echo "==> Packaging AppImage..."
bun run dist:desktop:linux

echo "==> Locating AppImage..."
APPIMAGE=$(find "$REPO_ROOT/release" -name "*.AppImage" | sort | tail -n 1)
if [[ -z "$APPIMAGE" ]]; then
  echo "ERROR: No AppImage found in $REPO_ROOT/release" >&2
  exit 1
fi
echo "    Found: $APPIMAGE"

echo "==> Installing to $INSTALL_DIR/t3code.AppImage..."
mkdir -p "$INSTALL_DIR"
cp "$APPIMAGE" "$INSTALL_DIR/t3code.AppImage"
chmod +x "$INSTALL_DIR/t3code.AppImage"

echo "==> Installing icon..."
mkdir -p "$ICONS_DIR"
cp "$REPO_ROOT/apps/desktop/resources/icon.png" "$ICONS_DIR/t3code.png"

echo "==> Writing .desktop entry..."
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/t3code.desktop" <<EOF
[Desktop Entry]
Name=T3 Code (Alpha)
Comment=AI-powered code editor
Exec=$INSTALL_DIR/t3code.AppImage
Icon=t3code
StartupWMClass=t3code
Type=Application
Categories=Development;IDE;
Terminal=false
StartupNotify=true
EOF

echo "==> Updating desktop database..."
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

echo ""
echo "Done! T3 Code is installed."
echo "Press Super and search for 'T3 Code' to launch it."
