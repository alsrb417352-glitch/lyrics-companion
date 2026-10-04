// Music 앱(시스템 음악 플레이어)의 현재 곡·재생 상태를 읽고 제어하는 Expo 모듈.
// - MediaPlayer 프레임워크만 사용한다. MusicKit 카탈로그 API·개발자 토큰은 쓰지 않는다
//   (무료 Apple ID 서명으로도 빌드·설치할 수 있게 하기 위함, docs/decisions/ADR-0002).
// - 값은 가공하지 않고 넘긴다. 해석(초→ms, "0" 스토어 ID 처리, 상태 매핑)은
//   packages/core/src/playback/ios-system-player.ts 에서 테스트로 고정한다.
// - systemMusicPlayer는 메인 스레드에서만 사용한다(Apple 문서).
// - 다른 앱(Spotify·YouTube Music)의 재생 정보는 읽지 않는다(공개 API 없음, 비공개 API 사용 금지).

import ExpoModulesCore
import MediaPlayer

public final class NowPlayingModule: Module {
  private var observers: [NSObjectProtocol] = []
  private var observing = false

  private var player: MPMusicPlayerController {
    MPMusicPlayerController.systemMusicPlayer
  }

  public func definition() -> ModuleDefinition {
    Name("NowPlaying")

    Events("onChange")

    AsyncFunction("authorizationStatus") { () -> String in
      return Self.authString(MPMediaLibrary.authorizationStatus())
    }

    AsyncFunction("requestAuthorization") { (promise: Promise) in
      MPMediaLibrary.requestAuthorization { status in
        promise.resolve(Self.authString(status))
      }
    }

    AsyncFunction("current") { () -> [String: Any] in
      return self.snapshot()
    }.runOnQueue(.main)

    AsyncFunction("play") {
      self.player.play()
    }.runOnQueue(.main)

    AsyncFunction("pause") {
      self.player.pause()
    }.runOnQueue(.main)

    AsyncFunction("skipNext") {
      self.player.skipToNextItem()
    }.runOnQueue(.main)

    AsyncFunction("skipPrevious") {
      self.player.skipToPreviousItem()
    }.runOnQueue(.main)

    AsyncFunction("seekTo") { (seconds: Double) in
      guard seconds.isFinite else { return }
      self.player.currentPlaybackTime = max(0, seconds)
    }.runOnQueue(.main)

    // Apple Music 카탈로그 곡 재생(스토어 ID). Apple Music 구독이 필요하다.
    AsyncFunction("playStoreId") { (storeId: String, promise: Promise) in
      guard storeId.range(of: "^[0-9]{1,20}$", options: .regularExpression) != nil else {
        promise.reject("E_BAD_ID", "잘못된 스토어 ID")
        return
      }
      let p = self.player
      p.setQueue(with: [storeId])
      p.prepareToPlay { error in
        DispatchQueue.main.async {
          if let error = error {
            promise.reject("E_PREPARE", error.localizedDescription)
            return
          }
          p.play()
          promise.resolve(true)
        }
      }
    }.runOnQueue(.main)

    // 보관함(라이브러리) 곡 검색: 제목에 검색어가 포함된 곡, 최대 50개
    AsyncFunction("searchLibrary") { (term: String) -> [[String: Any]] in
      let trimmed = term.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty || trimmed.count > 200 { return [] }
      if MPMediaLibrary.authorizationStatus() != .authorized { return [] }
      let q = MPMediaQuery.songs()
      q.addFilterPredicate(
        MPMediaPropertyPredicate(value: trimmed, forProperty: MPMediaItemPropertyTitle, comparisonType: .contains)
      )
      let items = (q.items ?? []).prefix(50)
      return items.map { item in
        var row: [String: Any] = [
          "persistentId": String(item.persistentID),
          "title": item.title ?? "",
          "artist": item.artist ?? "",
          "durationSec": item.playbackDuration,
          "storeId": item.playbackStoreID,
        ]
        if let album = item.albumTitle { row["album"] = album }
        return row
      }
    }

    AsyncFunction("playLibraryItem") { (persistentId: String, promise: Promise) in
      guard let pid = UInt64(persistentId) else {
        promise.reject("E_BAD_ID", "잘못된 항목 ID")
        return
      }
      let q = MPMediaQuery.songs()
      q.addFilterPredicate(
        MPMediaPropertyPredicate(value: NSNumber(value: pid), forProperty: MPMediaItemPropertyPersistentID)
      )
      guard let items = q.items, !items.isEmpty else {
        promise.reject("E_NOT_FOUND", "보관함에서 곡을 찾지 못했습니다")
        return
      }
      let p = self.player
      p.setQueue(with: MPMediaItemCollection(items: items))
      p.play()
      promise.resolve(true)
    }.runOnQueue(.main)

    OnStartObserving("onChange") {
      DispatchQueue.main.async { self.startObserving() }
    }

    OnStopObserving("onChange") {
      DispatchQueue.main.async { self.stopObserving() }
    }

    OnDestroy {
      DispatchQueue.main.async { self.stopObserving() }
    }
  }

  private func startObserving() {
    if observing { return }
    observing = true
    let p = player
    p.beginGeneratingPlaybackNotifications()
    let center = NotificationCenter.default
    let names: [Notification.Name] = [
      .MPMusicPlayerControllerNowPlayingItemDidChange,
      .MPMusicPlayerControllerPlaybackStateDidChange,
    ]
    for name in names {
      let token = center.addObserver(forName: name, object: p, queue: .main) { [weak self] _ in
        guard let self = self else { return }
        self.sendEvent("onChange", self.snapshot().mapValues { Optional($0) })
      }
      observers.append(token)
    }
  }

  private func stopObserving() {
    if !observing { return }
    observing = false
    for token in observers {
      NotificationCenter.default.removeObserver(token)
    }
    observers.removeAll()
    player.endGeneratingPlaybackNotifications()
  }

  private func snapshot() -> [String: Any] {
    let p = player
    var out: [String: Any] = [
      "state": Self.stateString(p.playbackState),
      "hasItem": false,
    ]
    guard let item = p.nowPlayingItem else { return out }
    out["hasItem"] = true
    out["title"] = item.title ?? ""
    out["artist"] = item.artist ?? ""
    if let album = item.albumTitle { out["album"] = album }
    out["durationSec"] = item.playbackDuration
    out["storeId"] = item.playbackStoreID
    let t = p.currentPlaybackTime
    if t.isFinite { out["positionSec"] = t }
    let r = Double(p.currentPlaybackRate)
    if r.isFinite { out["rate"] = r }
    return out
  }

  private static func authString(_ s: MPMediaLibraryAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  private static func stateString(_ s: MPMusicPlaybackState) -> String {
    switch s {
    case .playing: return "playing"
    case .paused: return "paused"
    case .stopped: return "stopped"
    case .interrupted: return "interrupted"
    case .seekingForward: return "seekingForward"
    case .seekingBackward: return "seekingBackward"
    @unknown default: return "unknown"
    }
  }
}
