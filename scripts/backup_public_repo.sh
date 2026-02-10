#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="/home/songtaomocha/.openclaw/workspace/fundval-live"
WORK_DIR="/tmp/fundval-live-public-backup"
REPO_SSH="git@github.com:songtaomocha/fundval-live-modified.git"
DEPLOY_KEY="/home/songtaomocha/.ssh/fundval_live_modified_deploy"
BRANCH="main"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

git init -b "$BRANCH"
git config user.name "songtaomocha"
git config user.email "songtaomocha@users.noreply.github.com"
git remote add origin "$REPO_SSH"

# 拉取远端（存在则基于远端，避免强推）
GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git fetch origin "$BRANCH" || true
if GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git checkout -B "$BRANCH" "origin/$BRANCH"
else
  git checkout -B "$BRANCH"
fi

# 同步代码（先按路径排除已知敏感/运行态数据）
rsync -a --delete \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env*' \
  --exclude='backend/data/fund.db' \
  --exclude='backend/data/fund.db-shm' \
  --exclude='backend/data/fund.db-wal' \
  --exclude='backend/data/.auth_secret' \
  --exclude='backend/data/.encryption_key' \
  --exclude='**/token.json' \
  "$SRC_DIR"/ "$WORK_DIR"/

# 备份后再扫一遍：发现敏感信息立即清除（删除文件或脱敏）
echo "[$(date '+%F %T')] running sensitive scan..."

# A) 按文件名/路径兜底删除
find "$WORK_DIR" -type f \( \
  -name '.env' -o -name '.env.*' -o \
  -name 'fund.db' -o -name 'fund.db-shm' -o -name 'fund.db-wal' -o \
  -name '.auth_secret' -o -name '.encryption_key' -o \
  -name 'token.json' \
\) -print -delete || true

# B) 文本内容高置信命中 -> 立即脱敏
# 说明：仅处理文本文件；二进制文件自动跳过（grep -I）
MATCH_FILES=$(grep -IRlE --exclude-dir=.git \
  '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})' \
  "$WORK_DIR" || true)

if [ -n "$MATCH_FILES" ]; then
  echo "[$(date '+%F %T')] sensitive content found, redacting..."
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # 逐项脱敏（尽量保留文件结构，避免误删代码）
    sed -E -i \
      -e 's#Bearer[[:space:]]+[A-Za-z0-9._-]{20,}#Bearer REDACTED#g' \
      -e 's#sk-[A-Za-z0-9_-]{20,}#sk-REDACTED#g' \
      -e 's#AIza[0-9A-Za-z_-]{20,}#AIzaREDACTED#g' \
      "$f" || true

    # 私钥块直接整块替换
    if grep -Iq 'PRIVATE KEY' "$f"; then
      awk '
        BEGIN{inkey=0}
        /-----BEGIN .*PRIVATE KEY-----/{print "[REDACTED_PRIVATE_KEY]"; inkey=1; next}
        /-----END .*PRIVATE KEY-----/{inkey=0; next}
        {if(!inkey) print $0}
      ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    fi
  done <<< "$MATCH_FILES"
fi

# 二次确认：若仍有高危内容，直接删除命中文件
REMAINING=$(grep -IRlE --exclude-dir=.git '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})' "$WORK_DIR" || true)
if [ -n "$REMAINING" ]; then
  echo "[$(date '+%F %T')] still sensitive after redaction, deleting files..."
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    echo "delete: $f"
    rm -f "$f"
  done <<< "$REMAINING"
fi

git add -A
if git diff --cached --quiet; then
  echo "[$(date '+%F %T')] no changes to backup"
  exit 0
fi

git commit -m "backup: automated daily snapshot $(date '+%F %T')"
GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git push origin "$BRANCH"

echo "[$(date '+%F %T')] backup pushed successfully"