#!/usr/bin/env bash
# 在项目目录内落地完整工具链，不需要 sudo，不写入任何系统目录。
# 幂等：已存在的组件会跳过下载与解压。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/.toolchain"
DL="$TC/downloads"

JDK_URL="https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
MVN_URL="https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip"
MYSQL_URL="https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-8.4.7-macos15-arm64.tar.gz"

mkdir -p "$DL"

log() { printf '\033[1;34m[toolchain]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[toolchain] %s\033[0m\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <outfile>
  local url="$1" out="$2"
  if [ -s "$out" ]; then log "已缓存 $(basename "$out") ($(du -h "$out" | cut -f1))"; return 0; fi
  log "下载 $(basename "$out") ..."
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$out.part" "$url" \
    || die "下载失败: $url"
  mv "$out.part" "$out"
  log "完成 $(basename "$out") ($(du -h "$out" | cut -f1))"
}

# ---------------------------------------------------------------- JDK 21
if [ -x "$TC/jdk/Contents/Home/bin/java" ] || [ -x "$TC/jdk/bin/java" ]; then
  log "JDK 已就绪"
else
  fetch "$JDK_URL" "$DL/temurin21.tar.gz"
  log "解压 JDK ..."
  rm -rf "$TC/jdk.tmp" && mkdir -p "$TC/jdk.tmp"
  tar -xzf "$DL/temurin21.tar.gz" -C "$TC/jdk.tmp"
  home="$(find "$TC/jdk.tmp" -maxdepth 3 -type d -name Home -path '*Contents*' | head -1)"
  [ -n "$home" ] || die "JDK 解压后找不到 Contents/Home"
  rm -rf "$TC/jdk" && mv "$home" "$TC/jdk"
  rm -rf "$TC/jdk.tmp"
fi

# ---------------------------------------------------------------- Maven
if [ -x "$TC/maven/bin/mvn" ]; then
  log "Maven 已就绪"
else
  fetch "$MVN_URL" "$DL/maven.zip"
  log "解压 Maven ..."
  rm -rf "$TC/maven.tmp" && mkdir -p "$TC/maven.tmp"
  unzip -q "$DL/maven.zip" -d "$TC/maven.tmp"
  src="$(find "$TC/maven.tmp" -maxdepth 1 -type d -name 'apache-maven-*' | head -1)"
  [ -n "$src" ] || die "Maven 解压后找不到 apache-maven-* 目录"
  rm -rf "$TC/maven" && mv "$src" "$TC/maven"
  rm -rf "$TC/maven.tmp"
fi

# ---------------------------------------------------------------- MySQL 8.4.7
if [ -x "$TC/mysql/bin/mysqld" ]; then
  log "MySQL 已就绪"
else
  fetch "$MYSQL_URL" "$DL/mysql.tar.gz"
  log "解压 MySQL ..."
  rm -rf "$TC/mysql.tmp" && mkdir -p "$TC/mysql.tmp"
  tar -xzf "$DL/mysql.tar.gz" -C "$TC/mysql.tmp"
  src="$(find "$TC/mysql.tmp" -maxdepth 1 -type d -name 'mysql-*' | head -1)"
  [ -n "$src" ] || die "MySQL 解压后找不到 mysql-* 目录"
  rm -rf "$TC/mysql" && mv "$src" "$TC/mysql"
  rm -rf "$TC/mysql.tmp"
  # 项目内实例：不走 Gatekeeper 隔离（curl 下载通常不带 quarantine，这里兜底）
  xattr -dr com.apple.quarantine "$TC/mysql" 2>/dev/null || true
fi

log "全部就绪："
"$TC/jdk/bin/java" -version 2>&1 | head -1 | sed 's/^/  JDK   /'
JAVA_HOME="$TC/jdk" "$TC/maven/bin/mvn" -v 2>/dev/null | head -1 | sed 's/^/  Maven /'
"$TC/mysql/bin/mysqld" --version | sed 's/^/  MySQL /'
log "环境变量入口： source $ROOT/scripts/env.sh"
