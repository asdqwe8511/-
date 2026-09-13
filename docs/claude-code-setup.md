# 클로드 코드 확장 정리

릴스에서 소개된 것들을 이 저장소에 맞춰 정리했습니다. 처음 다섯 가지가 1~3절,
나중에 추가한 다섯 가지가 4절입니다. 이름만 보면 다 같은 "플러그인" 같지만
실제로는 플러그인·스킬·외부 CLI 가 섞여 있어 설치 방법이 제각각입니다.

## 첫 묶음 다섯 가지

| 이름 | 하는 일 | 성격 | 이 저장소에 들어온 것 |
| --- | --- | --- | --- |
| OmniRoute | 무료 API 게이트웨이로 요청을 돌려 토큰을 아낌 | 외부 CLI | 설치 방법만 (아래) |
| claude-mem | 세션이 끝나도 작업 기억을 이어 줌 | 플러그인 | `.claude/settings.json` 에 등록됨 |
| Headroom | 안 쓰는 출력은 버리고 필요한 것만 압축해 보냄 | 외부 CLI 래퍼 | 설치 방법만 (아래) |
| claude-code-setup | 코드베이스를 보고 훅·스킬·에이전트·MCP 를 추천 | 플러그인 | `.claude/settings.json` 에 등록됨 |
| task-observer | 작업을 지켜보며 스킬로 만들 거리를 기록 | 스킬 | `.claude/skills/` 에 포함됨 |

(두 번째 묶음은 「4. 두 번째 묶음 다섯 가지」에 있습니다.)

전부 클로드 코드 설정이나 컴퓨터를 건드리는 것이라, 저장소에는 설치 방법과
스크립트만 넣었습니다. 아래 명령을 한 번씩 실행하면 됩니다.

**모든 프로젝트에 똑같이 적용하려면** 아래 「0. 전부 전역으로」를 그대로 따라
하세요. 나머지 절은 각 도구를 하나씩 설명한 것입니다.

---

## 0. 전부 전역으로 — 모든 코드에서 똑같이 작동하게

컴퓨터에서 한 번만 실행하면 어느 폴더에서 클로드 코드를 켜도 같은 구성이 됩니다.

```bash
# 1) 플러그인 둘 — --scope user 가 핵심. 모든 프로젝트에 붙는다.
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-code-setup@claude-plugins-official --scope user
claude plugin install claude-mem@thedotmack --scope user

# 2) 스킬 넷 — 저장소가 아니라 홈에 둔다 (-g)
npx skills add https://github.com/rebelytics/one-skill-to-rule-them-all --skill task-observer -g
npx skills add https://github.com/vercel-labs/skills --skill find-skills -g
npx skills add https://github.com/Leonxlnx/taste-skill --skill design-taste-frontend -g
npx skills add https://github.com/anthropics/skills --skill mcp-builder -g

# 3) 관찰 기록을 한 곳으로 모은다
mkdir -p ~/.claude/skill-observations/observation-log/archive

# 4) 토큰 절약 도구 — 원래 프로세스 단위라 한 번 깔면 전 프로젝트에 적용된다
npm install -g omniroute
pip install "headroom-ai[all]"

# 5) 두 번째 묶음의 플러그인 둘 (자세한 설명은 4절)
claude plugin marketplace add vercel-labs/agent-browser
claude plugin install agent-browser@agent-browser --scope user
claude plugin marketplace add jnuyens/gsd-plugin
claude plugin install gsd@gsd-plugin --scope user
```

그리고 `~/.claude/CLAUDE.md` 에 아래를 넣으면 어느 프로젝트에서 세션을 열어도
스킬이 켜집니다. (프로젝트 `CLAUDE.md` 는 이걸 덮어쓰지 않고 덧붙여집니다.)

```markdown
## 세션 시작할 때

첫 도구 호출 전에 `task-observer` 스킬을 켠다. 관찰 기록은 프로젝트마다 흩어지지
않게 `~/.claude/skill-observations/` 한 곳에 쌓는다.
```

