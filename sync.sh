#!/bin/bash
# Sync to Hetzner VPS via git
# Usage: ./sync.sh [bot|workspace|all]

VPS="root@204.168.169.186"

sync_bot() {
  echo "=== Syncing bot (git push → pull) ==="
  cd /Users/kostiantyn.vlasenko/Projects/claude-discord-supercharged
  git add -A && git commit -m "sync: update bot" 2>/dev/null || true
  git push
  ssh "$VPS" 'su - claudebot -c "cd /home/claudebot/app && git pull && /home/claudebot/.bun/bin/bun install --production"'
  ssh "$VPS" 'systemctl restart claude-discord-bot'
  echo "=== Bot synced and restarted ==="
}

sync_workspace() {
  echo "=== Syncing workspace (git pull) ==="
  ssh "$VPS" 'su - claudebot -c "cd /home/claudebot/workspace && git pull"'
  echo "=== Workspace synced ==="
}

case "${1:-all}" in
  bot)       sync_bot ;;
  workspace) sync_workspace ;;
  all)       sync_bot; sync_workspace ;;
  *)         echo "Usage: $0 [bot|workspace|all]" ;;
esac
