# iPhone에 설치하기 (Windows PC + 무료 Apple ID)

Mac과 유료 개발자 계정 없이 이 앱을 iPhone에 설치하는 절차다. 결정 근거는 [ADR-0002](decisions/ADR-0002-ios-without-mac.md).

```
[Windows PC] ── 코드 올리기 ──▶ [GitHub] ── macOS 서버에서 빌드 ──▶ 무서명 .ipa
     ▲                                                              │
     └──────────── 내려받기 ◀───────────────────────────────────────┘
[Windows PC: Sideloadly] ── 무료 Apple ID로 서명 + USB 설치 ──▶ [iPhone]
```

> 처음 한 번은 30분~1시간 걸린다. 이후에는 "빌드 → 내려받기 → Sideloadly로 설치"만 반복한다.
> 무료 Apple ID로 서명한 앱은 **7일 뒤 열리지 않는다** → 7일 안에 Sideloadly로 다시 설치(§5).

## 0. 준비물
| 항목 | 비고 |
|---|---|
| GitHub 계정 | 무료. https://github.com |
| GitHub Desktop | git 명령을 몰라도 코드를 올릴 수 있는 공식 프로그램. https://desktop.github.com |
| Sideloadly (Windows) | https://sideloadly.io 공식 사이트에서만 내려받는다 |
| iTunes, iCloud (Windows) | **Microsoft Store 버전이 아닌** Apple 웹사이트 버전이 필요하다(Sideloadly 요구 사항). Store 버전이 깔려 있으면 먼저 지운다 |
| USB 케이블 | iPhone ↔ PC |
| 서명용 Apple ID | **음악 구독에 쓰는 계정과 다른 별도 Apple ID를 권장**(§6 보안). 무료로 만들 수 있다 |
| Apple Music 구독 | iPhone에 로그인된 계정. 앱 안에서 곡을 골라 재생하는 기능에 필요 |

## 1. GitHub에 코드 올리기 (처음 한 번)
1. PowerShell에서 빌드 설정 파일을 GitHub가 읽는 위치로 복사한다.
   ```powershell
   cd "E:\ai data\노래가사앱(로컬)"
   New-Item -ItemType Directory -Force .github\workflows | Out-Null
   Copy-Item ci\ios-unsigned-ipa.yml .github\workflows\ios-unsigned-ipa.yml
   Copy-Item ci\github-actions-ci.yml .github\workflows\ci.yml
   ```
2. GitHub Desktop → **File › Add local repository** → `E:\ai data\노래가사앱(로컬)` 선택 → "create a repository" 안내가 나오면 그대로 만든다.
3. 왼쪽 아래 Summary에 `첫 커밋` 입력 → **Commit to main** → 위쪽 **Publish repository**.
   - **공개(Public)** 저장소: macOS 빌드가 무료다. 저장소에는 비밀 값·실제 가사가 없다(`local-data/`, `node_modules/`는 올라가지 않음).
   - **비공개(Private)** 저장소: macOS 빌드는 무료 사용량을 빠르게 쓰고(분당 단가가 Linux의 약 10배), 초과 시 과금될 수 있다. 먼저 GitHub › Settings › Billing에서 Actions 사용량과 지출 한도를 확인한다.

## 2. 앱 빌드하기
1. GitHub 웹에서 저장소 → **Actions** 탭 → 왼쪽 `ios-unsigned-ipa` → **Run workflow** → Run.
   (이후에는 `main`에 앱 코드를 올릴 때마다 자동으로 빌드된다.)
2. 5~40분 기다린다(첫 빌드 실측 약 5분, macOS 러너 대기 시간에 따라 달라짐). `core-check`(검사) → `build-ios`(iOS 빌드) 순서로 진행된다.
3. 끝나면 실행 화면 아래 **Artifacts**의 `lyrics-companion-ios-unsigned`를 내려받아 압축을 푼다 → `LyricsCompanion-0.1.0-<번호>-unsigned.ipa`
4. 실패하면 `xcodebuild-log`를 내려받아 Claude에게 보여 준다(첫 빌드는 Swift 코드를 처음 컴파일하는 단계라 실패할 수 있다).

