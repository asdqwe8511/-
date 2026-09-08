# 이 저장소에서 작업할 때

## UI·이미지·영상은 디자인 시스템을 거친다

**색, 글자 크기, 줄 간격, 간격, 모서리, 그림자, 전환 시간을 코드에 직접 적지 않는다.**
`styles/tokens.css` 의 `var(--…)` 만 쓴다.

- 화면(HTML/CSS)을 만들거나 고칠 때 → 먼저 `docs/design-system.md` 를 읽는다.
- 필요한 값이 토큰에 없으면 → **`styles/tokens.css` 에 토큰을 추가하고** 화면에서는
  그 토큰을 쓴다. 화면에 값을 적어 두고 넘어가지 않는다.
- 새 페이지를 만들 때 → `<link rel="stylesheet" href="/styles/tokens.css">` 를 넣고,
  어두운 톤이면 `<html data-theme="dark">` 로 선언한다.
- 이미지·영상 → `docs/design-system.md` 5절(자리 미리 잡기, `object-fit`, `alt`,
  `poster`, OG 1200×630)을 따른다.
- 상태·반응(초점·hover·눌림·비활성·오류·움직임 줄이기·손가락 44px·입력 16px)은
  같은 문서 3절에 정해져 있다. 화면마다 새로 정하지 않는다.

작업을 끝내기 전에:

```
npm run check:design
```

토큰을 안 거친 값이 **늘어나면 실패한다**. 실패하면 `--list` 로 자리를 찾아 토큰으로
바꾼다. 기존 값을 토큰으로 옮겨서 숫자가 줄었다면 `--update` 로 기준선을 조인다.

토큰 값 자체를 외부 디자인 시스템(<https://styles.refero.design/>)으로 갈아끼우는
절차는 `docs/design-system.md` 7절에 있다. 값만 바꾸고 **토큰 이름은 바꾸지 않는다.**

## 화면을 고쳤으면 눈으로 확인한다

```
node tools/dev-server.js        # http://localhost:3000
npm test                        # 계산 검증 + 디자인 토큰 검사
```

`index.html` 은 밝은 톤 미니앱(`--app-width` 520px 기준), `youtube.html` 은 어두운 톤
대시보드다. 둘은 같은 토큰을 쓰고 톤만 다르다 — 한쪽만 고쳐서 갈라지게 두지 않는다.
