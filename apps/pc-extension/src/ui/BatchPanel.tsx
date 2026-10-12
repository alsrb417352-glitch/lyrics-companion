import {
  summarizeBatch,
  type BatchItemStatus,
  type BatchStopReason,
  type PlaylistLyricsBatch,
  type ServiceTrackRef,
} from '@lyrics-companion/core';
import { Button, Note, useBatchState } from './common';
import { Icon } from './icons';

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
 * 대기열 가사 원문 일괄 받기(REQ-LY-05, D-31과 같은 core PlaylistLyricsBatch).
 * 판단(건너뛰기·곡 식별·요청 제한 처리)은 core가 하고, 이 화면은 시작·취소·표시만 한다. AI를 부르지 않는다.
 */
export function BatchPanel(props: {
  batch: PlaylistLyricsBatch;
  listKey: string;
  listName: string;
  tracks: readonly ServiceTrackRef[] | null;
  savedCount: number | null;
}) {
  const { batch, tracks, savedCount } = props;
  const state = useBatchState(batch);
  const mine = state.key === props.listKey;
  const otherRunning = state.running && !mine;
  const total = tracks?.length ?? 0;
  const remaining = savedCount == null ? null : Math.max(0, total - savedCount);

  const start = () => {
    if (!tracks || tracks.length === 0) return;
    void batch.start({ label: props.listName, key: props.listKey, tracks });
  };

  if (mine && state.running) {
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    return (
      <section className="box">
        <div className="box-head">
          <Icon name="download" size={18} />
          <strong>가사 원문 받는 중 · {pct}%</strong>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.done}
        >
          <div style={{ width: `${pct}%` }} />
        </div>
        <Note>{summarizeBatch(state)}</Note>
        {state.current ? (
          <div className="dim ellipsis">
            {state.current.index + 1}번째 · {state.current.title}
          </div>
        ) : null}
        {state.waitingMs ? (
          <Note>가사 서버 요청 제한으로 {Math.ceil(state.waitingMs / 1000)}초 기다리는 중…</Note>
        ) : null}
        <Note>받는 동안 이 패널을 열어 두세요(다른 탭으로 옮겨도 계속 받습니다).</Note>
        <Button kind="danger" icon="close" label="취소" onClick={() => batch.cancel()} />
      </section>
    );
  }

  const finished = mine && state.stoppedBy !== null;
  const stop = finished ? stopMessage(state.stoppedBy, state.retryAfterMs) : null;
  const needCheck = finished ? state.counts['needs-song-confirmation'] + state.counts['needs-lyrics-choice'] : 0;
  const allSaved = remaining === 0 && total > 0;

  return (
    <section className="box">
      {finished ? (
        <>
          <div className="box-head">
            <Icon name={state.stoppedBy === 'completed' ? 'check' : 'download'} size={18} />
            <strong>{state.stoppedBy === 'completed' ? '가사 원문 받기 완료' : '가사 원문 받기 멈춤'}</strong>
          </div>
          <Note>{summarizeBatch(state)}</Note>
          {stop ? <Note tone="danger">{stop}</Note> : null}
          {needCheck > 0 ? (
            <Note>
              &quot;확인 필요&quot;·&quot;가사 선택 필요&quot; 곡은 같은 곡인지 확실하지 않아 자동으로 저장하지
              않았습니다. 그 곡을 재생하면 지금 재생 화면에서 고를 수 있습니다.
            </Note>
          ) : null}
        </>
      ) : (
        <Note>
          대기열 곡들의 가사 원문을 한 번에 받아 저장합니다. 번역(AI)은 하지 않고, 이미 받은 곡은 건너뜁니다. 받아 둔
          곡은 재생하자마자 가사가 나옵니다.
        </Note>
      )}
      {otherRunning ? (
        <Note>다른 목록({state.label ?? ''})의 가사를 받는 중입니다. 끝나면 받을 수 있습니다.</Note>
      ) : null}
      <Button
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
        onClick={start}
        disabled={otherRunning || !tracks || total === 0 || allSaved}
      />
    </section>
  );
}
