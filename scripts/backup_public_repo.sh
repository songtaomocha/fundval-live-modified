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

# 同步代码（自动排除敏感/运行态数据）
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

git add -A
if git diff --cached --quiet; then
  echo "[$(date '+%F %T')] no changes to backup"
  exit 0
fi

git commit -m "backup: automated daily snapshot $(date '+%F %T')"
GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git push origin "$BRANCH"

echo "[$(date '+%F %T')] backup pushed successfully"