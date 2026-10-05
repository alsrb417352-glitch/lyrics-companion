import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  summarizeBatch,
  type BatchItemStatus,
  type BatchState,
  type BatchStopReason,
  type PlaylistLyricsBatch,
  type ServiceTrackRef,
} from '@lyrics-companion/core';
import { Button, Note } from './common';
import { Icon } from './icons';
import type { Theme } from './theme';

/** 일괄 받기 상태 구독(탭을 옮겼다 돌아와도 진행 상황이 이어서 보임) */
export function useBatchState(batch: PlaylistLyricsBatch): BatchState {
  const [state, setState] = useState(batch.current);
  useEffect(() => {
    setState(batch.current);
    return batch.subscribe(setState);
  }, [batch]);
  return state;
}

/** 곡 목록 옆에 붙일 짧은 상태 문구(저장된 곡은 화면이 저장소 기준으로 따로 표시) */
export const ITEM_BADGE: Partial<Record<BatchItemStatus, string>> = {
  'needs-song-confirmation': '확인 필요',
  'needs-lyrics-choice': '가사 선택 필요',
  'not-found': '가사 없음',
  'incompatible-version': '다른 버전만 있음',
  error: '오류',
};

function stopMessage(reason: BatchStopReason | null, retryAfterMs: number | null): string | null {
  switch (reason) {
    case 'cancelled':
      return '취소했습니다. 받은 곡은 저장되어 있고, 다시 받으면 남은 곡만 받습니다.';
    case 'offline':
      return '인터넷에 연결되어 있지 않아 멈췄습니다. 연결 후 다시 받으면 남은 곡만 받습니다.';
    case 'rate-limited': {
      const min = retryAfterMs == null ? null : Math.max(1, Math.ceil(retryAfterMs / 60_000));
      return `가사 서버(LRCLIB)가 잠시 요청을 막아 멈췄습니다${min ? `. 약 ${min}분 뒤` : '. 잠시 뒤'} 다시 받아 주세요.`;
    }
    case 'too-many-errors':
      return '가사 서버 오류가 계속되어 멈췄습니다. 잠시 뒤 다시 받아 주세요.';
    default:
      return null;
  }
}

/**
 * 플레이리스트 가사 원문 일괄 받기(REQ-LY-05, docs/plan.md D-31).
 * 판단(건너뛰기·곡 식별·요청 제한 처리)은 core PlaylistLyricsBatch가 하고, 이 화면은 시작·취소·표시만 한다.
 */
export function PlaylistLyricsBatchPanel(props: {
  batch: PlaylistLyricsBatch;
  theme: Theme;
  playlistKey: string;
  playlistName: string;
  /** 곡 목록(null이면 아직 읽는 중) */
  tracks: readonly ServiceTrackRef[] | null;
  /** 가사가 이미 저장된 곡 수(null이면 확인 중) */
  savedCount: number | null;
}) {
  const { batch, theme, tracks, savedCount } = props;
  const state = useBatchState(batch);
  const mine = state.key === props.playlistKey;
  const otherRunning = state.running && !mine;
  const total = tracks?.length ?? 0;
  const remaining = savedCount == null ? null : Math.max(0, total - savedCount);

  const start = () => {
    if (!tracks || tracks.length === 0) return;
    void batch.start({ label: props.playlistName, key: props.playlistKey, tracks });
  };

  if (mine && state.running) {
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    return (
      <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
        <View style={styles.head}>
          <Icon name="download" size={20} color={theme.accent} />
          <Text style={[styles.title, { color: theme.text }]}>가사 원문 받는 중 · {pct}%</Text>
        </View>
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: state.total, now: state.done }}
          style={[styles.track, { backgroundColor: theme.border }]}
        >
          <View style={[styles.fill, { width: `${pct}%`, backgroundColor: theme.accent }]} />
        </View>
        <Note theme={theme}>{summarizeBatch(state)}</Note>
        {state.current ? (
          <Text style={{ color: theme.textDim, fontSize: 14 }} numberOfLines={1}>
            {state.current.index + 1}번째 · {state.current.title}
          </Text>
        ) : null}
        {state.waitingMs ? (
          <Note theme={theme}>가사 서버 요청 제한으로 {Math.ceil(state.waitingMs / 1000)}초 기다리는 중…</Note>
        ) : null}
        <Note theme={theme}>받는 동안 앱을 켜 두세요(다른 탭으로 옮겨도 계속 받습니다).</Note>
        <Button theme={theme} kind="danger" icon="close" label="취소" onPress={() => batch.cancel()} />
      </View>
    );
  }

  const finished = mine && state.stoppedBy !== null;
  const stop = finished ? stopMessage(state.stoppedBy, state.retryAfterMs) : null;
  const needCheck = finished ? state.counts['needs-song-confirmation'] + state.counts['needs-lyrics-choice'] : 0;
  const allSaved = remaining === 0 && total > 0;

  return (
    <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      {finished ? (
        <>
          <View style={styles.head}>
            <Icon
              name={state.stoppedBy === 'completed' ? 'check' : 'download'}
              size={20}
              color={state.stoppedBy === 'completed' ? theme.accent : theme.textDim}
            />
            <Text style={[styles.title, { color: theme.text }]}>
              {state.stoppedBy === 'completed' ? '가사 원문 받기 완료' : '가사 원문 받기 멈춤'}
            </Text>
          </View>
          <Note theme={theme}>{summarizeBatch(state)}</Note>
          {stop ? (
            <Note theme={theme} tone="danger">
              {stop}
            </Note>
          ) : null}
          {needCheck > 0 ? (
            <Note theme={theme}>
              &quot;확인 필요&quot;·&quot;가사 선택 필요&quot; 곡은 같은 곡인지 확실하지 않아 자동으로 저장하지
              않았습니다. 그 곡을 재생하면 지금 재생 화면에서 고를 수 있습니다.
            </Note>
          ) : null}
        </>
      ) : (
        <Note theme={theme}>
          이 플레이리스트 곡들의 가사 원문을 한 번에 받아 저장합니다. 번역(AI)은 하지 않고, 이미 받은 곡은 건너뜁니다.
          받아 둔 곡은 재생하자마자 가사가 나옵니다.
        </Note>
      )}
      {otherRunning ? (
        <Note theme={theme}>
          다른 플레이리스트({state.label ?? ''})의 가사를 받는 중입니다. 끝나면 받을 수 있습니다.
        </Note>
      ) : null}
      <Button
        theme={theme}
        kind={allSaved ? 'plain' : 'primary'}
        icon={allSaved ? 'check' : 'download'}
        label={
          allSaved
            ? '모든 곡의 가사가 저장되어 있음'
            : remaining == null
              ? '가사 원문 일괄 받기'
              : finished
                ? `남은 ${remaining}곡 다시 받기`
                : `가사 원문 일괄 받기 (${remaining}곡)`
        }
        accessibilityLabel={
          remaining == null ? '가사 원문 일괄 받기' : `가사 원문 일괄 받기, 저장 안 된 곡 ${remaining}곡`
        }
        onPress={start}
        disabled={otherRunning || !tracks || total === 0 || allSaved}
      />
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
  title: { fontSize: 16, fontWeight: '700' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
});
