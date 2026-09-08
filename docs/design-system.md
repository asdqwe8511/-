# 디자인 시스템

이 저장소의 화면은 **한 곳에서 나온 값만** 쓴다. 그 한 곳이 `styles/tokens.css` 다.

왜 이렇게 두는가. 지금 화면이 두 개(`index.html`, `youtube.html`)인데, 손으로 값을
적어 넣다 보니 글자 크기가 25종, 모서리가 18종, 끊는 화면 폭이 7종으로 갈라져 있었다.
세 번째 화면을 만들면 여덟 번째 회색이 생긴다. 값을 파일 하나에 모아 두면, 바꿀 때도
한 곳만 바꾸면 된다.

---

## 1. 무엇을 어디서 가져오나

| 종류 | 토큰 | 예 |
|---|---|---|
| 글꼴 | `--font-sans`, `--font-glyph` | `font-family:var(--font-sans)` |
| 글자 크기 | `--fs-50` … `--fs-900` | `font-size:var(--fs-300)` |
| 줄 간격 | `--lh-tight` / `--lh-normal` / `--lh-loose` | `line-height:var(--lh-loose)` |
| 굵기 | `--fw-normal` … `--fw-black` | `font-weight:var(--fw-bold)` |
| 색 | `--color-*` | `color:var(--color-text-dim)` |
| 간격 | `--space-1` … `--space-12` | `gap:var(--space-4)` |
| 모서리 | `--radius-xs` … `--radius-2xl`, `--radius-pill` | `border-radius:var(--radius-2xl)` |
| 그림자 | `--shadow-sm` / `--shadow-md` / `--shadow-lg` | `box-shadow:var(--shadow-sm)` |
| 시간·가속 | `--dur-fast` / `--dur` / `--dur-slow`, `--ease` | `transition:opacity var(--dur) var(--ease)` |
| 손가락 크기 | `--tap-min` / `--tap-field` / `--tap-cta` | `min-height:var(--tap-cta)` |
| 폭·층 | `--app-width`, `--z-header` / `--z-cta` / `--z-overlay` | `max-width:var(--app-width)` |

**여기 없는 값이 필요하면 화면에 적지 말고 토큰을 먼저 추가한다.** 새 값을 하나
추가하는 것과, 화면마다 다른 값을 적는 것은 결과가 전혀 다르다.

## 2. 밝은 톤 / 어두운 톤

`styles/tokens.css` 의 `:root` 가 밝은 톤, `[data-theme="dark"]` 가 어두운 톤이다.
페이지가 스스로 선언한다 — `<html lang="ko" data-theme="dark">`.

시스템 설정(`prefers-color-scheme`)을 따라 자동으로 뒤집지 않는다. 두 화면의 성격이
다르고(대시보드는 어두운 배경 전제로 색을 골랐다), 자동 전환은 두 톤 모두에서 대비를
확인해야 안전하기 때문이다. 자동 전환이 필요해지면 그때 `:root` 에
`@media (prefers-color-scheme: dark)` 블록을 더한다 — 화면 코드는 손대지 않아도 된다.

## 3. 상태와 반응

개별 화면이 각자 정하지 않도록 `tokens.css` 아래쪽에 한 번만 정해 뒀다.

- **초점(focus)** — `:focus-visible` 에만 `--color-accent` 테두리 2px. 마우스 클릭에는
  뜨지 않고 키보드로 이동할 때만 뜬다.
- **hover** — `@media (hover:none)` 에서 끈다. 손가락에는 hover 가 없어서, 켜 두면
  터치 후 스타일이 눌린 채 남는다.
- **눌림(active)** — 주 버튼은 `transform:scale(.985)`. 크기를 바꿀 뿐 색은 그대로 둔다.
- **비활성(disabled)** — `opacity:.55` + `cursor:not-allowed`. 숨기지 않는다. 왜 못 누르는지
  옆에 글로 적는다.
- **오류** — `--color-danger-weak` 바탕 + `--color-danger-line` 테두리 + `--color-danger` 글자.
  색만으로 알리지 않는다. 항상 문장을 함께 둔다.
- **움직임 줄이기** — `prefers-reduced-motion: reduce` 면 모든 전환을 1ms 로 줄인다.
  0 이 아니라 1ms 인 것은 `transitionend` 를 기다리는 코드가 멈추지 않게 하려는 것이다.

**누를 수 있는 것은 `--tap-min`(44px) 아래로 내려가지 않는다.** 입력칸은 `--tap-field`,
화면의 주 버튼은 `--tap-cta`.

**입력칸 글자는 16px(`--fs-500`) 미만으로 두지 않는다.** iOS 는 그 아래 크기의 입력에
자동으로 화면 확대를 걸어서, 탭할 때마다 레이아웃이 튄다.

