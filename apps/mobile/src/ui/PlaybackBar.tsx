import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PlaybackControl } from '@lyrics-companion/core';
import { IconButton } from './common';
import type { Theme } from './theme';

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 하단 재생 막대: 진행 막대(탭하면 그 위치로 이동) + 경과/남은 시간 + 아이콘 재생 컨트롤.
 * 위치를 모르면 진행을 꾸며내지 않고 막대를 비워 둔다(불변조건 5).
 */
export function PlaybackBar(props: {
  theme: Theme;
  control: PlaybackControl;
  isPlaying: boolean;
  durationMs: number | null;
  /** 현재 추정 위치(ms). 모르면 null */
  position: () => number | null;
  /** 탐색·재생 제어 직후 위치를 다시 읽는다 */
  resync: () => Promise<void>;
}) {
  const { theme, control, isPlaying, durationMs } = props;
  const [pos, setPos] = useState<number | null>(() => props.position());
  const [width, setWidth] = useState(0);

  // 0.5초마다 위치 표시만 갱신(가사 싱크 계산과는 별개)
  useEffect(() => {
    setPos(props.position());
    const t = setInterval(() => setPos(props.position()), 500);
    return () => clearInterval(t);
  }, [props.position, isPlaying]);

  const known = pos !== null && durationMs !== null && durationMs > 0;
  const ratio = known ? Math.min(1, Math.max(0, pos / durationMs)) : 0;

  const seekBy = (delta: number) => {
    const p = props.position();
    if (p == null) return;
    void control.seekTo(Math.max(0, p + delta)).then(props.resync);
  };

  return (
    <View>
      <Pressable
        accessibilityRole="adjustable"
        accessibilityLabel="재생 위치"
        accessibilityValue={known ? { text: `${clock(pos)} / ${clock(durationMs)}` } : { text: '알 수 없음' }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onPress={(e) => {
          if (!durationMs || width <= 0) return;
          const r = Math.min(1, Math.max(0, e.nativeEvent.locationX / width));
          void control.seekTo(r * durationMs).then(props.resync);
        }}
        hitSlop={{ top: 10, bottom: 10 }}
        style={styles.trackHit}
      >
        <View style={[styles.track, { backgroundColor: theme.border }]}>
          <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: theme.text }]} />
        </View>
        {known ? (
          <View
            style={[
              styles.knob,
              { left: Math.max(0, ratio * width - 6), backgroundColor: theme.text, borderColor: theme.bg },
            ]}
          />
        ) : null}
      </Pressable>
      <View style={styles.times}>
        <Text style={[styles.time, { color: theme.textDim }]}>{known ? clock(pos) : '--:--'}</Text>
        <Text style={[styles.time, { color: theme.textDim }]}>
          {known ? `-${clock(durationMs - pos)}` : durationMs ? clock(durationMs) : '--:--'}
        </Text>
      </View>
      <View style={styles.controls}>
        <IconButton
          theme={theme}
          icon="prev"
          label="이전 곡"
          size={48}
          iconSize={26}
          onPress={() => void control.skipPrevious()}
        />
        <IconButton
          theme={theme}
          icon="back10"
          label="10초 뒤로"
          size={48}
          iconSize={30}
          onPress={() => seekBy(-10_000)}
        />
        <IconButton
          theme={theme}
          kind="primary"
          icon={isPlaying ? 'pause' : 'play'}
          label={isPlaying ? '일시정지' : '재생'}
          size={68}
          iconSize={32}
          onPress={() => void (isPlaying ? control.pause() : control.play()).then(props.resync)}
        />
        <IconButton
          theme={theme}
          icon="fwd10"
          label="10초 앞으로"
          size={48}
          iconSize={30}
          onPress={() => seekBy(10_000)}
        />
        <IconButton
          theme={theme}
          icon="next"
          label="다음 곡"
          size={48}
          iconSize={26}
          onPress={() => void control.skipNext()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  trackHit: { height: 18, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  knob: { position: 'absolute', width: 12, height: 12, borderRadius: 6, top: 3, borderWidth: 2 },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    paddingHorizontal: 4,
  },
});
