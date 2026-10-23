// 소리로 싱크 맞추기(docs/plan.md D-44)용 듣기 모듈 — iPhone 마이크 + 기기 안 음성 인식(Speech 프레임워크 SpeechAnalyzer).
//
// 하는 일
// - 사용자가 "소리로 싱크 맞추기"를 시작했을 때만 마이크를 켠다. 스피커로 나오는 Music 앱 소리를 듣고,
//   기기 안 음성 인식기(SpeechTranscriber, iOS 26 이상)가 알아들은 말과 그 말이 들린 오디오 시각을 모은다.
// - 같은 오디오 시계로 0.5초마다 Music 앱의 재생 상태(곡·위치)를 함께 잰다(표본). 시각 대응·가사 맞추기는 모두
//   packages/core(heard-audio.ts, auto-sync.ts)가 한다. 이 모듈은 값을 가공하지 않고 넘긴다.
// 하지 않는 일
// - 소리를 파일로 저장하거나 밖으로 보내지 않는다. 알아들은 말은 메모리에만 두고 JS가 가져가면 지운다.
// - 인식은 기기 안에서만 한다(SpeechTranscriber는 서버 인식이 없다). 언어 모델은 OS가 내려받는다(AssetInventory).
// - 개발자 토큰·App ID 서비스가 필요한 기능은 쓰지 않는다(무료 Apple ID 서명 가능, ADR-0002).
// 오디오 세션은 다른 앱 소리와 섞이게(mixWithOthers) 해서 Music 앱 재생을 멈추지 않는다.

import AVFoundation
import CoreMedia
import ExpoModulesCore
import MediaPlayer
import Speech

struct ListenError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

public final class SongListenerModule: Module {
  /// iOS 26 이상에서만 만드는 듣기 엔진(ListenEngine). 저장 속성에는 가용성 표시를 붙일 수 없어 Any로 둔다.
  private var engineBox: Any?

  public func definition() -> ModuleDefinition {
    Name("SongListener")

    // 준비 상태만 확인(권한을 묻거나 내려받지 않음)
    AsyncFunction("check") { (locale: String) async -> [String: Any] in
      return await Self.readiness(locale: locale, prompt: false)
    }

    // 사용자가 시작을 누른 뒤: 필요하면 마이크·음성 인식 권한을 묻고 언어 모델을 내려받는다
    AsyncFunction("prepare") { (locale: String) async -> [String: Any] in
      return await Self.readiness(locale: locale, prompt: true)
    }

    // 듣기 시작. 이미 듣는 중이면 언어·가사 힌트만 바꾼다(오디오 시각은 이어짐)
    AsyncFunction("start") { (locale: String, hints: [String]) async throws in
      if #available(iOS 26.0, *) {
        let engine = (self.engineBox as? ListenEngine) ?? ListenEngine()
        self.engineBox = engine
        try await engine.start(localeId: locale, hints: hints)
        return
      }
      throw ListenError(message: "iOS 26 이상에서만 쓸 수 있습니다")
    }

    // 지금까지 쌓인 결과를 넘기고 비운다
    AsyncFunction("drain") { () -> [String: Any] in
      if #available(iOS 26.0, *) {
        if let engine = self.engineBox as? ListenEngine { return engine.drain() }
      }
      return Self.emptyChunk()
    }

    // 듣기를 끝내고(인식 마무리까지 최대 12초) 남은 결과를 넘긴다
    AsyncFunction("stop") { () async -> [String: Any] in
      if #available(iOS 26.0, *) {
        if let engine = self.engineBox as? ListenEngine {
          self.engineBox = nil
          return await engine.stop()
        }
      }
      return Self.emptyChunk()
    }

    // 결과 없이 바로 끝낸다
    AsyncFunction("cancel") { () async in
      if #available(iOS 26.0, *) {
        if let engine = self.engineBox as? ListenEngine {
          self.engineBox = nil
          await engine.cancel()
        }
      }
    }

    OnDestroy {
      if #available(iOS 26.0, *) {
        if let engine = self.engineBox as? ListenEngine {
          self.engineBox = nil
          Task { await engine.cancel() }
        }
      }
    }
  }

  static func emptyChunk() -> [String: Any] {
    return ["segments": [Any](), "samples": [Any](), "audioMs": 0, "route": routeName()]
  }

  /// 지금 소리가 나가는 곳. 이어폰·블루투스면 마이크가 소리를 듣지 못한다.
  static func routeName() -> String {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    guard let first = outputs.first else { return "other" }
    switch first.portType {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "receiver"
    case .headphones: return "headphones"
    case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: return "bluetooth"
    case .airPlay: return "airplay"
    default: return "other"
    }
  }

  private static func readiness(locale: String, prompt: Bool) async -> [String: Any] {
    let route = routeName()
    if #available(iOS 26.0, *) {
      return await ListenEngine.readiness(localeId: locale, prompt: prompt, route: route)
    }
    return ["ok": false, "reason": "os-too-old", "route": route]
  }
}