기록 경로를 홈으로 고정하는 건 그냥 취향이 아닙니다. 스킬을 홈에 깔아 놓고
기록만 프로젝트별로 두면, 같은 스킬에 대한 관찰이 프로젝트 수만큼 쪼개지고
어느 한 곳에서 돌아본 결과는 늘 "쌓인 게 별로 없네"로 보입니다.

확인:

```bash
claude plugin list                 # 네 개가 Scope: user 로 나와야 함
ls ~/.claude/skills/task-observer  # SKILL.md 가 보여야 함
npx skills list -g                 # find-skills·taste·mcp-builder 가 보여야 함
```

---

## 1. 플러그인 두 개 (claude-mem · claude-code-setup)

내 컴퓨터 전체에 깔기:

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-code-setup@claude-plugins-official --scope user
claude plugin install claude-mem@thedotmack --scope user
```

클로드 코드 안에서는 앞에 `/` 를 붙여 `/plugin install ...` 로도 됩니다.
확인은 `claude plugin list`.

### 이 저장소를 여는 사람에게는 이미 붙어 있습니다

`.claude/settings.json` 이 저장소에 들어 있어서, 이 저장소를 받아 클로드 코드를
열고 폴더를 신뢰하겠다고 한 번 답하면 플러그인 넷이 자동으로 붙습니다. 따로
설치할 필요가 없습니다.

- `claude-code-setup@claude-plugins-official`
- `claude-mem@thedotmack`
- `agent-browser@agent-browser`
- `gsd@gsd-plugin`

위의 `--scope user` 설치는 **다른 프로젝트에서도** 쓰고 싶을 때 하는 것입니다.
이 저장소만 쓸 거면 안 해도 됩니다.

플러그인을 빼거나 더하려면 `.claude/settings.json` 의 `enabledPlugins` 에서
줄을 지우거나 더하면 됩니다. 마켓플레이스가 새로 필요하면
`extraKnownMarketplaces` 에도 같이 넣으세요. `claude plugin install <이름> --scope project`
로 깔아도 이 파일이 알아서 갱신됩니다.

`gsd` 는 훅과 MCP 서버까지 같이 붙는 무거운 플러그인입니다. 이 저장소를 여는
사람 모두에게 그게 부담이면 `enabledPlugins` 에서 그 줄만 빼세요.

## 2. 스킬 넷 — 저장소에 들어 있습니다

`task-observer`, `find-skills`, `design-taste-frontend`(taste), `mcp-builder`
넷이 `.claude/skills/` 에 파일로 들어 있습니다. 저장소를 받으면 그대로 잡히니
따로 설치할 게 없습니다.

| 폴더 | 하는 일 | 원본 |
| --- | --- | --- |
| `task-observer` | 작업을 지켜보며 스킬로 만들 거리를 기록 | rebelytics/one-skill-to-rule-them-all |
| `find-skills` | "이런 거 되는 스킬 있나?" 하면 찾아서 깔아 줌 | vercel-labs/skills |
| `design-taste-frontend` | 뻔한 템플릿 같은 화면이 안 나오게 잡아 줌 | Leonxlnx/taste-skill |
| `mcp-builder` | MCP 서버를 제대로 설계·구현하게 안내 | anthropics/skills |

받아 온 버전은 `skills-lock.json` 에 해시로 박혀 있습니다. 원본 저장소의
로고 이미지(3MB)는 빼고 넣었습니다.

### 최신으로 올리기

```bash
npx skills add https://github.com/rebelytics/one-skill-to-rule-them-all --skill task-observer --agent claude-code --copy
```

`--skill` 과 주소만 바꿔서 넷 다 같은 방식으로 올립니다. 덮어쓰기가 되니 같은
명령을 다시 돌리면 됩니다. 올린 뒤에는 바뀐 파일을 커밋하세요.

### 다른 프로젝트에서도 쓰려면

`-g` 를 붙여 홈에 깔면 어느 프로젝트에서든 잡힙니다 (위 「0. 전부 전역으로」).

```bash
npx skills add https://github.com/rebelytics/one-skill-to-rule-them-all --skill task-observer -g
```

**주의**: `npx skills experimental_install` 로 `skills-lock.json` 을 복원하는
방법도 있는데, 실제로 돌려 보니 잠금 파일에 적힌 것 중 하나만 받고 엉뚱한
폴더(`.agents/`)에 넣었습니다. 이름 그대로 실험 기능이니 위의 `add` 를 쓰세요.

### 알아 둘 점

- **claude-mem** 은 Node.js 20 이상이 필요하고, 설치 뒤 클로드 코드를 한 번
  재시작해야 훅이 붙습니다. 기억에 남기고 싶지 않은 내용은 `<private>` 태그로
  감싸면 빠집니다. `npm i -g claude-mem` 만 하면 훅이 안 걸리니 플러그인으로 까세요.
- **claude-code-setup** 은 읽기 전용입니다. 파일을 고치지 않고 추천만 합니다.
- **task-observer** 는 첫 도구 호출 전에 켜져야 제 몫을 합니다. 그래서 루트
  `CLAUDE.md` 에 켜라는 문장을 넣어 뒀고, 모든 프로젝트에서 켜지게 하려면 같은
  문장을 `~/.claude/CLAUDE.md` 에도 넣으면 됩니다. 관찰 기록은
  `~/.claude/skill-observations/` 한 곳에 모으세요. 프로젝트 폴더에 쌓이는 경우를
  대비해 `skill-observations/` 는 `.gitignore` 에 넣어 두었습니다.

---

## 3. 한 번 깔아야 하는 것 (OmniRoute · Headroom)

### OmniRoute — 무료 API 게이트웨이

```bash
npm install -g omniroute
omniroute launch            # 게이트웨이를 띄우고 클로드 코드를 연결해 실행
```

- 대시보드: http://localhost:20128
- 모델별 프로필: `omniroute setup-claude` → `omniroute launch --profile <이름>`
  (프로필은 `~/.claude/profiles/<이름>/settings.json`, 토큰은 실행할 때만 주입되고
  파일로 저장되지 않습니다.)
- 직접 환경변수로 붙일 때 — `ANTHROPIC_BASE_URL` 에 `/v1` 을 붙이면 안 됩니다.

  ```bash
  export ANTHROPIC_BASE_URL=http://localhost:20128
  export ANTHROPIC_AUTH_TOKEN=<OmniRoute 토큰>
  ```

### Headroom — 컨텍스트 압축

```bash
uv tool install --python 3.13 "headroom-ai[all]"   # 또는: pip install "headroom-ai[all]"
headroom wrap claude
```

`wrap` 이 로컬 프록시를 띄우고 Serena(코드 탐색 MCP)를 함께 깔아 준 뒤
`~/.claude.json` 을 고쳐 클로드 코드를 프록시로 보냅니다. 압축은 전부 로컬에서
돌아가고 내용이 밖으로 나가지 않습니다. MCP 서버로만 쓰려면 `headroom mcp install`.

### 둘을 같이 쓸 때

OmniRoute 도 Headroom 도 `ANTHROPIC_BASE_URL` 을 자기 쪽으로 돌립니다. 둘 다
켜려면 Headroom 프록시가 OmniRoute 를 바라보게 순서를 잡아야 하고, 그냥 켜면
나중에 설정한 쪽이 이깁니다. 처음에는 하나씩 켜 보고 절약량을 확인하는 편이 낫습니다.

---

## 4. 두 번째 묶음 다섯 가지

나중에 추가한 것들입니다. 이쪽도 셋은 플러그인이 아니라 스킬이라, 스킬 설치
도구(`npx skills`)로 넣습니다.

| 이름 | 하는 일 | 성격 |
| --- | --- | --- |
| agent-browser | 에이전트가 진짜 브라우저를 몰아 화면 확인·폼 입력·스크린샷 | 플러그인 |
| find-skills | "이런 거 되는 스킬 있나?" 하면 찾아서 깔아 줌 | 스킬 |
| GSD | 계획 → 실행 → 검증으로 굴리는 작업 워크플로 | 플러그인 |
| taste | 뻔한 템플릿 같은 화면이 나오지 않게 잡아 주는 프런트 디자인 | 스킬 |
| mcp-builder | MCP 서버를 제대로 설계·구현하게 안내 | 스킬 |

### 플러그인 둘

이 저장소에서는 `.claude/settings.json` 에 이미 등록돼 있어 따로 깔 필요가
없습니다. 다른 프로젝트에서도 쓰려면:

```bash
claude plugin marketplace add vercel-labs/agent-browser
claude plugin install agent-browser@agent-browser --scope user

