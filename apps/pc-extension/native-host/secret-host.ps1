# 가사 보조 — Windows 보안 저장소 도우미(Chrome/Edge 네이티브 메시징 호스트)
#
# 확장 프로그램의 AI API 키를 Windows DPAPI(현재 사용자 범위)로 암호화해 사용자 프로필 폴더에 보관한다(불변조건 8, REQ-PC-02).
# - 브라우저가 메시지 하나마다 이 스크립트를 실행한다: 표준 입력으로 [4바이트 길이 + UTF-8 JSON] 하나를 받고 같은 형식으로 답한다.
# - 등록한 확장 프로그램만 부를 수 있다(호스트 매니페스트 allowed_origins). 브라우저가 넘긴 호출자 주소도 다시 확인한다.
# - 키 값을 화면·로그·파일 이름에 쓰지 않는다. 암호문만 디스크에 쓴다.
# 요청: {"op":"ping"} | {"op":"get","name":...} | {"op":"set","name":...,"value":...} | {"op":"delete","name":...}
# 응답: {"ok":true[,"value":...]} | {"ok":false,"error":"<코드>"}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$AllowedOrigin = 'chrome-extension://ggohabnpccimkbiclbehihpgiocjedhd/'
$MaxMessageBytes = 64KB
$Entropy = [Text.Encoding]::UTF8.GetBytes('lyrics-companion/secret-store/v1')

# 저장 폴더: 기본은 %LOCALAPPDATA%\LyricsCompanion\secrets. 자동 시험에서만 LC_SECRET_DIR로 바꾼다.
$Dir = if ($env:LC_SECRET_DIR) { $env:LC_SECRET_DIR } else { Join-Path $env:LOCALAPPDATA 'LyricsCompanion\secrets' }

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Exact([int]$count) {
  $buf = New-Object byte[] $count
  $read = 0
  while ($read -lt $count) {
    $n = $stdin.Read($buf, $read, $count - $read)
    if ($n -le 0) { return $null }
    $read += $n
  }
  return ,$buf
}

function Send-Reply($obj) {
  $json = $obj | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Slot-Path([string]$name) {
  # ApiKeyManager 슬롯 이름(예: ai-key.openai)만 허용 — 경로 조작 방지
  if ($name -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$' -or $name.Contains('..')) { return $null }
  return Join-Path $Dir ($name + '.bin')
}

try {
  # 브라우저는 호출한 확장 프로그램 주소를 첫 번째 인자로 넘긴다.
  $caller = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
  if ($caller -ne $AllowedOrigin) {
    Send-Reply @{ ok = $false; error = 'forbidden-origin' }
    exit 0
  }

  $lenBytes = Read-Exact 4
  if ($null -eq $lenBytes) { exit 0 }
  $len = [BitConverter]::ToInt32($lenBytes, 0)
  if ($len -le 0 -or $len -gt $MaxMessageBytes) {
    Send-Reply @{ ok = $false; error = 'bad-length' }
    exit 0
  }
  $body = Read-Exact $len
  if ($null -eq $body) { exit 0 }
  $req = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json

  switch ([string]$req.op) {
    'ping' {
      Send-Reply @{ ok = $true }
    }
    'get' {
      $path = Slot-Path ([string]$req.name)
      if ($null -eq $path) { Send-Reply @{ ok = $false; error = 'bad-name' }; break }
      if (-not (Test-Path -LiteralPath $path)) { Send-Reply @{ ok = $true; value = $null }; break }
      $cipher = [IO.File]::ReadAllBytes($path)
      $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      Send-Reply @{ ok = $true; value = [Text.Encoding]::UTF8.GetString($plain) }
    }
    'set' {
      $path = Slot-Path ([string]$req.name)
      $value = [string]$req.value
      if ($null -eq $path) { Send-Reply @{ ok = $false; error = 'bad-name' }; break }
      if ($value.Length -lt 1 -or $value.Length -gt 4096) { Send-Reply @{ ok = $false; error = 'bad-value' }; break }
      New-Item -ItemType Directory -Force -Path $Dir | Out-Null
      $cipher = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      # 임시 파일에 쓴 뒤 바꿔치기(중간 상태가 남지 않게)
      $tmp = "$path.tmp"
      [IO.File]::WriteAllBytes($tmp, $cipher)
      Move-Item -LiteralPath $tmp -Destination $path -Force
      Send-Reply @{ ok = $true }
    }
    'delete' {
      $path = Slot-Path ([string]$req.name)
      if ($null -eq $path) { Send-Reply @{ ok = $false; error = 'bad-name' }; break }
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
      Send-Reply @{ ok = $true }
    }
    default {
      Send-Reply @{ ok = $false; error = 'bad-op' }
    }
  }
} catch {
  # 예외 내용에는 경로·값이 섞일 수 있으므로 코드만 돌려준다.
  try { Send-Reply @{ ok = $false; error = 'internal' } } catch { }
}
