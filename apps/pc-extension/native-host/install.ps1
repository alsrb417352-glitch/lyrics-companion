# 가사 보조 — Windows 보안 저장소 도우미 설치(현재 사용자만, 관리자 권한 불필요)
#
# 하는 일:
#  1) secret-host.cmd / secret-host.ps1 을 %LOCALAPPDATA%\LyricsCompanion\native-host 로 복사(경로에 한글·공백이 없도록)
#  2) 같은 폴더에 호스트 매니페스트(com.lyrics_companion.secret_store.json) 작성 — 이 확장 프로그램 ID만 호출 허용
#  3) 현재 사용자 레지스트리(HKCU)에 Chrome·Edge용 네이티브 메시징 호스트 등록
# 키 자체는 여기서 다루지 않는다(확장 프로그램 설정 화면에서 입력 → 도우미가 DPAPI로 암호화해 저장).
# 되돌리기: uninstall.ps1
#
# 실행: PowerShell에서  powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'
$Name = 'com.lyrics_companion.secret_store'
$ExtensionOrigin = 'chrome-extension://ggohabnpccimkbiclbehihpgiocjedhd/'
$Dest = Join-Path $env:LOCALAPPDATA 'LyricsCompanion\native-host'

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($f in 'secret-host.ps1', 'secret-host.cmd') {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $Dest $f) -Force
}

$manifest = [ordered]@{
  name            = $Name
  description     = 'Lyrics Companion - Windows secret store helper (DPAPI)'
  path            = (Join-Path $Dest 'secret-host.cmd')
  type            = 'stdio'
  allowed_origins = @($ExtensionOrigin)
}
$manifestPath = Join-Path $Dest "$Name.json"
# 브라우저는 BOM 없는 UTF-8 JSON을 읽는다.
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

$registered = @()
foreach ($base in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts') {
  $key = Join-Path $base $Name
  New-Item -Path $key -Value $manifestPath -Force | Out-Null
  $registered += $key
}

Write-Host "설치 완료: $Dest"
Write-Host "등록한 레지스트리 키:"
$registered | ForEach-Object { Write-Host "  $_" }
Write-Host "브라우저를 완전히 닫았다가 다시 열면 확장 프로그램 설정 화면에 '설치됨'으로 보입니다."