claude plugin marketplace add jnuyens/gsd-plugin
claude plugin install gsd@gsd-plugin --scope user
```

- `gsd-plugin` 마켓에는 `gsd` 와 `bm` 두 개가 있는데 같은 플러그인(Buildomator)에
  명령 접두사만 다릅니다. `/gsd:` 로 쓰려면 `gsd`, `/bm:` 로 쓰려면 `bm` 을 고르세요.
  둘 다 깔 필요는 없습니다.
- GSD 쪽 안내문에는 설치를 `--dangerously-skip-permissions` 로 하라는 말이 있는데,
  권한 확인을 통째로 끄는 옵션이라 권하지 않습니다. 확인 창이 몇 번 뜨더라도 그냥
  하나씩 승인하세요. 이 플러그인은 훅과 MCP 서버까지 같이 붙습니다.

### 스킬 셋

이 저장소에는 이미 들어 있습니다(2절). 다른 프로젝트에서도 쓰려면 홈에 깔면
됩니다.

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills -g
npx skills add https://github.com/Leonxlnx/taste-skill --skill design-taste-frontend -g
npx skills add https://github.com/anthropics/skills --skill mcp-builder -g
```

`npx skills` 는 스킬을 받아 `.claude/skills/` 에 넣어 주는 도구입니다. `-g` 를
붙이면 홈(모든 프로젝트), 안 붙이면 지금 프로젝트에만 들어갑니다. 확인은
`npx skills list -g`, 지우려면 `npx skills remove -g --skill <이름>`.