/// 잠금으로 보호하는 완료 표시
final class DoneFlag {
  private let lock = NSLock()
  private var value = false
  func set() {
    lock.lock()
    value = true
    lock.unlock()
  }
  var isSet: Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// 언어 하나의 인식 흐름(분석기 + 입력 줄 + 형식 변환)
@available(iOS 26.0, *)
final class ListenPipeline {
  let locale: Locale
  let transcriber: SpeechTranscriber
  let analyzer: SpeechAnalyzer
  let format: AVAudioFormat
  let converter: AVAudioConverter
  let input: AsyncStream<AnalyzerInput>.Continuation
  /// 이 흐름에 넣은 첫 버퍼의 오디오 시각(ms). 엔진 잠금 안에서만 읽고 쓴다. 아직 없으면 -1
  var baseMs: Double = -1
  var resultsTask: Task<Void, Never>?

  init(
    locale: Locale,
    transcriber: SpeechTranscriber,
    analyzer: SpeechAnalyzer,
    format: AVAudioFormat,
    converter: AVAudioConverter,
    input: AsyncStream<AnalyzerInput>.Continuation
  ) {
    self.locale = locale
    self.transcriber = transcriber
    self.analyzer = analyzer
    self.format = format
    self.converter = converter
    self.input = input
  }

  static func context(_ hints: [String]) -> AnalysisContext {
    let ctx = AnalysisContext()
    if !hints.isEmpty {
      ctx.contextualStrings[.general] = Array(hints.prefix(100))
    }
    return ctx
  }

  /// 마이크 버퍼를 분석기 형식으로 바꾼다(오디오 스레드에서 호출)
  func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var fed = false
    var err: NSError?
    let status = converter.convert(to: out, error: &err) { _, outStatus in
      if fed {
        outStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      outStatus.pointee = .haveData
      return buffer
    }
    if status == .error || err != nil { return nil }
    return out.frameLength > 0 ? out : nil
  }
}

@available(iOS 26.0, *)
final class ListenEngine {
  private let audio = AVAudioEngine()
  private let lock = NSLock()
  // ---- 잠금으로 보호
  private var segments: [[String: Any]] = []
  private var samples: [[String: Any]] = []
  private var errorText: String?
  private var levelDb: Double?
  private var inputRate: Double = 48_000
  private var framesTotal: Int64 = 0
  private var lastBufferStartFrames: Int64 = -1
  private var lastBufferHost: UInt64 = 0
  private var current: ListenPipeline?
  private var retiring: [ListenPipeline] = []
  private var stopping = false
  // ---- 시작·정지(JS 호출 순서대로)
  private var capturing = false
  private var inputFormat: AVAudioFormat?
  private var timer: DispatchSourceTimer?
  private var interruptionObserver: NSObjectProtocol?

  private static let maxItems = 20_000

  /// 잠금 안에서 실행(비동기 함수 안에서 NSLock을 직접 쓰지 않으려고 동기 함수로 감쌈)
  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  // ------------------------------------------------------------ 준비 상태