## 3. iPhone 준비 (처음 한 번)
1. USB로 PC에 연결 → iPhone에 "이 컴퓨터를 신뢰하겠습니까?" → **신뢰**.
2. iTunes를 한 번 열어 iPhone이 인식되는지 확인한다.

## 4. Sideloadly로 설치
1. Sideloadly 실행 → 내려받은 `.ipa`를 창에 끌어 놓는다.
2. **iDevice**에서 내 iPhone 선택, **Apple account**에 서명용 Apple ID 입력 → **Start**.
3. Apple ID 암호와 2단계 인증 코드를 입력한다. "Done"이 나오면 설치 완료.
4. iPhone에서:
   - **설정 › 일반 › VPN 및 기기 관리** → 서명용 Apple ID 항목 → **신뢰**.
   - **설정 › 개인정보 보호 및 보안 › 개발자 모드** 켜기 → 재시동 → 켜기 확인. (iOS 16 이상, 처음 한 번)
5. 홈 화면의 **가사 보조** 앱 실행 → "Apple Music 및 미디어 접근" **허용**.

## 5. 7일마다 다시 설치
- 무료 서명은 7일 동안만 유효하다. 기간이 지나면 앱이 열리지 않는다(저장된 가사·번역은 앱 안에 남아 있다).
- **같은 Apple ID, 같은 .ipa(또는 새 빌드)** 로 §4를 다시 하면 된다.
- Sideloadly의 자동 갱신 기능을 켜 두면, PC에서 Sideloadly가 실행 중이고 iPhone이 같은 Wi-Fi에 있을 때 자동으로 다시 서명한다.
- 무료 Apple ID 제한: 동시에 설치된 사이드로드 앱 최대 3개, 7일에 새 앱 ID 10개.
- 재설치 후에도 저장 데이터·API 키가 유지되는지는 아직 확인하지 않았다(MV-IOS-INSTALL-01에서 확인 예정). 앱을 지우거나 다시 깔기 전에 **설정 › 백업 › 백업 파일 만들기**로 "파일에 저장"해 두고, 재설치 후 **백업 가져오기**로 되살린다(API 키는 백업에 없으므로 다시 입력).

## 6. 보안 주의
- Sideloadly는 Apple 공식 도구가 아니며 Apple ID로 로그인해야 서명할 수 있다. **음악 구독·사진·결제에 쓰는 주 계정 대신 서명 전용 Apple ID**를 만들어 쓰는 것을 권장한다. 서명용 계정과 iPhone에 로그인된 계정은 달라도 된다.
- AI API 키는 앱의 설정 화면에서만 입력한다(Keychain 저장). 채팅·문서·GitHub에 붙여 넣지 않는다.
- GitHub 저장소에 `.env`, 키 파일, 실제 가사를 올리지 않는다(`npm run check`의 비밀정보 검사가 막는다).

## 7. 문제 해결
| 증상 | 확인할 것 |
|---|---|
| Sideloadly가 iPhone을 못 찾음 | 웹사이트 버전 iTunes 설치 여부, 케이블, "신뢰" 선택 |
| 설치 후 "신뢰하지 않는 개발자" | §4-4의 VPN 및 기기 관리에서 신뢰 |
| 앱이 바로 꺼짐 | 개발자 모드 켰는지, 7일이 지났는지 |
| "Music 앱에서 곡을 재생하세요"만 보임 | Music 앱에서 실제로 재생 중인지, 미디어 접근을 허용했는지(설정 › 개인정보 보호 및 보안 › 미디어 및 Apple Music) |
| Apple Music 검색 곡이 재생 안 됨 | 구독 상태, 한국 Apple Music 제공 여부. 검색 결과가 일본·미국 스토어 기준일 수 있다(MV-PB-IOS-03) |
| 가사가 안 나오거나 다른 곡 가사가 나옴 | 지금 재생 › "후보 보고 고르기" 또는 "가사 바꾸기"로 직접 고른다(고른 가사는 저장되어 다음부터 자동). Spotify·YouTube Music은 지원하지 않는다 |
