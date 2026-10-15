# ci — CI 설정 보관

`github-actions-ci.yml`은 GitHub Actions 설정이다. 원격 도구로는 `.github/` 폴더에 쓸 수 없어 이곳에 두었다.
GitHub 저장소를 만들 때 다음 위치로 옮기면 동작한다.

```powershell
cd "E:\ai data\노래가사앱(로컬)"
New-Item -ItemType Directory -Force .github\workflows | Out-Null
Copy-Item ci\github-actions-ci.yml .github\workflows\ci.yml
```

내용: Ubuntu·Windows × Node 22·24에서 `npm run check`, Windows의 "공백+한글+괄호" 경로 사본에서 `npm run check`, 뮤테이션 스모크. 비밀 값이 필요 없고 실제 서비스·AI를 호출하지 않는다.

## ios-unsigned-ipa.yml — iPhone 앱 빌드 (2026-10-04 추가)
```powershell
Copy-Item ci\ios-unsigned-ipa.yml .github\workflows\ios-unsigned-ipa.yml
```
`macos-26` 러너에서 core 검사 → `expo prebuild` → Xcode Release 빌드(서명 없음) → `.ipa` 아티팩트(14일 보관). 비밀 값 없음. 설치는 [`docs/ios-install.md`](../docs/ios-install.md).
비공개 저장소에서는 macOS 러너가 무료 사용량을 빠르게 소모하거나 과금될 수 있다(공개 저장소는 무료).

## android-apk.yml — Android 앱 빌드 (2026-10-14 추가, D-41·D-42)
```powershell
Copy-Item ci\android-apk.yml .github\workflows\android-apk.yml
```
`ubuntu-latest` 러너에서 core 검사 → `expo prebuild --platform android` → Gradle Release 빌드 → `.apk` 아티팩트(14일 보관). APK 검사 단계에서 알림 리스너 서비스·JS 번들 포함 여부와 막아야 할 권한(다른 앱 위에 그리기)이 빠졌는지 확인한다. 비밀 값 없음. Expo 템플릿의 디버그 키로 서명하므로 빌드마다 서명이 같아 덮어 설치할 수 있다(개인 사이드로드 전용). 설치는 [`docs/android-install.md`](../docs/android-install.md).
