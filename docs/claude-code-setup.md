# 클로드 코드 확장 5종

릴스에서 소개된 다섯 가지를 이 저장소에 맞춰 정리했습니다. 성격이 둘로 나뉩니다.

| 이름 | 하는 일 | 성격 | 이 저장소에 들어온 것 |
| --- | --- | --- | --- |
| OmniRoute | 무료 API 게이트웨이로 요청을 돌려 토큰을 아낌 | 외부 CLI | 설치 방법만 (아래) |
| claude-mem | 세션이 끝나도 작업 기억을 이어 줌 | 플러그인 | 설치 명령·설정 내용 (아래) |
| Headroom | 안 쓰는 출력은 버리고 필요한 것만 압축해 보냄 | 외부 CLI 래퍼 | 설치 방법만 (아래) |
| claude-code-setup | 코드베이스를 보고 훅·스킬·에이전트·MCP 를 추천 | 플러그인 | 설치 명령·설정 내용 (아래) |
| task-observer | 작업을 지켜보며 스킬로 만들 거리를 기록 | 스킬 | 받아 오는 스크립트 (아래) |

다섯 가지 모두 클로드 코드 설정이나 컴퓨터를 건드리는 것이라, 저장소에는 설치
방법과 스크립트만 넣었습니다. 아래 명령을 한 번씩 실행하면 됩니다.

**이 저장소뿐 아니라 모든 프로젝트에 똑같이 적용하려면** 아래 「0. 전부 전역으로」
를 그대로 따라 하세요. 나머지 절은 각 도구를 하나씩 설명한 것입니다.

---

## 0. 전부 전역으로 — 모든 코드에서 똑같이 작동하게

컴퓨터에서 한 번만 실행하면 어느 폴더에서 클로드 코드를 켜도 같은 구성이 됩니다.

```bash
# 1) 플러그인 둘 — --scope user 가 핵심. 모든 프로젝트에 붙는다.
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add thedotmack/claude-mem
claude plugin install claude-code-setup@claude-plugins-official --scope user
claude plugin install claude-mem@thedotmack --scope user

# 2) task-observer 스킬 — 저장소가 아니라 홈에 둔다
git clone --depth 1 https://github.com/rebelytics/one-skill-to-rule-them-all /tmp/oster
mkdir -p ~/.claude/skills/task-observer
cp -r /tmp/oster/SKILL.md /tmp/oster/LICENSE.txt \
      /tmp/oster/references /tmp/oster/scripts ~/.claude/skills/task-observer/
rm -rf /tmp/oster

# 3) 관찰 기록을 한 곳으로 모은다
mkdir -p ~/.claude/skill-observations/observation-log/archive

# 4) 토큰 절약 도구 — 원래 프로세스 단위라 한 번 깔면 전 프로젝트에 적용된다
npm install -g omniroute
pip install "headroom-ai[all]"
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
claude plugin list                 # 둘 다 Scope: user 로 나와야 함
ls ~/.claude/skills/task-observer  # SKILL.md 가 보여야 함
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

### 이 저장소를 여는 사람 모두에게 붙이고 싶다면

`--scope user` 대신 `--scope project` 로 깔면 `.claude/settings.json` 이 아래
내용으로 생기고, 저장소를 받은 사람은 폴더를 신뢰하겠다고 한 번 답하는 것으로
같은 플러그인을 갖게 됩니다. 파일을 직접 만들어도 됩니다.

```json
{
  "extraKnownMarketplaces": {
    "claude-plugins-official": {
      "source": { "source": "github", "repo": "anthropics/claude-plugins-official" }
    },
    "thedotmack": {
      "source": { "source": "github", "repo": "thedotmack/claude-mem" }
    }
  },
  "enabledPlugins": {
    "claude-code-setup@claude-plugins-official": true,
    "claude-mem@thedotmack": true
  }
}
```

## 2. 스킬 하나 (task-observer)

마켓플레이스 플러그인이 아니라 스킬 파일이라 직접 받아야 합니다.

```bash
tools/update-task-observer.sh
```

`.claude/skills/task-observer/` 에 받아 놓고, 클로드 코드를 다시 열면 잡힙니다.
같은 명령으로 최신 상태로 올릴 수도 있습니다. 남의 저장소 코드라 여기에
커밋하지 않고 `.gitignore` 에 올려 두었으니, 이 저장소를 받은 사람은 각자 한 번
실행해야 합니다.

이 저장소 하나에만 쓸 때 이야기입니다. 여러 프로젝트에서 쓸 거면 처음부터
홈에 까는 쪽(위 「0. 전부 전역으로」)이 낫습니다. 이미 받아 놨다면 옮기면 됩니다.

```bash
cp -r .claude/skills/task-observer ~/.claude/skills/task-observer
```

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

## 원본 링크

- OmniRoute — https://github.com/diegosouzapw/OmniRoute
- claude-mem — https://github.com/thedotmack/claude-mem
- Headroom — https://github.com/headroomlabs-ai/headroom
- claude-code-setup — https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup
- task-observer — https://github.com/rebelytics/one-skill-to-rule-them-all