  static func readiness(localeId: String, prompt: Bool, route: String) async -> [String: Any] {
    func no(_ reason: String) -> [String: Any] { return ["ok": false, "reason": reason, "route": route] }
    if !SpeechTranscriber.isAvailable { return no("unsupported") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
      return no("locale-unsupported")
    }
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      break
    case .denied:
      return no("mic-denied")
    case .undetermined:
      if !prompt { return no("mic-undetermined") }
      let granted = await AVAudioApplication.requestRecordPermission()
      if !granted { return no("mic-denied") }
    @unknown default:
      return no("mic-denied")
    }
    if route == "headphones" || route == "bluetooth" { return no("headphones") }
    // 음성 인식 권한: 기기 안 인식에 필요한 경우를 대비해 한 번 묻는다(거부돼도 인식이 되면 그대로 쓴다)
    if prompt && SFSpeechRecognizer.authorizationStatus() == .notDetermined {
      await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
        SFSpeechRecognizer.requestAuthorization { _ in cont.resume() }
      }
    }
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange]
    )
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        if !prompt { return no("model-missing") }
        try await request.downloadAndInstall()
      }
    } catch {
      return no("model-download-failed")
    }
    return ["ok": true, "route": route]
  }

  // ------------------------------------------------------------ 시작

  func start(localeId: String, hints: [String]) async throws {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
      throw ListenError(message: "이 언어는 기기 음성 인식이 지원하지 않습니다")
    }
    let cur = locked { current }
    if let cur, cur.locale.identifier == locale.identifier {
      // 같은 언어: 다음 곡 가사 힌트만 바꾼다
      try? await cur.analyzer.setContext(ListenPipeline.context(hints))
      return
    }
    if !capturing { try configureSession() }
    let fmt = try micFormat()
    let pipeline = try await makePipeline(locale: locale, hints: hints, inputFormat: fmt)
    let old: ListenPipeline? = locked {
      let o = current
      current = pipeline
      return o
    }
    if let old { retire(old) }
    if !capturing { try startCapture(format: fmt) }
  }

  private func configureSession() throws {
    let session = AVAudioSession.sharedInstance()
    // 다른 앱(Music) 소리와 섞어 재생을 멈추지 않고, 소리 처리(에코 제거 등) 없이 그대로 듣는다
    try session.setCategory(
      .playAndRecord,
      mode: .measurement,
      options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP]
    )
    try session.setActive(true)
  }

  private func micFormat() throws -> AVAudioFormat {
    if let f = inputFormat { return f }
    let f = audio.inputNode.outputFormat(forBus: 0)
    if f.sampleRate <= 0 || f.channelCount == 0 {
      throw ListenError(message: "마이크를 쓸 수 없습니다")
    }
    inputFormat = f
    locked { inputRate = f.sampleRate }
    return f
  }

  private func makePipeline(locale: Locale, hints: [String], inputFormat: AVAudioFormat) async throws -> ListenPipeline {
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange]
    )
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw ListenError(message: "음성 인식 형식을 정하지 못했습니다(언어 모델 확인 필요)")
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: format) else {
      throw ListenError(message: "소리 형식을 바꾸지 못했습니다")
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let p = ListenPipeline(
      locale: locale,
      transcriber: transcriber,
      analyzer: analyzer,
      format: format,
      converter: converter,
      input: continuation
    )
    try? await analyzer.setContext(ListenPipeline.context(hints))
    p.resultsTask = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          self?.collect(result.text, from: p)
        }
      } catch {
        self?.fail(error)
      }
    }
    try await analyzer.start(inputSequence: stream)
    return p
  }

  private func startCapture(format: AVAudioFormat) throws {
    let input = audio.inputNode
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, when in
      self?.onBuffer(buffer, when)
    }
    audio.prepare()
    try audio.start()
    capturing = true
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.setError("전화·다른 앱 소리 때문에 듣기가 중단되었습니다")
    }
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 0.5, repeating: 0.5)
    t.setEventHandler { [weak self] in self?.takeSample() }
    t.resume()
    timer = t
  }

  // ------------------------------------------------------------ 오디오 스레드

  private func onBuffer(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
    let n = Int64(buffer.frameLength)
    let host = when.isHostTimeValid ? when.hostTime : mach_absolute_time()
    lock.lock()
    let start = framesTotal
    framesTotal += n
    lastBufferStartFrames = start
    lastBufferHost = host
    let p = current
    if let p, p.baseMs < 0 { p.baseMs = Double(start) / inputRate * 1000 }
    lock.unlock()
    updateLevel(buffer)
    guard let p, let converted = p.convert(buffer) else { return }
    p.input.yield(AnalyzerInput(buffer: converted))
  }

  private func updateLevel(_ buffer: AVAudioPCMBuffer) {
    guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    let ch = data[0]
    let n = Int(buffer.frameLength)
    var sum: Float = 0
    for i in 0..<n { sum += ch[i] * ch[i] }
    let rms = sqrt(sum / Float(n))
    let db = rms > 0 ? Double(20 * log10(rms)) : -160
    lock.lock()
    levelDb = max(-160, min(0, db))
    lock.unlock()
  }

  // ------------------------------------------------------------ 결과·표본

  private func collect(_ text: AttributedString, from p: ListenPipeline) {
    lock.lock()
    let base = p.baseMs
    lock.unlock()
    if base < 0 { return }
    var out: [[String: Any]] = []
    for run in text.runs {
      guard let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else { continue }
      let s = String(text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if s.isEmpty { continue }
      let start = range.start.seconds
      let duration = range.duration.seconds
      if !start.isFinite || !duration.isFinite { continue }
      out.append([
        "text": String(s.prefix(300)),
        "startMs": base + start * 1000,
        "endMs": base + (start + max(0, duration)) * 1000,
      ])
    }
    if out.isEmpty { return }
    lock.lock()
    segments.append(contentsOf: out)
    if segments.count > Self.maxItems { segments.removeFirst(segments.count - Self.maxItems) }
    lock.unlock()
  }

  private func fail(_ error: Error) {
    lock.lock()
    let quiet = stopping
    lock.unlock()
    if quiet || error is CancellationError { return }
    setError("음성 인식 오류: \(String(error.localizedDescription.prefix(120)))")
  }

  private func setError(_ message: String) {
    lock.lock()
    if errorText == nil { errorText = message }
    lock.unlock()
  }

  /// 메인 스레드(타이머): Music 앱 재생 상태와 그 순간의 오디오 시각
  private func takeSample() {
    let now = Self.nowPlaying()
    let host = mach_absolute_time()
    lock.lock()
    defer { lock.unlock() }
    if lastBufferStartFrames < 0 { return }
    let base = Double(lastBufferStartFrames) / inputRate * 1000
    let dt = AVAudioTime.seconds(forHostTime: host) - AVAudioTime.seconds(forHostTime: lastBufferHost)
    samples.append(["audioMs": base + max(0, dt) * 1000, "now": now])
    if samples.count > Self.maxItems { samples.removeFirst(samples.count - Self.maxItems) }
  }

  /// NowPlayingModule.snapshot()과 같은 원시 값(해석은 core ios-system-player.ts)
  private static func nowPlaying() -> [String: Any] {
    let p = MPMusicPlayerController.systemMusicPlayer
    var out: [String: Any] = ["state": stateString(p.playbackState), "hasItem": false]
    guard let item = p.nowPlayingItem else { return out }
    out["hasItem"] = true
    out["title"] = item.title ?? ""
    out["artist"] = item.artist ?? ""
    if let album = item.albumTitle { out["album"] = album }
    out["durationSec"] = item.playbackDuration
    out["storeId"] = item.playbackStoreID
    let r = Double(p.currentPlaybackRate)
    if r.isFinite { out["rate"] = r }
    let t = p.currentPlaybackTime
    if t.isFinite { out["positionSec"] = t }
    return out
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

  func drain() -> [String: Any] {
    lock.lock()
    let segs = segments
    segments = []
    let smp = samples
    samples = []
    let audioMs = Double(framesTotal) / inputRate * 1000
    let err = errorText
    let level = levelDb
    lock.unlock()
    var out: [String: Any] = [
      "segments": segs,
      "samples": smp,
      "audioMs": audioMs,
      "route": SongListenerModule.routeName(),
    ]
    if let err { out["error"] = err }
    if let level { out["levelDb"] = level }
    return out
  }

  // ------------------------------------------------------------ 정지

  private func retire(_ p: ListenPipeline) {
    p.input.finish()
    locked { retiring.append(p) }
    Task { [weak self] in
      try? await p.analyzer.finalizeAndFinishThroughEndOfInput()
      await p.resultsTask?.value
      self?.forget(p)
    }
  }

  private func forget(_ p: ListenPipeline) {
    locked { retiring.removeAll { $0 === p } }
  }

  private func stopCapture() {
    timer?.cancel()
    timer = nil
    if let o = interruptionObserver {
      NotificationCenter.default.removeObserver(o)
      interruptionObserver = nil
    }
    if capturing {
      audio.inputNode.removeTap(onBus: 0)
      audio.stop()
      capturing = false
    }
  }

  private func takePipelines() -> [ListenPipeline] {
    return locked {
      stopping = true
      var all = retiring
      retiring = []
      if let p = current { all.append(p) }
      current = nil
      return all
    }
  }

  private func clearResults() {
    locked {
      segments = []
      samples = []
    }
  }

  private func deactivateSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  func stop() async -> [String: Any] {
    stopCapture()
    let all = takePipelines()
    for p in all { p.input.finish() }
    let done = DoneFlag()
    Task {
      for p in all {
        try? await p.analyzer.finalizeAndFinishThroughEndOfInput()
        await p.resultsTask?.value
      }
      done.set()
    }
    for _ in 0..<120 {
      if done.isSet { break }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    if !done.isSet {
      for p in all {
        try? await p.analyzer.cancelAndFinishNow()
        p.resultsTask?.cancel()
      }
    }
    deactivateSession()
    return drain()
  }

  func cancel() async {
    stopCapture()
    let all = takePipelines()
    for p in all {
      p.input.finish()
      try? await p.analyzer.cancelAndFinishNow()
      p.resultsTask?.cancel()
    }
    clearResults()
    deactivateSession()
  }
}
