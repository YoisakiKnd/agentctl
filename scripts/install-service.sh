#!/usr/bin/env bash
# 把 agentctl 装成 systemd 用户服务：开机自启、崩溃自动拉起、日志进 journal。
#
#   scripts/install-service.sh            安装 / 更新并（重）启动
#   scripts/install-service.sh --uninstall 停止并移除
#
# 不需要 root：服务跑在当前用户下，这样才能读到 ~/.claude 等会话目录、调到 claude 命令。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/agentctl.service"
CONFIG="${AGENTCTL_HOME:-$HOME/.agentctl}/config.yaml"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now agentctl.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  say "已移除 agentctl 服务（配置与索引仍在 ~/.agentctl）"
  exit 0
fi

command -v systemctl >/dev/null || die "这台机器没有 systemd；可以直接用 pnpm start 配合 tmux / nohup 运行"
systemctl --user show-environment >/dev/null 2>&1 || die "systemd 用户实例不可用（试试 loginctl enable-linger $USER 后重新登录）"
NODE="$(command -v node)" || die "找不到 node（需要 22.13 以上）"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "node 版本 $("$NODE" -v) 太旧，需要 22.13 以上（用到内置的 node:sqlite）"
command -v pnpm >/dev/null || die "找不到 pnpm"

say "安装依赖并构建前端"
(cd "$ROOT" && pnpm install --frozen-lockfile && pnpm build)

# 远程监听必须有密码：服务端也会拒绝启动，这里提前拦下，免得服务反复重启
HOST="$(sed -n 's/^host:[[:space:]]*//p' "$CONFIG" 2>/dev/null | tr -d "'\"" || true)"
HOST="${HOST:-127.0.0.1}"
if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" && "$HOST" != "::1" ]] && ! grep -q '^password:' "$CONFIG" 2>/dev/null; then
  die "配置的监听地址是 $HOST，但还没设置密码。先运行：pnpm passwd"
fi

# 服务进程的 PATH 要能找到各家 agent 的命令行（常装在 ~/.local/bin、~/.bun/bin）
SERVICE_PATH="$(dirname "$NODE"):$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

say "写入 $UNIT"
mkdir -p "$UNIT_DIR"
cat >"$UNIT" <<EOF
[Unit]
Description=agentctl 多智能体会话管理台
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/apps/server
ExecStart=$ROOT/apps/server/node_modules/.bin/tsx src/index.ts serve
Environment=PATH=$SERVICE_PATH
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3
# 停服时整组结束：网页里起的 claude 进程一并收尾（会话文件已落盘，之后可 --resume）
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF

PORT="$(sed -n 's/^port:[[:space:]]*//p' "$CONFIG" 2>/dev/null || true)"
PORT="${PORT:-8787}"
if ! systemctl --user is-active --quiet agentctl.service && command -v ss >/dev/null && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  die "端口 $PORT 已被占用（可能是手动 pnpm start 起的实例）。先停掉它再运行本脚本"
fi

systemctl --user daemon-reload
systemctl --user enable agentctl.service >/dev/null
systemctl --user restart agentctl.service
sleep 3
if ! systemctl --user is-active --quiet agentctl.service; then
  journalctl --user -u agentctl.service -n 30 --no-pager || true
  die "服务没有起来，日志见上"
fi

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo
  echo "提示：当前用户没有开启 linger，退出登录后服务会停止。需要常驻请运行："
  echo "  sudo loginctl enable-linger $USER"
fi

echo
say "agentctl 已作为用户服务运行（监听 $HOST:$PORT）"
echo "  状态   systemctl --user status agentctl"
echo "  日志   journalctl --user -u agentctl -f"
echo "  重启   systemctl --user restart agentctl     （更新代码后重新运行本脚本即可）"
echo "  卸载   scripts/install-service.sh --uninstall"
