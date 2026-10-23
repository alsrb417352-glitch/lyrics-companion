// 백그라운드 유지(docs/plan.md D-45): 소리 없는 오디오를 다른 앱 소리와 섞어 재생해,
// Music 앱이 재생하는 동안 우리 앱이 백그라운드에서도 멈추지 않게 한다(Info.plist UIBackgroundModes = audio).
// - 언제 켜고 끌지는 core playback/background.ts(KeepAlivePolicy)가 정하고 JS가 setKeepAlive로 알려 준다.
// - 다른 앱 소리와 섞으므로(mixWithOthers) Music 재생을 멈추거나 잠금 화면 재생 정보를 가져오지 않는다.
// - 끌 때 오디오 세션을 비활성화하지 않는다(소리로 싱크 맞추기 모듈이 같은 세션을 쓸 수 있으므로). 엔진만 멈춘다.
// - 전화 등으로 끊기면, 끝났을 때 다시 켠다(원할 때만). 다른 모듈이 마이크용 세션(playAndRecord)을 쓰는 중이면 세션 종류는 그대로 둔다.

import AVFoundation

final class SilentKeepAlive {
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var wanted = false
  private var observers: [NSObjectProtocol] = []

  var isRunning: Bool {
    return engine?.isRunning == true && player?.isPlaying == true
  }

  /// 켜기·끄기. 결과: "on" | "off" | "failed"
  func set(_ on: Bool) -> String {
    wanted = on
    if on {
      return start() ? "on" : "failed"
    }
    stop()
    return "off"
  }

  func status() -> String {
    if isRunning { return "on" }
    return wanted ? "failed" : "off"
  }

  private func start() -> Bool {
    if isRunning { return true }
    teardown()
    let session = AVAudioSession.sharedInstance()
    do {
      // 소리로 싱크 맞추기(song-listener)가 듣는 중이면 세션 종류를 바꾸지 않는다(재생도 되는 종류라 그대로 무음을 낼 수 있음).
      // 바꾸면 마이크 입력이 끊긴다. 보통은 JS가 듣는 동안 유지를 끄지만, 끄기 전 설정 변경 알림으로 다시 켜지는 경우를 막는다.
      if session.category != .playAndRecord {
        try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      }
      try session.setActive(true)
    } catch {
      return false
    }
    guard let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100)
    else { return false }
    buffer.frameLength = 44_100
    if let data = buffer.floatChannelData {
      let ch = data[0]
      for i in 0..<Int(buffer.frameLength) { ch[i] = 0 }  // 1초짜리 무음
    }
    let e = AVAudioEngine()
    let p = AVAudioPlayerNode()
    e.attach(p)
    e.connect(p, to: e.mainMixerNode, format: format)
    do {
      e.prepare()
      try e.start()
    } catch {
      return false
    }
    p.scheduleBuffer(buffer, at: nil, options: .loops, completionHandler: nil)
    p.play()
    engine = e
    player = p
    observe(e)
    return true
  }

  private func observe(_ e: AVAudioEngine) {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) {
        [weak self] note in
        guard let self = self else { return }
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        if raw == AVAudioSession.InterruptionType.ended.rawValue, self.wanted {
          self.teardown()
          _ = self.start()
        }
      })
    observers.append(
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { [weak self] _ in
        guard let self = self, self.wanted else { return }
        self.teardown()
        _ = self.start()
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) {
        [weak self] _ in
        guard let self = self, self.wanted else { return }
        self.teardown()
        _ = self.start()
      })
  }

  private func teardown() {
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers.removeAll()
    player?.stop()
    engine?.stop()
    player = nil
    engine = nil
  }

  private func stop() {
    teardown()
  }
}
