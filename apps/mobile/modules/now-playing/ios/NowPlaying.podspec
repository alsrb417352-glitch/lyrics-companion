Pod::Spec.new do |s|
  s.name           = 'NowPlaying'
  s.version        = '0.1.0'
  s.summary        = 'Music 앱(systemMusicPlayer) 현재 곡·재생 위치 읽기와 재생 제어'
  s.description    = 'Lyrics Companion 로컬 Expo 모듈. MediaPlayer 프레임워크만 사용한다(MusicKit 개발자 토큰 불필요).'
  s.license        = 'UNLICENSED'
  s.author         = 'lyrics-companion'
  s.homepage       = 'https://example.invalid/lyrics-companion'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'MediaPlayer'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
