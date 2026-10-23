Pod::Spec.new do |s|
  s.name           = 'SongListener'
  s.version        = '0.1.0'
  s.summary        = '소리로 싱크 맞추기: 마이크 + 기기 안 음성 인식(SpeechAnalyzer)으로 들은 말과 시각 모으기'
  s.description    = 'Lyrics Companion 로컬 Expo 모듈. Speech·AVFoundation·MediaPlayer만 사용한다(개발자 토큰·App ID 서비스 불필요). iOS 26 미만에서는 사용할 수 없음을 알린다.'
  s.license        = 'UNLICENSED'
  s.author         = 'lyrics-companion'
  s.homepage       = 'https://example.invalid/lyrics-companion'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'MediaPlayer', 'Speech'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
