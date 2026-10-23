import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AutoSyncPlanEntry, AutoSyncRunner, LibraryTrack, ServiceTrackRef } from '@lyrics-companion/core';
import { NowPlaying } from '../../modules/now-playing';
import { ITEM_TEXT, mmss, stopText, tooQuiet, useAutoSyncState } from './autoSyncText';
import { Button, Note } from './common';
import { Icon } from './icons';
import type { Theme } from './theme';

/**
 * 플레이리스트 소리로 싱크 맞추기(REQ-SY-07, docs/plan.md D-44).
 * 저장된 가사가 시간 정보 없는 가사이고 싱크 기록이 없는 곡만 골라 Music 앱 대기열에 넣고 처음부터 차례로 재생하며 듣는다.
 * 곡이 끝날 때마다 맞춰 저장한다. 판단은 core AutoSyncRunner, 이 화면은 대상 수·시작·멈춤·결과 표시만 한다.
 */
export function AutoSyncBatchPanel(props: {
  runner: AutoSyncRunner;
  theme: Theme;
  playlistKey: string;
  playlistName: string;
  tracks: readonly LibraryTrack[] | null;
  refs: readonly ServiceTrackRef[] | null;
  /** 시작하면 지금 재생 탭으로(가사가 맞춰지는 것을 볼 수 있게) */
  onStarted: () => void;
}) {
  const { runner, theme, tracks, refs } = props;
  const st = useAutoSyncState(runner);
  const [plan, setPlan] = useState<AutoSyncPlanEntry[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mine = st.mode === 'batch' && st.key === props.playlistKey;
  const otherRunning = st.running && !mine;

  // 대상 곡 고르기(저장소만 읽음). 실행이 끝나면 다시 센다.
  useEffect(() => {
    if (!refs) {
      setPlan(null);
      return;
    }
    let alive = true;
    runner.plan(refs).then(
      (p) => {
        if (alive) setPlan(p);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [refs, runner, st.running]);

  const targets = useMemo(() => (plan ? plan.filter((p) => p.status === 'target') : []), [plan]);
  const noLyrics = plan ? plan.filter((p) => p.status === 'no-lyrics').length : 0;
  const totalMs = useMemo(
    () => targets.reduce((sum, t) => sum + (refs?.[t.index]?.durationMs ?? 0), 0),
    [targets, refs],
  );

  const start = () => {
    if (!refs || !tracks || targets.length === 0) return;
    setConfirm(false);
    setMessage(null);
    const p = runner.startBatch({
      label: props.playlistName,
      key: props.playlistKey,
      tracks: refs,
      play: async (indexes) => {
        if (!NowPlaying) throw new Error('Music 앱을 제어할 수 없습니다');
        await NowPlaying.playItems(indexes.map((i) => tracks[i]?.persistentId ?? '').filter((x) => x !== ''));
      },
    });
    if (p) {
      props.onStarted();
      p.catch(() => setMessage('재생하지 못했습니다. Apple Music 구독 상태를 확인해 주세요.'));
    }
  };

  if (mine && st.running) {
    const done = st.items.filter((i) => !i.skipped).length;
    const saved = st.items.filter((i) => i.status === 'saved').length;
    return (
      <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
        <View style={styles.head}>
          <Icon name="mic" size={20} color={theme.accent} />
          <Text style={[styles.title, { color: theme.text }]}>
            소리로 싱크 맞추는 중 · {done}/{st.total}곡
          </Text>
        </View>
        {st.phase === 'preparing' ? <Note theme={theme}>준비 중(마이크·언어 모델)…</Note> : null}
        {st.current ? (
          <Text style={{ color: theme.textDim, fontSize: 14 }} numberOfLines={1}>
            듣는 중 · {st.current.title} · {mmss(st.current.positionMs)} · 알아들은 말 {st.current.heardWords}개
          </Text>
        ) : null}
        {tooQuiet(st.levelDb) ? (
          <Note theme={theme} tone="danger">
            소리가 거의 들리지 않습니다. iPhone 스피커로 재생 중인지 확인해 주세요.
          </Note>
        ) : null}
        <Note theme={theme}>맞춘 곡 {saved}곡. 앱을 켜 둔 채로(다른 탭은 괜찮음) 스피커로 재생해 주세요.</Note>
        <Button theme={theme} kind="danger" icon="close" label="멈추기" onPress={() => runner.cancel()} />
      </View>
    );
  }

  const finished = mine && st.stoppedBy !== null;
  const stopMsg = finished ? stopText(st.stoppedBy, st.notReady, st.error) : null;
  const failed = finished
    ? st.items.filter(
        (i) => !i.skipped && i.status !== 'saved' && i.status !== 'cancelled' && i.status !== 'not-played',
      )
    : [];
  const savedCount = finished ? st.items.filter((i) => i.status === 'saved').length : 0;

  return (
    <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <View style={styles.head}>
        <Icon name="mic" size={20} color={finished && savedCount > 0 ? theme.accent : theme.textDim} />
        <Text style={[styles.title, { color: theme.text }]}>
          {finished
            ? `소리로 싱크 맞추기 ${st.stoppedBy === 'completed' ? '완료' : '멈춤'}`
            : '싱크 없는 곡 소리로 맞추기'}
        </Text>
      </View>
      {finished ? (
        <Note theme={theme}>
          {savedCount}곡을 맞췄습니다{failed.length > 0 ? `, ${failed.length}곡은 저장하지 않았습니다` : ''}.
        </Note>
      ) : (
        <Note theme={theme}>
          시간 정보 없는 가사가 저장된 곡만 골라 처음부터 차례로 재생하며 iPhone 마이크로 듣고 줄 시간을 맞춥니다. 들은
          소리는 저장·전송하지 않습니다. 직접 기록한 싱크가 있는 곡은 건너뜁니다.
        </Note>
      )}
      {failed.slice(0, 6).map((i) => (
        <Text key={`${i.index}-${i.status}`} style={{ color: theme.textDim, fontSize: 13 }} numberOfLines={1}>
          • {i.title} — {ITEM_TEXT[i.status]}
        </Text>
      ))}
      {stopMsg ? (
        <Note theme={theme} tone="danger">
          {stopMsg}
        </Note>
      ) : null}
      {message ? (
        <Note theme={theme} tone="danger">
          {message}
        </Note>
      ) : null}
      {noLyrics > 0 ? (
        <Note theme={theme}>
          가사가 저장되지 않은 {noLyrics}곡은 먼저 위의 &quot;가사 원문 일괄 받기&quot;를 해 주세요.
        </Note>
      ) : null}
      {otherRunning ? <Note theme={theme}>다른 소리로 맞추기가 진행 중입니다. 끝나면 시작할 수 있습니다.</Note> : null}
      {confirm ? (
        <>
          <Note theme={theme}>
            {targets.length}곡(약 {Math.max(1, Math.round(totalMs / 60_000))}분)을 Music 앱 대기열에 넣고 처음부터
            재생합니다. 반복·셔플은 꺼집니다. 이어폰을 빼고 조용한 곳에서, 소리는 중간 이상으로 해 주세요.
          </Note>
          <View style={styles.row}>
            <Button theme={theme} label="취소" onPress={() => setConfirm(false)} style={styles.grow} />
            <Button theme={theme} kind="primary" icon="mic" label="시작" onPress={start} style={styles.grow} />
          </View>
        </>
      ) : (
        <Button
          theme={theme}
          kind={targets.length > 0 ? 'primary' : 'plain'}
          icon="mic"
          label={
            plan === null
              ? '싱크 없는 곡 확인 중…'
              : targets.length === 0
                ? '소리로 맞출 곡 없음'
                : `싱크 없는 곡 소리로 맞추기 (${targets.length}곡)`
          }
          onPress={() => setConfirm(true)}
          disabled={otherRunning || plan === null || targets.length === 0}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  title: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
});
