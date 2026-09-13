#!/usr/bin/env bash
# task-observer 스킬을 .claude/skills/task-observer 에 받아 놓는다.
# 처음 받을 때도, 최신으로 올릴 때도 같은 명령을 쓴다.
#
# 이 스킬은 남의 저장소 코드라 여기에 커밋하지 않는다(.gitignore 참고).
# 대신 쓰는 사람이 각자 이 스크립트로 받는다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.claude/skills/task-observer"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 https://github.com/rebelytics/one-skill-to-rule-them-all "$TMP/src"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$TMP/src/SKILL.md" "$TMP/src/LICENSE.txt" "$DEST/"
cp -r "$TMP/src/references" "$TMP/src/scripts" "$DEST/"

COMMIT="$(git -C "$TMP/src" rev-parse HEAD)"
DATE="$(git -C "$TMP/src" log -1 --format=%cs)"
printf '원본: %s\n받은 커밋: %s (%s)\n라이선스: CC BY 4.0 — LICENSE.txt 참고\n' \
  "https://github.com/rebelytics/one-skill-to-rule-them-all" "$COMMIT" "$DATE" > "$DEST/SOURCE.md"

echo "완료: $DEST"
echo "  커밋 $COMMIT ($DATE)"
echo "  클로드 코드를 다시 열면 task-observer 스킬이 잡힙니다."
