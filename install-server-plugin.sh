#!/usr/bin/env sh
set -eu
umask 077
command -v git >/dev/null 2>&1 || { printf '安装失败：未找到 Git。\n'; exit 1; }
INSTALL_ROOT=$(pwd -P)
[ "$INSTALL_ROOT" != / ] || { printf '请在 SillyTavern 安装目录运行。\n'; exit 1; }
DEPLOYMENT=native
if [ -f ./config.yaml ] && [ ! -L ./config.yaml ]; then
  CONFIG_FILE="$INSTALL_ROOT/config.yaml"
elif [ -f ./config/config.yaml ] && [ ! -L ./config ] && [ ! -L ./config/config.yaml ]; then
  DEPLOYMENT=docker
  CONFIG_FILE="$INSTALL_ROOT/config/config.yaml"
  COMPOSE_FILE=''
  for candidate in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then COMPOSE_FILE=$candidate; break; fi
  done
  if [ -z "$COMPOSE_FILE" ] || ! grep -Eq '/home/node/app/plugins' "$COMPOSE_FILE"; then
    printf '安装暂停：请核对 Compose 挂载；服务的 volumes 下应有 "./plugins:/home/node/app/plugins"。\n'
    exit 1
  fi
else
  printf '请进入有 config.yaml 的原生目录，或有 config/config.yaml 与 Compose 文件的 Docker 目录。\n'
  exit 1
fi
if [ "${QIANMU_SERVER_STOPPED:-}" != 1 ]; then
  printf '请先等待生成结束并停止 ST 后端。确认已停止后输入 STOPPED：' >/dev/tty 2>/dev/null || true
  answer=''
  if ! read -r answer </dev/tty 2>/dev/null || [ "$answer" != STOPPED ]; then
    printf '安装已暂停。无人值守须由操作者确认停服，再设置 QIANMU_SERVER_STOPPED=1。\n'
    exit 1
  fi
fi
# This confirmation does not prove that arbitrary ST/container processes stopped.
INSTALL_LOCK="$INSTALL_ROOT/.qianmu-installer.lock"
if ! mkdir "$INSTALL_LOCK" 2>/dev/null; then printf '另一个安装正在进行或留下维护锁，请先核查，不要同时安装。\n'; exit 1; fi
INSTALL_OWNER=$(mktemp "$INSTALL_LOCK/owner.XXXXXX")
TEMP_FILE=''
INTERRUPTED=0
cleanup_install() {
  [ "$INTERRUPTED" = 0 ] || return
  [ -z "$TEMP_FILE" ] || [ ! -f "$TEMP_FILE" ] || rm -f -- "$TEMP_FILE"
  [ ! -L "$INSTALL_LOCK" ] && [ -f "$INSTALL_OWNER" ] && [ ! -L "$INSTALL_OWNER" ] || return
  rm -f -- "$INSTALL_OWNER"
  rmdir "$INSTALL_LOCK"
}
trap cleanup_install EXIT
trap 'INTERRUPTED=1; exit 1' HUP INT TERM
PLUGIN_PARENT="$INSTALL_ROOT/plugins"
PLUGIN_DIR="$PLUGIN_PARENT/Omniscene"
[ ! -L "$PLUGIN_PARENT" ] && [ ! -L "$PLUGIN_DIR" ] || { printf '插件目标是链接，未跟随。\n'; exit 1; }
if [ -e "$PLUGIN_PARENT" ] && [ ! -d "$PLUGIN_PARENT" ]; then printf '插件父目录不是文件夹。\n'; exit 1; fi
PREVIOUS_COMMIT=''
if [ -e "$PLUGIN_DIR" ]; then
  if [ ! -d "$PLUGIN_DIR/.git" ] || [ -L "$PLUGIN_DIR/.git" ]; then printf '原插件不是 Git 安装，未覆盖。\n'; exit 1; fi
  DIRTY=$(git -C "$PLUGIN_DIR" status --porcelain) || { printf '无法核查插件，未覆盖。\n'; exit 1; }
  if [ -n "$DIRTY" ]; then printf '原插件有本地改动，未覆盖。\n'; exit 1; fi
  PREVIOUS_COMMIT=$(git -C "$PLUGIN_DIR" rev-parse HEAD)
  printf '%s\n' "$PREVIOUS_COMMIT" | grep -Eq '^[a-f0-9]{40,64}$' || { printf '无法确认原插件版本。\n'; exit 1; }
