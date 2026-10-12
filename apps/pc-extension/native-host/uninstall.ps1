# 가사 보조 — Windows 보안 저장소 도우미 제거(install.ps1 되돌리기)
#
#  - Chrome·Edge 레지스트리 등록(HKCU)과 %LOCALAPPDATA%\LyricsCompanion\native-host 폴더를 지운다.
#  - 저장된 API 키(암호문)는 기본으로 남긴다. 함께 지우려면 -RemoveKeys 를 붙인다.
#
# 실행: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 [-RemoveKeys]
param([switch]$RemoveKeys)

$ErrorActionPreference = 'Stop'
$Name = 'com.lyrics_companion.secret_store'
$Root = Join-Path $env:LOCALAPPDATA 'LyricsCompanion'

foreach ($base in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts') {
  $key = Join-Path $base $Name
  if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Force; Write-Host "삭제: $key" }
}
$hostDir = Join-Path $Root 'native-host'
if (Test-Path -LiteralPath $hostDir) { Remove-Item -LiteralPath $hostDir -Recurse -Force; Write-Host "삭제: $hostDir" }
if ($RemoveKeys) {
  $secretDir = Join-Path $Root 'secrets'
  if (Test-Path -LiteralPath $secretDir) { Remove-Item -LiteralPath $secretDir -Recurse -Force; Write-Host "삭제(저장된 키): $secretDir" }
} else {
  Write-Host "저장된 키는 남겨 두었습니다(지우려면 -RemoveKeys)."
}
