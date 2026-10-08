#!/usr/bin/env bash
# Maven 包装：使用项目内 JDK 与项目内本地仓库（不碰 ~/.m2，也不需要 sudo）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"
exec "$M2_HOME/bin/mvn" -Dmaven.repo.local="$ROOT/.toolchain/m2repo" "$@"
