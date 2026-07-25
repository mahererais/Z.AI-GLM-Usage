#!/usr/bin/env bash
# Pack src/ into an uploadable GNOME Shell extension bundle in dist/.
# Usage: ./build.sh [-major|-minor|-patch]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src"
META="$SRC/metadata.json"
DIST="$ROOT/dist"

bump="${1:-}"

if [[ -n "$bump" ]]; then
  case "$bump" in
    -major|-minor|-patch) ;;
    *) echo "Unknown flag: $bump (use -major, -minor, or -patch)" >&2; exit 1 ;;
  esac
  name="$(python3 -c "import json;d=json.load(open('$META'));print(d.get('version-name','0.0.0'))")"
  IFS='.' read -r major minor patch <<<"$name"
  major=${major:-0}; minor=${minor:-0}; patch=${patch:-0}
  case "$bump" in
    -major) major=$((major+1)); minor=0; patch=0 ;;
    -minor) minor=$((minor+1)); patch=0 ;;
    -patch) patch=$((patch+1)) ;;
  esac
  new_name="$major.$minor.$patch"
  python3 - "$META" "$new_name" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d['version-name'] = name
json.dump(d, open(path, 'w'), indent=2)
PY
  echo "Bumped to $new_name"
fi

uuid="$(python3 -c "import json;print(json.load(open('$META'))['uuid'])")"
rm -rf "$DIST"
mkdir -p "$DIST"

gnome-extensions pack "$SRC" \
  --extra-source=lib \
  --extra-source=icons \
  --extra-source=schemas \
  --extra-source=stylesheet.css \
  --out-dir="$DIST"

echo "Built $DIST/${uuid}.shell-extension.zip"
