# 인기영상 대시보드

YouTube의 국가별 실시간 인기영상과 채널 정보를 보여주는 공개 웹 대시보드입니다.

- 로그인 없이 누구나 바로 볼 수 있습니다.
- YouTube API 키는 서버(Vercel 환경변수)에만 있고 브라우저에는 절대 노출되지 않습니다.

## 아키텍처

```
index.html            정적 페이지 (대시보드 UI 전체)
api/yt/[...path].js   YouTube Data API 프록시.
                       - 허용된 읽기 엔드포인트(videos/videoCategories/channels)만 전달
                       - 성공 응답은 Vercel 엣지에서 30분간 캐시
                       - 여기서만 API 키를 사용
og-image.png          링크 미리보기 이미지 (카카오톡/슬랙 등)
favicon.png           브라우저 탭 아이콘
tools/make-og.py      위 두 이미지 생성 스크립트
```

브라우저는 `googleapis.com`을 직접 호출하지 않고 항상 `/api/yt/...`를 거칩니다.

### 할당량 보호

사이트가 공개되어 있으므로 프록시도 누구나 호출할 수 있습니다. 두 가지로 방어합니다.

1. **엔드포인트 허용 목록** — 임의의 구글 API로 중계할 수 없습니다.
2. **엣지 캐싱** — 성공 응답을 30분간 CDN에 캐시합니다. 방문자가 몇 명이든
   YouTube 호출량은 거의 일정하게 유지되므로, 로그인이 있던 때보다 오히려
   할당량을 적게 씁니다.

## 환경변수

Vercel 프로젝트의 **Settings → Environment Variables** 에 아래 하나만 있으면 됩니다.

| 이름 | 값 |
|---|---|
| `YOUTUBE_API_KEY` | Google Cloud Console에서 발급한 YouTube Data API v3 키 |

> 예전에 쓰던 `SITE_PASSWORD` / `SESSION_SECRET` 은 로그인 기능을 없애면서
> 더 이상 사용하지 않습니다. 남아 있어도 무해하지만 지워도 됩니다.

환경변수를 바꾼 뒤에는 **Deployments → 맨 위 배포의 ⋯ → Redeploy** 를 해야 반영됩니다.

## 배포

GitHub에 푸시하면 Vercel이 자동으로 재배포합니다.

```bash
git add .
git commit -m "설명"
git push
```

## 링크 미리보기 이미지 수정

`tools/make-og.py` 를 고친 뒤 실행하면 `og-image.png` 와 `favicon.png` 가 다시 생성됩니다.

```bash
python tools/make-og.py
```

카카오톡·페이스북은 미리보기를 캐시하므로, 바꾼 뒤에도 예전 이미지가 보이면
[카카오 디버거](https://developers.kakao.com/tool/debugger/sharing)에서 캐시를 초기화하거나
링크 뒤에 `?v=3` 같은 파라미터를 붙여 공유하세요.

## 참고: 유튜브 API 할당량

하루 10,000 유닛입니다. 엣지 캐시 덕분에 30분에 한 번 정도만 실제 호출이
발생하므로 일반적인 사용에서는 넉넉합니다.