fi
BOM=$(printf '\357\273\277')
if ! awk -v BINMODE=3 -v bom="$BOM" '
  NR==1 { sub("^" bom,"",$0) }
  /^---[[:space:]]*$/ { documents++ }
  /^\.\.\.[[:space:]]*$/ { bad=1 }
  /^[[:space:]]*[\{\[]/ { bad=1 }
  /^["\047]?enableServerPlugins["\047]?[[:space:]]*:/ {
    keys++; if ($0 !~ /^["\047]?enableServerPlugins["\047]?[[:space:]]*:[[:space:]]*(true|false)[[:space:]]*(#.*)?$/) bad=1
  }
  END { exit (bad || documents>1 || keys>1) ? 1 : 0 }
' "$CONFIG_FILE"; then printf '配置开关含重复或非常规格式，请先核查。\n'; exit 1; fi
BACKUP_FILE=$(mktemp "${CONFIG_FILE}.qianmu-backup.XXXXXX")
cp -p "$CONFIG_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
printf '%s\n' "$PREVIOUS_COMMIT" > "${BACKUP_FILE}.ref"
if [ -n "$PREVIOUS_COMMIT" ]; then
  if ! git -c core.hooksPath="$BACKUP_FILE.hooks-disabled" -C "$PLUGIN_DIR" pull --ff-only; then printf '更新失败，ST 配置未修改。备份：%s\n' "$BACKUP_FILE"; exit 1; fi
else
  STAGE=$(mktemp -d "$INSTALL_ROOT/.qianmu-install.XXXXXX")
  if ! git clone https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git "$STAGE/source"; then
    printf '下载失败，未启用插件；暂存保留于 %s\n' "$STAGE"; exit 1
  fi
  for file in server-plugin.js package.json; do
    [ -f "$STAGE/source/$file" ] && [ ! -L "$STAGE/source/$file" ] || { printf '下载内容不完整，未启用。\n'; exit 1; }
  done
  mkdir -p "$PLUGIN_PARENT"
  [ ! -L "$PLUGIN_PARENT" ] && [ ! -e "$PLUGIN_DIR" ] || { printf '插件目录在下载期间已变化，未覆盖。\n'; exit 1; }
  # Fixed validated descendants only; no recursive cleanup or glob moves.
  mv "$STAGE/source" "$PLUGIN_DIR"
fi
for file in server-plugin.js package.json; do
  [ -f "$PLUGIN_DIR/$file" ] && [ ! -L "$PLUGIN_DIR/$file" ] || { printf '代码入口不完整，配置未修改。\n'; exit 1; }
done
INSTALLED_COMMIT=$(git -C "$PLUGIN_DIR" rev-parse HEAD)
printf '%s\n' "$INSTALLED_COMMIT" | grep -Eq '^[a-f0-9]{40,64}$' || { printf '无法确认安装版本，配置未修改。\n'; exit 1; }
if [ -L "$CONFIG_FILE" ] || ! cmp -s "$BACKUP_FILE" "$CONFIG_FILE"; then
  printf '配置在安装期间已变化，保留改动，未覆盖。备份：%s\n' "$BACKUP_FILE"; exit 1
fi
TEMP_FILE=$(mktemp "${CONFIG_FILE}.qianmu-new.XXXXXX")
cp -p "$CONFIG_FILE" "$TEMP_FILE"
awk -v BINMODE=3 -v bom="$BOM" '
  NR==1 { marked=(index($0,bom)==1); sub("^" bom,"",$0); eol=($0 ~ /\r$/) ? "\r" : "" }
  /^["\047]?enableServerPlugins["\047]?[[:space:]]*:/ {
    sub(/^["\047]?enableServerPlugins["\047]?[[:space:]]*:[[:space:]]*(true|false)/,"enableServerPlugins: true"); found=1
  }
  { print ((NR==1 && marked) ? bom : "") $0 }
  END { if (!found) { print eol; print "enableServerPlugins: true" eol } }
' "$CONFIG_FILE" > "$TEMP_FILE"
if [ -L "$CONFIG_FILE" ] || ! cmp -s "$BACKUP_FILE" "$CONFIG_FILE"; then printf '写入前配置已变化，未覆盖。\n'; exit 1; fi
mv -f "$TEMP_FILE" "$CONFIG_FILE"
TEMP_FILE=''
printf '千幕服务端已安装/更新，版本节点：%s\n配置备份：%s；原插件节点保存在同名 .ref 文件。\n' "$INSTALLED_COMMIT" "$BACKUP_FILE"
if [ "$DEPLOYMENT" = docker ]; then
  printf '本脚本没有重启容器。请按原方式启动；常见服务名可使用 docker compose start sillytavern。\n'
else
  printf '请按原方式启动 SillyTavern 后端，再刷新网页；本脚本不会停止或重启进程。\n'
fi
printf '健康检查：ST 地址后加 /api/plugins/qianmu-tts/health；它不代表上游生图已验收。\n'
