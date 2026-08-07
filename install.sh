#!/usr/bin/env bash
# 装/更新「会议记录员」捆绑包(bundle)到 Forsion 家目录。
#   用法:sh install.sh [dev|prod]     缺省 dev(~/.forsion-dev);prod=~/.forsion
# 本仓即 bundle 本体:整目录拷到 <home>/plugins/meeting-recorder/ 一处即完成——
#   桌面识别 manifest.json(UI 插件);引擎(tangu-agent bundles.ts)原地读 agents/
#   (播种一次:「会议书记官」meeting-recorder-scribe)。
# 已播种的 agent 活体(tangu/agents/meeting-recorder-scribe 的 MEMORY/LOG)不受重装影响。
set -euo pipefail
MODE="${1:-dev}"
case "$MODE" in
  dev)  HOME_DIR="$HOME/.forsion-dev" ;;
  prod) HOME_DIR="$HOME/.forsion" ;;
  *) echo "用法:sh install.sh [dev|prod]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME_DIR/plugins/meeting-recorder"

# 不许从已安装目录内自更新:下面的 rm -rf 会先删掉复制源(自己),把插件卸成空壳
if [ "$HERE" = "$(cd "$DEST" 2>/dev/null && pwd || true)" ]; then
  echo "❌ 正在从已安装目录运行,请从源码仓的 forsion-plugin-meeting/ 目录执行 install.sh" >&2
  exit 2
fi

mkdir -p "$HOME_DIR/plugins"
rm -rf "$DEST"
cp -R "$HERE" "$DEST"

echo "✅ 已安装 bundle → $DEST"
echo "   (「会议书记官」agent 由引擎启动时播种到 $HOME_DIR/tangu/agents/meeting-recorder-scribe/,已存在则保留原样)"
echo "重开 Forsion(dev:重启 desktop)后:命令面板「会议记录员:打开」,或「会议记录员:立即开始录音」。"
