# 인기영상 대시보드 (온라인 버전)

로컬 HTML 파일이 아니라, 비밀번호로 잠긴 **개인용 온라인 사이트**입니다.
- YouTube API 키는 서버(Vercel)에만 저장되고 브라우저에는 절대 노출되지 않습니다.
- 사이트 전체가 공유 비밀번호 1개로 잠겨 있습니다. 초대하고 싶은 사람에게는 **사이트 URL + 비밀번호**만 알려주면 됩니다.
- 로그인은 30일짜리 쿠키로 유지됩니다.

## 아키텍처

```
index.html, login.html   →  정적 파일 (누구나 접속은 가능, 하지만 데이터는 안 뜸)
api/login.js              →  비밀번호 확인 후 로그인 쿠키 발급
api/logout.js             →  로그인 쿠키 삭제
api/yt/[...path].js       →  실제 YouTube Data API 호출을 대신 해주는 프록시.
                              쿠키가 유효할 때만 동작하고, 여기서만 API 키를 씀.
```

브라우저는 `googleapis.com`을 직접 호출하지 않고, 항상 우리 사이트의 `/api/yt/...`를
거칩니다. 로그인 안 한 사람이 `/index.html`에 들어와도 화면만 보일 뿐 데이터 호출은
전부 401로 막혀서 로그인 페이지로 튕겨납니다.

**참고**: 채널 파인더의 성장 히스토리(일별 구독자/조회수 스냅샷)와 즐겨찾기는
서버가 아니라 **각자의 브라우저(localStorage)** 에 저장됩니다. 초대받은 사람마다
자기 브라우저 기준으로 데이터가 쌓이며, 서로 공유되지는 않습니다.

---

## 배포 순서 (처음 한 번만)

### 1. GitHub에 이 폴더 올리기

1. https://github.com/new 에서 새 저장소 생성 (이름 예: `channel-finder-web`, **Private** 추천)
2. 이 폴더(`channel-finder-web`)에서 아래 명령 실행 (직접 터미널에서, GitHub 로그인 창이 뜨면 본인이 로그인):

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<본인아이디>/channel-finder-web.git
git push -u origin main
```

### 2. Vercel 가입 + 프로젝트 연결

1. https://vercel.com/signup 에서 **Continue with GitHub** 로 가입/로그인 (본인이 직접)
2. 대시보드에서 **Add New → Project**
3. 방금 만든 `channel-finder-web` 저장소 선택 → **Import**
4. Framework Preset은 **Other** 로 두면 됩니다 (별도 빌드 명령 필요 없음)

### 3. 환경변수 설정 (배포 전에 필수)

Vercel 프로젝트의 **Settings → Environment Variables** 에서 아래 3개를 추가하세요.

| 이름 | 값 | 설명 |
|---|---|---|
| `YOUTUBE_API_KEY` | 본인의 YouTube Data API 키 | Google Cloud Console에서 발급받은 키 |
| `SITE_PASSWORD` | 원하는 비밀번호 | 초대할 사람에게 알려줄 공유 비밀번호 |
| `SESSION_SECRET` | 아무 임의의 긴 문자열 | 로그인 쿠키 서명용. 예: 아래 명령으로 생성 |

`SESSION_SECRET`은 터미널에서 이렇게 만들 수 있어요 (뭐가 나오든 그대로 붙여넣으면 됩니다):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Node가 없다면 아무 웹 "랜덤 문자열 생성기"에서 32자 이상짜리 하나 만들어 써도 됩니다.
(외부 API 키나 진짜 비밀번호가 아니라 단순 서명용 문자열이라 이 방식도 괜찮습니다.)

환경변수 3개를 추가한 뒤 **Deploy** 버튼을 누르세요.

### 4. 배포 확인

배포가 끝나면 `https://<프로젝트이름>.vercel.app` 같은 URL이 생깁니다.

1. 그 URL로 접속 → 자동으로 `/login.html`은 아니고 `/index.html`이 뜰 수 있는데,
   데이터 호출이 바로 401이 나면서 알아서 `/login.html`로 이동합니다.
2. 처음엔 `https://<프로젝트이름>.vercel.app/login.html` 로 바로 들어가도 됩니다.
3. Vercel에 설정한 `SITE_PASSWORD`를 입력 → 로그인되면 대시보드가 뜨고 데이터를 불러옵니다.

---

## 다른 사람 초대하기

계정을 따로 만들어줄 필요 없이, 그냥 이 두 가지만 알려주면 됩니다:
- 사이트 주소: `https://<프로젝트이름>.vercel.app`
- 비밀번호: Vercel에 설정한 `SITE_PASSWORD`

## 비밀번호 바꾸고 싶을 때 / 특정 사람만 차단하고 싶을 때

- Vercel → Settings → Environment Variables 에서 `SITE_PASSWORD` 값을 바꾸고 재배포(Redeploy)하면
  기존에 로그인했던 사람들도 다음 로그인부터 새 비밀번호가 필요합니다.
- 단, 이미 발급된 30일짜리 로그인 쿠키를 가진 사람은 만료 전까지는 재로그인 없이 계속 쓸 수 있어요.
  즉시 전부 로그아웃시키고 싶다면 `SESSION_SECRET` 값도 같이 바꿔서 재배포하세요 (기존 쿠키가 전부 무효화됩니다).

## 업데이트하고 싶을 때

코드를 수정한 뒤:

```bash
git add .
git commit -m "설명"
git push
```

GitHub에 푸시하면 Vercel이 자동으로 재배포합니다 (GitHub 연동이 되어 있으면 별도 조작 불필요).

## 참고: 유튜브 API 쿼터

여러 명이 같이 써도 서버에 저장된 API 키 **하나**를 공유합니다. 하루 10,000 유닛 중,
"새로고침" 한 번에 국가 4개 기준 대략 20~30 유닛 정도 소모되니, 여러 명이 자주 눌러도
넉넉한 편입니다. 혹시 쿼터가 부족해지면 Google Cloud Console에서 쿼터 늘리기를
신청하거나, `YOUTUBE_API_KEY`를 다른 프로젝트 키로 교체하면 됩니다.
