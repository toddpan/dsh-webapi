#!/usr/bin/env bash
# =============================================================================
# dsh-web-service SKILL 一键在线安装脚本
#
# 用途：从 GitHub 在线拉取 dsh-web-service 插件的 SKILL.md，
#       安装到当前用户的 DSH skill 目录（~/.dsh/skills/dsh-web-service/），
#       让 AI 智能体即刻学会如何调用 DSH Web Service API。
#
# 一键安装：
#   curl -fsSL https://raw.githubusercontent.com/toddpan/dsh-webapi/main/scripts/install-skill.sh | bash
#
# 指定安装位置（可选）：
#   curl -fsSL ... | bash -s -- --dir ~/.dsh/skills          # 用户级（默认）
#   curl -fsSL ... | bash -s -- --dir /path/to/proj/.dsh/skills  # 项目级
#   curl -fsSL ... | bash -s -- --dir /path/to/.agents/skills    # agents 约定目录
#
# 卸载：
#   dsh-web-service-skill uninstall
# =============================================================================
set -euo pipefail

REPO="toddpan/dsh-webapi"
BRANCH="${DSH_WEBAPI_BRANCH:-main}"
SKILL_NAME="dsh-web-service"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

# ---------- 参数解析 ----------
TARGET_DIR="${HOME}/.dsh/skills"
MODE="install"
while [[ $# -gt 0 ]]; do
  case "$1" in
    uninstall)
      MODE="uninstall"
      shift
      ;;
    --dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
      shift 2
      ;;
    --repo)
      REPO="$2"
      RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $1（用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

INSTALL_DIR="${TARGET_DIR%/}/${SKILL_NAME}"
SKILL_FILE="${INSTALL_DIR}/SKILL.md"

# ---------- 卸载入口 ----------
if [[ "${MODE}" == "uninstall" || "${DSH_SKILL_UNINSTALL:-}" == "1" ]]; then
  if [[ -d "${INSTALL_DIR}" ]]; then
    rm -rf "${INSTALL_DIR}"
    echo "✓ 已卸载 SKILL: ${INSTALL_DIR}"
  else
    echo "ℹ️ 未发现已安装的 SKILL: ${INSTALL_DIR}"
  fi
  exit 0
fi

# ---------- 下载工具探测 ----------
fetch() {
  # fetch <url> <output>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 10 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=10 -O "$2" "$1"
  else
    echo "✗ 需要 curl 或 wget 之一来下载文件" >&2
    exit 1
  fi
}

echo "=== dsh-web-service SKILL 在线安装 ==="
echo "  仓库:    https://github.com/${REPO} (branch: ${BRANCH})"
echo "  安装到:  ${INSTALL_DIR}"

# ---------- 下载 SKILL.md ----------
TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

if ! fetch "${RAW_BASE}/skills/${SKILL_NAME}/SKILL.md" "${TMP_FILE}"; then
  echo "✗ 下载失败：无法获取 ${RAW_BASE}/skills/${SKILL_NAME}/SKILL.md" >&2
  echo "  请检查网络，或手动下载后放到 ${SKILL_FILE}" >&2
  exit 1
fi

# 校验内容基本合法（frontmatter 必须有 name 和 description）
if ! grep -q '^name:' "${TMP_FILE}" || ! grep -q '^description:' "${TMP_FILE}"; then
  echo "✗ 下载内容不是合法的 SKILL.md（缺少 frontmatter），已中止" >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}"
mv "${TMP_FILE}" "${SKILL_FILE}"
trap - EXIT

echo "✓ SKILL.md 已安装: ${SKILL_FILE}"

# ---------- 尝试本地验证 DSH Web Service 可达性 ----------
STATUS_URL=""
for port in 3080 3000; do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --connect-timeout 2 "http://127.0.0.1:${port}/api/v1/system/status" >/dev/null 2>&1; then
      STATUS_URL="http://127.0.0.1:${port}/api/v1"
      break
    fi
  fi
done

if [[ -n "${STATUS_URL}" ]]; then
  echo "✓ 检测到 DSH Web Service 在线: ${STATUS_URL}"
else
  echo "⚠️  未检测到运行中的 DSH Web Service（已尝试端口 3080/3000）"
  echo "    SKILL 已安装，但使用前请先在 DSH 中注入 dsh-web-service 插件："
  echo "    dev_inject_plugin <dsh-web-service 插件目录>"
fi

echo
echo "完成！AI 智能体现在可以通过 skill 名称 '${SKILL_NAME}' 加载完整使用说明。"
echo "  - DSH 会话内：模型可通过 skill 目录自动发现；用户可用 /${SKILL_NAME} 直接调用"
echo "  - 卸载：rm -rf ${INSTALL_DIR}"
