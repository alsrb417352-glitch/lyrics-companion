package expo.modules.nowplaying

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * 재생 중인 앱의 미디어 세션을 읽기 위한 알림 리스너(자격 증명용).
 * Android는 일반 앱이 다른 앱의 MediaSession을 읽으려면 "알림 접근"이 허용된 리스너 컴포넌트를 요구한다.
 * 이 서비스는 그 자격으로만 쓰며, 알림 내용(제목·본문·발신자)은 읽지도 저장하지도 전송하지도 않는다(docs/security.md §3).
 */
class LyricsNotificationListener : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    // 의도적으로 비워 둔다: 알림 내용을 쓰지 않는다.
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    // 의도적으로 비워 둔다.
  }
}
