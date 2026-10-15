import { StyleSheet, Text, View } from 'react-native';
import type { AndroidMediaPlayback } from '../adapters/android-playback-source';
import { Button, Note } from './common';
import type { Theme } from './theme';
import type { PlaybackApi } from './usePlayback';

/**
 * Android 재생 앱 연동 권한 안내(docs/plan.md D-41).
 * 다른 앱의 미디어 세션을 읽으려면 "알림 접근" 허용이 필요하다. 허용 여부는 설정에서 돌아올 때 다시 확인한다(usePlayback).
 * Android 13 이상에서 직접 설치(사이드로드)한 앱은 먼저 앱 정보에서 "제한된 설정 허용"을 해야 켤 수 있다.
 */
export function AndroidAccessPanel(props: { android: AndroidMediaPlayback; playback: PlaybackApi; theme: Theme }) {
  const { android, playback: pb, theme } = props;
  return (
    <View style={[styles.center, { backgroundColor: theme.bg }]}>
      <Text style={[styles.h1, { color: theme.text }]}>재생 앱 연동</Text>
      {pb.access === 'loading' ? (
        <Note theme={theme}>확인 중…</Note>
      ) : pb.access === 'unsupported' ? (
        <Note theme={theme} tone="danger">
          이 기기에서는 재생 중인 곡 정보를 읽을 수 없습니다.
        </Note>
      ) : (
        <>
          <Note theme={theme}>
            Spotify·YouTube Music·Apple Music 앱에서 재생 중인 곡을 읽으려면 이 앱의 &quot;알림 접근&quot;을 허용해야
            합니다. 알림 내용은 읽거나 저장하지 않고, 재생 중인 곡의 제목·가수·길이·재생 위치만 가사를 찾고 맞추는 데
            씁니다(LRCLIB, Apple 곡 정보 조회).
          </Note>
          <Button
            theme={theme}
            kind="primary"
            label="알림 접근 설정 열기"
            onPress={() => void pb.requestAccess()}
            style={{ marginTop: 8 }}
          />
          <Note theme={theme}>
            설정에서 &quot;제한된 설정&quot; 안내가 나오면(Android 13 이상, 직접 설치한 앱): 아래 버튼으로 앱 정보를
            열고 오른쪽 위 ⋮ › &quot;제한된 설정 허용&quot;을 누른 뒤 다시 알림 접근을 켜 주세요.
          </Note>
          <Button theme={theme} label="앱 정보 열기" onPress={() => void android.openAppDetails()} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  h1: { fontSize: 24, fontWeight: '800', marginBottom: 8 },
});
