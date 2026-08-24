#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
LOCAL_SETTINGS="$ROOT_DIR/config/settings.local.json"
SKIP_DEPS=false

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap.sh [--skip-deps]

Installs this repo's shared Pi setup into $PI_CODING_AGENT_DIR or ~/.pi/agent.
Existing managed paths are moved into a timestamped backup before linking.
EOF
}

for argument in "$@"; do
  case "$argument" in
    --skip-deps) SKIP_DEPS=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $argument" >&2; usage >&2; exit 1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to merge Pi settings." >&2
  exit 1
fi

mkdir -p "$PI_DIR"

node "$ROOT_DIR/scripts/merge-settings.mjs" \
  "$ROOT_DIR/config/settings.shared.json" \
  "$LOCAL_SETTINGS" \
  "$PI_DIR/settings.json"

echo "Updated $PI_DIR/settings.json"

BACKUP_ROOT=""
backup_target() {
  local target="$1"
  local relative_path="${target#"$PI_DIR"/}"

  if [[ -z "$BACKUP_ROOT" ]]; then
    BACKUP_ROOT="$PI_DIR/backups/$(date +%Y%m%d-%H%M%S)"
  fi

  mkdir -p "$BACKUP_ROOT/$(dirname "$relative_path")"
  mv "$target" "$BACKUP_ROOT/$relative_path"
  echo "Backed up $relative_path"
}

link_path() {
  local source="$1"
  local target="$2"
  local relative_path="${target#"$PI_DIR"/}"

  mkdir -p "$(dirname "$target")"

  if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
    echo "Already linked $relative_path"
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    backup_target "$target"
  fi

  ln -s "$source" "$target"
  echo "Linked $relative_path"
}

link_path "$ROOT_DIR/config/AGENTS.md" "$PI_DIR/AGENTS.md"

for resource_type in extensions skills prompts themes; do
  source_directory="$ROOT_DIR/$resource_type"
  [[ -d "$source_directory" ]] || continue

  while IFS= read -r -d '' source; do
    name="$(basename "$source")"
    target="$PI_DIR/$resource_type/$name"

    # Keep an existing Context7 credential local to this checkout before linking.
    if [[ "$resource_type/$name" == "extensions/context7" \
      && ! -e "$source/config.json" \
      && -f "$target/config.json" ]]; then
      cp "$target/config.json" "$source/config.json"
      chmod 600 "$source/config.json"
      echo "Migrated the existing Context7 config (kept ignored by Git)"
    fi

    link_path "$source" "$target"
  done < <(find "$source_directory" -mindepth 1 -maxdepth 1 -print0 | sort -z)
done

if [[ "$SKIP_DEPS" == false ]]; then
  while IFS= read -r -d '' manifest; do
    extension_directory="$(dirname "$manifest")"
    extension_name="$(basename "$extension_directory")"

    if [[ -f "$extension_directory/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
      echo "Installing dependencies for $extension_name with pnpm"
      pnpm --dir "$extension_directory" install --frozen-lockfile
    else
      echo "Installing dependencies for $extension_name with npm"
      npm --prefix "$extension_directory" install --ignore-scripts
    fi
  done < <(find "$ROOT_DIR/extensions" -mindepth 2 -maxdepth 2 -name package.json -print0 | sort -z)
fi

if [[ -n "$BACKUP_ROOT" ]]; then
  echo "Backups: $BACKUP_ROOT"
fi

echo "Pi setup installed. Restart Pi so it can load the resources and packages."