## 4. 화면 폭

기준은 손에 들어오는 폭이다. 넓은 화면에서도 `--app-width`(520px)를 가운데 둬서
어디서 열든 같은 앱으로 보이게 한다.

끊는 지점은 네 개만 쓴다. CSS 변수는 미디어 쿼리 안에서 못 쓰므로 숫자를 직접 적되,
이 네 개 밖의 값은 새로 만들지 않는다.

| 이름 | 값 | 쓰는 곳 |
|---|---|---|
| xs | `max-width: 360px` | 작은 휴대폰에서 글자·간격 한 단계 줄이기 |
| sm | `max-width: 520px` | 미니앱 폭 = 화면 폭이 되는 지점 |
| md | `max-width: 760px` | 태블릿 세로. 여러 칸 → 한 칸 |
| lg | `max-width: 1024px` | 대시보드의 넓은 배치 |

## 5. 이미지와 영상

로딩 중에 레이아웃이 튀지 않게 하는 것이 전부다.

- `<img>` 에는 **항상 `width`/`height` 속성**을 적는다(또는 `.media-16x9` 같은 비율
  클래스). 브라우저가 자리를 미리 잡아야 글이 아래로 밀리지 않는다.
- 첫 화면 밖의 이미지는 `loading="lazy" decoding="async"`. 첫 화면 안의 것은 `lazy` 를
  붙이지 않는다 — 오히려 늦어진다.
- 비율이 안 맞으면 `.media-fit`(`object-fit:cover`)으로 **자른다**. 늘리거나 찌그러뜨리지
  않는다.
- `alt` 는 비워 두지 않는다. 장식용이면 `alt=""` 로 **명시**해서 낭독기가 건너뛰게 한다.
- 링크 미리보기 이미지(`og:image`)는 **1200×630**, 절대 주소로. 바꾸면 `?v=` 를 올려야
  카카오톡·슬랙 캐시가 갱신된다.
- 영상은 `playsinline muted` 없이 자동재생하지 않는다. `poster` 를 반드시 넣는다
  (없으면 첫 프레임이 뜨기 전까지 검은 사각형이 남는다).
- 자동재생 영상은 `prefers-reduced-motion: reduce` 에서 멈춘다. 배경 영상이라면 아예
  `poster` 이미지로 대체한다.
- OG 이미지를 다시 만들 때는 `tools/make-og.py` / `tools/make-og-saju.py` 를 쓴다.
  그 스크립트의 색도 `styles/tokens.css` 값과 맞춘다.

## 6. 검사

```
npm run check:design          # 토큰을 안 거친 값이 늘었는지
node tools/check-design.js --list     # 어긋난 자리를 줄 번호까지
node tools/check-design.js --update   # 지금 상태를 새 기준선으로
```

`npm test` 에 붙어 있다. 0을 요구하지는 않는다 — 이미 박혀 있는 수백 개를 한 번에
고치는 건 위험해서, **늘어나는 것만 막는다**. 값을 토큰으로 옮길 때마다 숫자가 내려가고,
`--update` 로 기준선을 조여 두면 다시 올라올 수 없다.

## 7. 토큰 교체 (외부 디자인 시스템 도입)

`styles/tokens.css` 의 값은 지금 화면이 실제로 쓰던 값을 그대로 옮겨 온 것이다.
**외부에서 가져온 값이 아니다.** 참조 시스템(<https://styles.refero.design/>)의 값으로
갈아끼울 때는 이렇게 한다.

1. 참조 시스템에서 항목별 값을 받는다 — 타이포그래피 사다리, 색, 간격, 반경, 그림자,
   모션, 상태.
2. `styles/tokens.css` 의 **값만** 바꾼다. 토큰 **이름은 바꾸지 않는다**. 이름을 바꾸면
   화면 코드를 전부 따라 고쳐야 해서, 한 곳만 바꾸려던 목적이 사라진다.
   - 참조 시스템에 우리보다 단계가 많으면(예: 글자 크기 12단계) 필요한 것만 골라
     `--fs-50 … --fs-900` 에 매핑한다. 남는 단계는 안 가져온다.
   - 우리에게만 있는 값(`--color-bar`, `--tap-cta` 같은 것)은 그대로 둔다.
3. 어두운 톤 값도 같이 받아 `[data-theme="dark"]` 에 넣는다.
4. `node tools/dev-server.js` 로 띄우고 두 화면을 직접 본다. 대비가 무너지는 곳
   (흐린 글자 `--color-text-mute` 가 배경에 묻히는지)을 먼저 확인한다.
5. `npm test`.
