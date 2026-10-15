// Android 재생 앱(Spotify·YouTube Music·Apple Music)의 현재 곡·재생 상태를 읽고 제어하는 Expo 모듈(docs/plan.md D-41).
// - OS MediaSession만 쓴다(MediaSessionManager + 알림 리스너 자격). Spotify SDK·Web API는 쓰지 않는다(D-04 정책 위험).
// - 값은 가공하지 않고 넘긴다. 해석(앱→서비스, 곡 ID 형식, 재생 위치 계산, 따를 세션 고르기)은
//   packages/core/src/playback/android-media-session.ts 에서 테스트로 고정한다.
// - SUPPORTED 밖 앱의 미디어 정보는 읽지도 넘기지도 않는다. 알림 내용은 쓰지 않는다(docs/security.md §3).

package expo.modules.nowplaying

import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MediaSessionsModule : Module() {
  companion object {
    /** core ANDROID_PLAYER_APPS와 같아야 한다. */
    val SUPPORTED: Set<String> = linkedSetOf(
      "com.spotify.music",
      "com.google.android.apps.youtube.music",
      "com.apple.android.music",
    )
    private const val MAX_QUEUE = 1000
    private const val MAX_TEXT = 1000
    private const val MAX_QUERY = 300

    // androidx MediaControllerCompat.TransportControls.setShuffleMode가 보내는 사용자 지정 동작과 같은 값.
    // 프레임워크 MediaController에는 셔플 명령이 없어서, MediaSessionCompat(대부분의 음악 앱)이 알아듣는 이 동작으로 보낸다.
    private const val COMPAT_SET_SHUFFLE_MODE = "android.support.v4.media.session.action.SET_SHUFFLE_MODE"
    private const val COMPAT_ARG_SHUFFLE_MODE = "android.support.v4.media.session.action.ARGUMENT_SHUFFLE_MODE"
  }

  private val main = Handler(Looper.getMainLooper())
  private var wantObserving = false
  private var observing = false
  private val callbacks = HashMap<MediaSession.Token, Pair<MediaController, MediaController.Callback>>()

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val listenerComponent: ComponentName
    get() = ComponentName(context, LyricsNotificationListener::class.java)

  private val sessionManager: MediaSessionManager?
    get() = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager

  private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
    rebind(list)
    emit("sessions")
  }

  override fun definition() = ModuleDefinition {
    Name("AndroidMediaSessions")

    Events("onChange")

    // 알림 접근이 허용되어 있으면 getActiveSessions가 예외 없이 돈다(가장 확실한 확인 방법).
    AsyncFunction<String>("accessStatus") {
      when {
        sessionManager == null -> "unsupported"
        controllers() != null -> "granted"
        else -> "not-granted"
      }
    }

    // 설정 › 알림 접근(Android 11+는 이 앱의 상세 화면, 안 되면 목록 화면)
    AsyncFunction<Boolean>("openAccessSettings") {
      val detail = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
          .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listenerComponent.flattenToString())
      } else {
        null
      }
      (detail != null && startActivitySafely(detail)) ||
        startActivitySafely(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    // 앱 정보 화면(Android 13+ 사이드로드 앱의 "제한된 설정 허용" 메뉴가 여기 있다)
    AsyncFunction<Boolean>("openAppDetails") {
      startActivitySafely(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
      )
    }

    // 지원 앱의 활성 세션 전부(중요한 순서). 어느 것을 따를지는 core pickAndroidSession이 정한다.
    AsyncFunction<Map<String, Any?>>("sessions") {
      val list = controllers()
      mapOf(
        "granted" to (list != null),
        "sessions" to (list ?: emptyList()).map { snapshotOf(it) },
      )
    }

    // 재생 목록(대기열). 앱이 알려 주지 않으면 빈 목록.
    AsyncFunction("queue") { packageName: String ->
      val c = controllerFor(packageName)
      val items = (if (c != null) safe { c.queue } else null) ?: emptyList()
      mapOf<String, Any?>(
        "available" to (c != null),
        "title" to c?.queueTitle?.toString()?.take(MAX_TEXT),
        "activeQueueItemId" to c?.playbackState?.activeQueueItemId?.toString(),
        "items" to items.take(MAX_QUEUE).map { queueItemOf(it) },
      )
    }

    AsyncFunction("play") { packageName: String -> withControls(packageName) { it.play() } }

    AsyncFunction("pause") { packageName: String -> withControls(packageName) { it.pause() } }

    AsyncFunction("skipNext") { packageName: String -> withControls(packageName) { it.skipToNext() } }

    AsyncFunction("skipPrevious") { packageName: String -> withControls(packageName) { it.skipToPrevious() } }

    AsyncFunction("seekTo") { packageName: String, positionMs: Double ->
      if (!positionMs.isFinite() || positionMs < 0) {
        false
      } else {
        withControls(packageName) { it.seekTo(positionMs.toLong()) }
      }
    }

    AsyncFunction("skipToQueueItem") { packageName: String, queueId: String ->
      val id = queueId.toLongOrNull()
      if (id == null) false else withControls(packageName) { it.skipToQueueItem(id) }
    }

    AsyncFunction("setShuffle") { packageName: String, enabled: Boolean ->
      withControls(packageName) {
        val args = Bundle()
        args.putInt(COMPAT_ARG_SHUFFLE_MODE, if (enabled) 1 else 0)
        it.sendCustomAction(COMPAT_SET_SHUFFLE_MODE, args)
      }
    }

    // 곡 검색 재생: 앱 세션이 검색 재생을 받으면 그대로(앱 전환 없음), 아니면 표준 "검색해서 재생" 인텐트로 그 앱을 연다.
    AsyncFunction("playFromSearch") { packageName: String, query: String, title: String?, artist: String? ->
      if (packageName !in SUPPORTED || query.isBlank() || query.length > MAX_QUERY) {
        "unavailable"
      } else {
        val extras = Bundle()
        extras.putString(MediaStore.EXTRA_MEDIA_FOCUS, MediaStore.Audio.Media.ENTRY_CONTENT_TYPE)
        if (!title.isNullOrBlank()) extras.putString(MediaStore.EXTRA_MEDIA_TITLE, title.take(MAX_QUERY))
        if (!artist.isNullOrBlank()) extras.putString(MediaStore.EXTRA_MEDIA_ARTIST, artist.take(MAX_QUERY))
        val c = controllerFor(packageName)
        val actions = c?.playbackState?.actions ?: 0L
        if (c != null && (actions and PlaybackState.ACTION_PLAY_FROM_SEARCH) != 0L) {
          c.transportControls.playFromSearch(query, extras)
          "session"
        } else {
          val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            .setPackage(packageName)
            .putExtra(SearchManager.QUERY, query)
            .putExtras(extras)
          if (startActivitySafely(intent)) "launched" else "unavailable"
        }
      }
    }

    // 지원 앱 중 설치된 것(<queries>로 이 세 앱만 확인할 수 있다)
    AsyncFunction<List<String>>("installedPlayers") {
      val pm = context.packageManager
      SUPPORTED.filter { pkg -> pm.getLaunchIntentForPackage(pkg) != null }
    }

    AsyncFunction("openPlayer") { packageName: String ->
      if (packageName !in SUPPORTED) {
        false
      } else {
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
        intent != null && startActivitySafely(intent)
      }
    }

    OnStartObserving("onChange") {
      main.post {
        wantObserving = true
        startObserving()
      }
    }

    OnStopObserving("onChange") {
      main.post {
        wantObserving = false
        stopObserving()
      }
    }

    // 설정에서 알림 접근을 켜고 돌아오면 다시 등록한다
    OnActivityEntersForeground {
      main.post {
        if (wantObserving && !observing) startObserving()
      }
    }

    OnDestroy {
      main.post {
        wantObserving = false
        stopObserving()
      }
    }
  }

  // ---------------------------------------------------------------- 세션

  /** 지원 앱의 활성 세션(중요한 순서). 알림 접근이 없으면 null */
  private fun controllers(): List<MediaController>? {
    val m = sessionManager ?: return null
    return try {
      m.getActiveSessions(listenerComponent).filter { it.packageName in SUPPORTED }
    } catch (e: SecurityException) {
      null
    }
  }

  private fun controllerFor(packageName: String): MediaController? {
    if (packageName !in SUPPORTED) return null
    return controllers()?.firstOrNull { it.packageName == packageName }
  }

  private inline fun withControls(packageName: String, action: (MediaController.TransportControls) -> Unit): Boolean {
    val c = controllerFor(packageName) ?: return false
    action(c.transportControls)
    return true
  }

  private inline fun <T> safe(block: () -> T): T? =
    try {
      block()
    } catch (e: Exception) {
      null
    }

  private fun putText(out: MutableMap<String, Any?>, key: String, v: CharSequence?) {
    val s = v?.toString()
    if (!s.isNullOrBlank()) out[key] = s.take(MAX_TEXT)
  }

  private fun snapshotOf(c: MediaController): Map<String, Any?> {
    val out = HashMap<String, Any?>()
    out["packageName"] = c.packageName
    val md = safe { c.metadata }
    out["hasMetadata"] = md != null
    if (md != null) {
      putText(out, "title", md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE))
      putText(out, "artist", md.getString(MediaMetadata.METADATA_KEY_ARTIST))
      putText(out, "albumArtist", md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST))
      putText(out, "album", md.getString(MediaMetadata.METADATA_KEY_ALBUM))
      putText(out, "mediaId", md.getString(MediaMetadata.METADATA_KEY_MEDIA_ID))
      val duration = md.getLong(MediaMetadata.METADATA_KEY_DURATION)
      if (duration > 0) out["durationMs"] = duration.toDouble()
    }
    putText(out, "queueTitle", safe { c.queueTitle })
    val ps = safe { c.playbackState }
    if (ps != null) {
      out["state"] = ps.state
      out["positionMs"] = ps.position.toDouble()
      out["lastPositionUpdateTime"] = ps.lastPositionUpdateTime.toDouble()
      out["speed"] = ps.playbackSpeed.toDouble()
      out["actions"] = ps.actions.toDouble()
    }
    // 위치 계산 기준 시각은 마지막에 읽는다(JS는 응답 받은 시각을 측정 시각으로 쓰므로 그 사이를 짧게, D-25).
    out["readAtElapsedMs"] = SystemClock.elapsedRealtime().toDouble()
    return out
  }

  private fun queueItemOf(item: MediaSession.QueueItem): Map<String, Any?> {
    val out = HashMap<String, Any?>()
    // long 값은 JS 숫자 정밀도를 넘을 수 있어 10진 문자열로 넘긴다
    out["queueId"] = item.queueId.toString()
    val d = item.description
    putText(out, "title", d.title)
    putText(out, "subtitle", d.subtitle)
    putText(out, "mediaId", d.mediaId)
    // 다른 앱의 extras에는 이 앱에서 열 수 없는 값이 섞일 수 있어 실패하면 길이 없이 넘긴다
    val duration = safe { d.extras?.getLong(MediaMetadata.METADATA_KEY_DURATION, 0L) } ?: 0L
    if (duration > 0) out["durationMs"] = duration.toDouble()
    return out
  }

  // ---------------------------------------------------------------- 변경 알림

  private fun startObserving() {
    if (observing) return
    val m = safe { sessionManager } ?: return
    try {
      m.addOnActiveSessionsChangedListener(sessionsListener, listenerComponent, main)
      observing = true
      rebind(m.getActiveSessions(listenerComponent))
    } catch (e: SecurityException) {
      // 알림 접근이 아직 없음: 앱으로 돌아올 때(OnActivityEntersForeground) 다시 시도한다
      observing = false
    }
  }

  private fun stopObserving() {
    if (observing) safe { sessionManager?.removeOnActiveSessionsChangedListener(sessionsListener) }
    observing = false
    for ((_, pair) in callbacks) safe { pair.first.unregisterCallback(pair.second) }
    callbacks.clear()
  }

  /** 지원 앱 세션마다 변경 콜백을 하나씩 건다(사라진 세션은 해제) */
  private fun rebind(list: List<MediaController>?) {
    val wanted = (list ?: emptyList()).filter { it.packageName in SUPPORTED }
    val tokens = wanted.map { it.sessionToken }.toSet()
    val iter = callbacks.entries.iterator()
    while (iter.hasNext()) {
      val e = iter.next()
      if (e.key !in tokens) {
        safe { e.value.first.unregisterCallback(e.value.second) }
        iter.remove()
      }
    }
    for (c in wanted) {
      if (callbacks.containsKey(c.sessionToken)) continue
      val cb = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) {
          emit("metadata")
        }

        override fun onPlaybackStateChanged(state: PlaybackState?) {
          emit("state")
        }

        override fun onQueueChanged(queue: MutableList<MediaSession.QueueItem>?) {
          emit("queue")
        }

        override fun onSessionDestroyed() {
          emit("destroyed")
        }
      }
      c.registerCallback(cb, main)
      callbacks[c.sessionToken] = Pair(c, cb)
    }
  }

  /** 값은 보내지 않고 "바뀌었다"만 알린다(JS가 sessions()로 다시 읽고 core가 해석) */
  private fun emit(reason: String) {
    if (observing) sendEvent("onChange", mapOf("reason" to reason))
  }

  private fun startActivitySafely(intent: Intent): Boolean {
    val activity = appContext.currentActivity
    return try {
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      true
    } catch (e: ActivityNotFoundException) {
      false
    } catch (e: SecurityException) {
      false
    }
  }
}
