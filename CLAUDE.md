# 이 저장소에서 일할 때

생년월일시를 넣으면 사주·이름·궁합·택일을 풀어 주는 공개 웹 앱과, YouTube 인기영상
대시보드가 한 프로젝트에 들어 있습니다. 빌드 단계가 없는 정적 파일 + Vercel 서버리스
함수 구성입니다. 구조와 배포는 `README.md` 를 보세요.

## 세션 시작할 때

첫 도구 호출 전에 `task-observer` 스킬을 켜세요. 작업을 지켜보다가 스킬로 만들
만한 것들을 기록합니다. 기록은 프로젝트마다 흩어지지 않게
`~/.claude/skill-observations/` 한 곳에 쌓습니다.

스킬은 `.claude/skills/` 에 파일로 들어 있어 저장소를 받으면 그대로 잡힙니다
(`task-observer`, `find-skills`, `design-taste-frontend`, `mcp-builder`).
플러그인 넷도 `.claude/settings.json` 에 등록돼 있어 폴더를 신뢰하겠다고 한 번
답하면 붙습니다. 갱신하는 법과 나머지 도구 구성은 `docs/claude-code-setup.md`
를 보세요.

## 손대는 순서

- 계산 로직은 `saju-engine.js` 한 곳에만 있습니다. 브라우저(`index.html`)와
  서버(`api/saju.js`)가 같은 파일을 씁니다. 한쪽에만 고치지 마세요.
- 한자 후보표는 `hanja-data.js` 이고 `tools/build-hanja.js` 가 생성합니다.
  손으로 고치지 말고 생성 스크립트를 고쳐서 다시 만드세요.
- UI 는 `index.html` / `youtube.html` 안에 CSS·JS 까지 다 들어 있습니다.
  파일을 쪼개지 마세요.

## 확인

```bash
npm test          # 사주 계산 + 사용량 제한
npm run dev       # http://localhost:3000
```

계산 쪽을 건드렸으면 `npm test` 는 반드시 통과시키고 커밋하세요.

## 지키는 선

- API 키는 서버(Vercel 환경변수)에만 둡니다. 브라우저로 내려가는 코드에 키를
  넣지 마세요.
- 사용자가 넣은 생년월일은 서버에 저장하지 않습니다. 로그에도 남기지 마세요.
