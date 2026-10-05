import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { estimatePositionMs, timingTargets, type LyricsVersion } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note } from './common';
import type { Theme } from './theme';
import type { PlaybackApi } from './usePlayback';

function clock(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** 되돌리기 후 다시 들을 수 있게 지운 기록보다 이만큼 앞으로 이동 */
const REWIND_MS = 3_000;

/**
 * 수동 싱크 기록(REQ-SY-05, docs/plan.md D-28): 자동 싱크가 안 될 때(시간 정보 없는 가사·시간이 틀린 가사)
 * 노래를 들으며 줄이 불리기 시작할 때마다 큰 버튼을 눌러 시간을 기록한다.
 * - 버튼을 누르는 순간(손가락이 닿을 때, onPressIn)의 Music 앱 재생 위치를 그대로 기록한다. AI·추정으로 시간을 만들지 않는다.
 * - 빈 줄(연 구분)은 건너뛴다. 끝까지 기록하지 않고 저장하면 기록하지 않은 줄은 강조하지 않는다.
 * - 저장하면 가사·번역·발음은 그대로 두고 시간만 새 버전으로 추가된다(원래 시간으로 되돌리기 가능).
 */
export function SyncRecordScreen(props: {
  services: AppServices;
  playback: PlaybackApi;
  theme: Theme;
  lyrics: LyricsVersion;
  onDone: () => void;
}) {
  const { services, playback: pb, theme, lyrics } = props;
  const control = services.playback?.control;
  const targets = useMemo(() => timingTargets(lyrics), [lyrics]);
  const [taps, setTaps] = useState<number[]>([]);
  const tapsRef = useRef<number[]>([]);
  tapsRef.current = taps;
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const list = useRef<FlatList<(typeof targets)[number]>>(null);

  const done = taps.length >= targets.length;
  const next = targets[taps.length] ?? null;
  const isPlaying = pb.snapshot?.status === 'playing';

  useEffect(() => {
    if (targets.length === 0) return;
    const index = Math.min(taps.length, targets.length - 1);
    list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false });
  }, [taps.length, targets.length]);

  /** 지금 재생 위치(ms). 재생 중이 아니거나 모르면 null */
  const nowPos = (): number | null => {
    const snap = pb.latest();
    if (!snap || snap.status !== 'playing') return null;
    const est = estimatePositionMs(snap, services.clock.monotonicMs());
    return 'positionMs' in est ? est.positionMs : null;
  };

  const tap = () => {
    if (tapsRef.current.length >= targets.length) return;
    const pos = nowPos();
    if (pos === null) {
      setMsg({ text: '재생 중일 때만 기록됩니다. 아래에서 재생을 눌러 주세요.', danger: true });
      return;
    }
    const last = tapsRef.current[tapsRef.current.length - 1];
    if (last !== undefined && pos < last) {
      setMsg({
        text: '재생 위치가 앞 줄 기록보다 이릅니다. "되돌리기"로 앞 기록을 지운 뒤 다시 눌러 주세요.',
        danger: true,
      });
      return;
    }
    const nextTaps = [...tapsRef.current, Math.round(pos)];
    tapsRef.current = nextTaps;
    setTaps(nextTaps);
    setMsg(null);
  };

  const undo = () => {
    const removed = taps[taps.length - 1];
    if (removed === undefined) return;
    setTaps(taps.slice(0, -1));
    setMsg(null);
    if (control) void control.seekTo(Math.max(0, removed - REWIND_MS)).then(pb.resync);
  };

  const restart = async () => {
    setTaps([]);
    setMsg(null);
    if (!control) return;
    await control.seekTo(0);
    await control.play();
    await pb.resync();
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await services.session.saveUserTiming(taps);
      if (r.ok) props.onDone();
      else setMsg({ text: r.error ?? '저장하지 못했습니다', danger: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { borderColor: theme.border }]}>
        <Text style={[styles.h1, { color: theme.text }]}>싱크 직접 기록</Text>
        <Note theme={theme}>
          노래를 들으며 각 줄이 불리기 시작하는 순간 아래 큰 버튼을 누르세요. 빈 줄은 건너뜁니다. 저장하면 이 곡에서는
          기록한 시간으로 가사가 넘어가고, 번역·발음은 그대로입니다. 전체적으로 조금 늦으면 설정의 &quot;전체 싱크
          보정&quot;으로 맞출 수 있습니다.
        </Note>
        <Text style={{ color: theme.textDim, fontSize: 14, marginTop: 2 }}>
          {taps.length} / {targets.length}줄 기록
        </Text>
      </View>

      <FlatList
        ref={list}
        data={targets}
        keyExtractor={(l) => l.id}
        style={styles.flex}
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 8 }}
        onScrollToIndexFailed={(info) =>
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
        }
        renderItem={({ item, index }) => {
          const t = taps[index];
          const isNext = index === taps.length;
          return (
            <View style={[styles.line, isNext ? { backgroundColor: theme.surface, borderColor: theme.accent } : null]}>
              <Text
                style={{
                  color: t !== undefined ? theme.textDim : isNext ? theme.text : theme.textFaint,
                  fontSize: isNext ? 20 : 17,
                  fontWeight: isNext ? '800' : '600',
                  flex: 1,
                }}
              >
                {item.text}
              </Text>
              <Text style={{ color: theme.textFaint, fontSize: 14, marginLeft: 8, minWidth: 52, textAlign: 'right' }}>
                {t !== undefined ? clock(t) : ''}
              </Text>
            </View>
          );
        }}
      />

      <View style={[styles.footer, { borderColor: theme.border }]}>
        {msg ? (
          <Note theme={theme} tone={msg.danger ? 'danger' : 'dim'}>
            {msg.text}
          </Note>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={done ? '모든 줄을 기록했습니다' : `다음 줄 시작 기록: ${next?.text ?? ''}`}
          accessibilityState={{ disabled: done }}
          disabled={done}
          // 손을 뗄 때(onPress)보다 닿는 순간이 실제 반응에 가깝다
          onPressIn={tap}
          style={({ pressed }) => [
            styles.big,
            { backgroundColor: done ? theme.surface : theme.accent, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Text style={{ color: done ? theme.textDim : theme.accentText, fontSize: 22, fontWeight: '800' }}>
            {done ? '모든 줄 기록 완료' : isPlaying ? '다음 줄 시작 ⏎' : '재생 후 누르세요'}
          </Text>
          {next ? (
            <Text style={{ color: theme.accentText, fontSize: 15, marginTop: 4, opacity: 0.9 }} numberOfLines={1}>
              {next.text}
            </Text>
          ) : null}
        </Pressable>
        <View style={styles.row}>
          <Button theme={theme} label="되돌리기" onPress={undo} disabled={taps.length === 0} style={styles.grow} />
          <Button
            theme={theme}
            label="처음부터"
            onPress={() => void restart()}
            disabled={!control}
            style={styles.grow}
          />
          {control ? (
            <Button
              theme={theme}
              label={isPlaying ? '일시정지' : '재생'}
              onPress={() => void (isPlaying ? control.pause() : control.play()).then(pb.resync)}
              style={styles.grow}
            />
          ) : null}
        </View>
        <View style={styles.row}>
          <Button theme={theme} label="취소" onPress={props.onDone} style={styles.grow} />
          <Button
            theme={theme}
            kind="primary"
            label={saving ? '저장 중…' : done ? '저장' : `여기까지 저장 (${taps.length}/${targets.length})`}
            onPress={() => void save()}
            disabled={saving || taps.length === 0}
            style={[styles.grow, { flex: 2 }]}
          />
        </View>
        {!done && taps.length > 0 ? (
          <Note theme={theme}>끝까지 기록하지 않고 저장하면 기록하지 않은 줄은 강조되지 않습니다.</Note>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  h1: { fontSize: 22, fontWeight: '800', marginBottom: 2 },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  footer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth },
  big: { minHeight: 92, borderRadius: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
});
