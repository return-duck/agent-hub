# 项目内工具链环境变量。用法： source scripts/env.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export AGENT_STACK_ROOT="$ROOT"
export JAVA_HOME="$ROOT/.toolchain/jdk"
export M2_HOME="$ROOT/.toolchain/maven"
export PATH="$JAVA_HOME/bin:$M2_HOME/bin:$ROOT/.toolchain/mysql/bin:$PATH"
export MYSQL_HOME="$ROOT/.toolchain/mysql"

# 包管理器缓存也放进项目内：保持"整套工具链自包含"，并且不依赖 ~/.npm 的权限
export npm_config_cache="$ROOT/.toolchain/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false

# 项目级 MySQL 实例参数（与系统 TCP 3306 隔离）
export AGENT_STACK_DB_PORT="${AGENT_STACK_DB_PORT:-3307}"
export AGENT_STACK_DB_USER="${AGENT_STACK_DB_USER:-agentstack}"
export AGENT_STACK_DB_PASSWORD="${AGENT_STACK_DB_PASSWORD:-agentstack}"
export AGENT_STACK_DB_NAME="${AGENT_STACK_DB_NAME:-agent_stack}"
export AGENT_STACK_DB_TEST_NAME="${AGENT_STACK_DB_TEST_NAME:-agent_stack_test}"
