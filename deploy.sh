#!/bin/bash
# ASPRO 재고 대시보드 통합 배포 스크립트
# 사용법: ./deploy.sh [--skip-git] [--skip-clasp]
#
# 최초 1회 설정:
#   1. npm install -g @google/clasp
#   2. clasp login
#   3. cp .clasp.json.example .clasp.json
#   4. .clasp.json 에 실제 scriptId 입력
#      (Apps Script 에디터 URL: script.google.com/d/{scriptId}/edit)

set -e

SKIP_GIT=false
SKIP_CLASP=false
for arg in "$@"; do
  [[ "$arg" == "--skip-git" ]]   && SKIP_GIT=true
  [[ "$arg" == "--skip-clasp" ]] && SKIP_CLASP=true
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

echo "=== ASPRO 통합 배포 ==="

# ── 1. GitHub push ──────────────────────────────────────────────
if [ "$SKIP_GIT" = false ]; then
  echo ""
  echo "▶ [1/2] GitHub push..."

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "  변경된 파일:"
    git status --short
    echo ""
    read -rp "  커밋 메시지를 입력하세요: " COMMIT_MSG
    if [[ -z "$COMMIT_MSG" ]]; then
      COMMIT_MSG="chore: update $(date '+%Y-%m-%d %H:%M')"
    fi
    git add -A
    git commit -m "$COMMIT_MSG"
  else
    echo "  변경 없음 — git push만 진행"
  fi

  git push origin main
  echo "  ✅ GitHub push 완료"
else
  echo "▶ [1/2] GitHub push 건너뜀 (--skip-git)"
fi

# ── 2. Google Apps Script push ──────────────────────────────────
if [ "$SKIP_CLASP" = false ]; then
  echo ""
  echo "▶ [2/2] Apps Script push..."

  if ! command -v clasp &> /dev/null; then
    echo "  ⚠️  clasp 미설치. 설치 후 다시 실행하세요:"
    echo "     npm install -g @google/clasp && clasp login"
    exit 1
  fi

  if [[ ! -f ".clasp.json" ]]; then
    echo "  ⚠️  .clasp.json 없음. 설정 방법:"
    echo "     cp .clasp.json.example .clasp.json"
    echo "     # 그 후 scriptId를 실제 값으로 수정"
    exit 1
  fi

  clasp push --force
  echo "  ✅ Apps Script push 완료"
else
  echo "▶ [2/2] Apps Script push 건너뜀 (--skip-clasp)"
fi

echo ""
echo "=== 배포 완료 ==="
