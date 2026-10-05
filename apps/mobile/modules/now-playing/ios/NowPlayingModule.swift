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

    // 보관함 플레이리스트 목록(직접 만든 것 + 보관함에 추가한 Apple Music 플레이리스트).
    // MPMediaQuery만 쓰므로 MusicKit 개발자 토큰·App ID 서비스가 필요 없다(무료 서명 가능, ADR-0002).
    // persistentID(UInt64)는 JS 숫자 정밀도를 넘을 수 있어 10진수 문자열로 넘긴다. 해석은 core ios-library.ts.
    AsyncFunction("listPlaylists") { () -> [[String: Any]] in
      if MPMediaLibrary.authorizationStatus() != .authorized { return [] }
      let lists = (MPMediaQuery.playlists().collections ?? []).prefix(1000)
      return lists.compactMap { c -> [String: Any]? in
        guard let pl = c as? MPMediaPlaylist else { return nil }
        let attrs = pl.playlistAttributes
        return [
          "persistentId": String(pl.persistentID),
          "name": pl.name ?? "",
          "count": pl.count,
          "smart": attrs.contains(.smart) || attrs.contains(.genius),
        ]
      }
    }

    // 플레이리스트의 곡 목록(재생 순서), 최대 5000곡
    AsyncFunction("playlistItems") { (playlistId: String) -> [[String: Any]] in
      if MPMediaLibrary.authorizationStatus() != .authorized { return [] }
      guard let pl = Self.findPlaylist(playlistId) else { return [] }
      return pl.items.prefix(5000).map { item in
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

    // 플레이리스트 전체를 Music 앱 재생 대기열로 넣고 재생한다(우리 앱에서 바로 듣기 — Music 앱을 열 필요 없음).
    // startItemId가 있으면 그 곡부터, shuffle이면 섞어서. 다음/이전 곡은 플레이리스트 순서를 따른다.
    AsyncFunction("playPlaylist") { (playlistId: String, startItemId: String?, shuffle: Bool, promise: Promise) in
      guard let pl = Self.findPlaylist(playlistId) else {
        promise.reject("E_NOT_FOUND", "플레이리스트를 찾지 못했습니다")
        return
      }
      let items = pl.items
      if items.isEmpty {
        promise.reject("E_EMPTY", "플레이리스트에 곡이 없습니다")
        return
      }
      let p = self.player
      let desc = MPMusicPlayerMediaItemQueueDescriptor(itemCollection: MPMediaItemCollection(items: items))
      if let sid = startItemId, let pid = UInt64(sid), let start = items.first(where: { $0.persistentID == pid }) {
        desc.startItem = start
      }
      p.shuffleMode = shuffle ? .songs : .off
      p.setQueue(with: desc)
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
    let r = Double(p.currentPlaybackRate)
    if r.isFinite { out["rate"] = r }
    // 재생 위치는 마지막에 읽는다: JS는 응답을 받은 시각을 측정 시각으로 쓰므로,
    // 읽은 순간과 응답 사이를 가능한 짧게 한다(가사 지연 최소화, docs/plan.md D-25).
    let t = p.currentPlaybackTime
    if t.isFinite { out["positionSec"] = t }
    return out
  }

  private static func findPlaylist(_ playlistId: String) -> MPMediaPlaylist? {
    guard let pid = UInt64(playlistId) else { return nil }
    let q = MPMediaQuery.playlists()
    q.addFilterPredicate(
      MPMediaPropertyPredicate(value: NSNumber(value: pid), forProperty: MPMediaPlaylistPropertyPersistentID)
    )
    return q.collections?.first as? MPMediaPlaylist
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