- **find-skills** 는 폴더 이름과 설치 이름이 같습니다.
- **taste** 는 폴더가 `taste-skill` 인데 설치 이름은 `design-taste-frontend` 입니다.
  `--skill` 에는 설치 이름을 넣어야 합니다. 같은 저장소에 `brutalist-skill`,
  `minimalist-skill`, `soft-skill`, `redesign-skill` 같은 결이 다른 것들도 있으니
  필요하면 골라 넣으세요. 랜딩 페이지·포트폴리오·리디자인용이고 대시보드나
  데이터 테이블용은 아닙니다.
- **mcp-builder** 는 Anthropic 공식 스킬입니다. MCP 서버를 자주 만들 게 아니라면
  비슷한 내용을 담은 공식 플러그인 `mcp-server-dev@claude-plugins-official` 로
  갈음해도 됩니다.

### 여기까지 확인한 것

- `agent-browser` 마켓플레이스는 실제로 등록해서 이름이 맞는지 확인했습니다.
- 나머지는 각 저장소의 `marketplace.json` 과 `SKILL.md` 를 직접 받아 이름을
  대조했습니다. 플러그인 설치 자체는 이 세션 권한으로 실행하지 못해, 설치까지
  돌려 본 것은 아닙니다.
- `npx skills` CLI 는 이 환경에서 동작을 확인했습니다.

---

## 원본 링크

- OmniRoute — https://github.com/diegosouzapw/OmniRoute
- claude-mem — https://github.com/thedotmack/claude-mem
- Headroom — https://github.com/headroomlabs-ai/headroom
- claude-code-setup — https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup
- task-observer — https://github.com/rebelytics/one-skill-to-rule-them-all
- agent-browser — https://github.com/vercel-labs/agent-browser
- find-skills — https://github.com/vercel-labs/skills (`skills/find-skills`)
- GSD / Buildomator — https://github.com/jnuyens/gsd-plugin
- taste — https://github.com/Leonxlnx/taste-skill
- mcp-builder — https://github.com/anthropics/skills (`skills/mcp-builder`)
