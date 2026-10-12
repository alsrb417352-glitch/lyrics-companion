import { useEffect, useMemo, useRef, useState } from 'react';
import { estimatePositionMs, timingTargets, type LyricsVersion } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note, type Msg } from './common';
import type { PlaybackApi } from './usePlayback';

function clockText(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** 되돌리기 후 다시 들을 수 있게 지운 기록보다 이만큼 앞으로 이동 */
const REWIND_MS = 3_000;

/**
 * 수동 싱크 기록(REQ-SY-05, D-28) — iPhone 앱 SyncRecordScreen과 같은 규칙.
 * PC에서는 큰 버튼 외에 **스페이스바·Enter**로도 기록한다(키를 누르는 순간 = keydown, 반복 입력은 무시).
 * - 누르는 순간의 웹 플레이어 재생 위치를 그대로 기록한다. AI·추정으로 시간을 만들지 않는다.
 * - 빈 줄은 건너뛴다. 끝까지 기록하지 않고 저장하면 기록하지 않은 줄은 강조하지 않는다.
 * - 저장하면 가사·번역·발음은 그대로 두고 시간만 새 버전으로 추가된다.
 */
export function SyncRecord(props: {
  services: AppServices;
  playback: PlaybackApi;
  lyrics: LyricsVersion;
  onDone: () => void;
}) {
  const { services, playback: pb, lyrics } = props;
  const control = services.playback.control;
  const targets = useMemo(() => timingTargets(lyrics), [lyrics]);
  const [taps, setTaps] = useState<number[]>([]);
  const tapsRef = useRef<number[]>([]);
  tapsRef.current = taps;
  const [msg, setMsg] = useState<Msg>(null);
  const [saving, setSaving] = useState(false);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const done = taps.length >= targets.length;
  const next = targets[taps.length] ?? null;
  const isPlaying = pb.snapshot?.status === 'playing';

  useEffect(() => {
    rowRefs.current[Math.min(taps.length, targets.length - 1)]?.scrollIntoView({ block: 'center' });
  }, [taps.length, targets.length]);

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
  const tapRef = useRef(tap);
  tapRef.current = tap;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      // 버튼에 포커스가 있을 때 스페이스가 그 버튼을 누르지 않게 막고 기록만 한다
      e.preventDefault();
      tapRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const undo = () => {
    const removed = taps[taps.length - 1];
    if (removed === undefined) return;
    setTaps(taps.slice(0, -1));
    setMsg(null);
    void control
      .seekTo(Math.max(0, removed - REWIND_MS))
      .then(pb.resync)
      .catch(() => undefined);
  };

  const restart = async () => {
    setTaps([]);
    setMsg(null);
    try {
      await control.seekTo(0);
      await control.play();
      await pb.resync();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : '재생하지 못했습니다', danger: true });
    }
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
    <div className="screen">
      <div className="screen-head">
        <h2>싱크 직접 기록</h2>
        <Note>
          노래를 들으며 각 줄이 불리기 시작하는 순간 <kbd>스페이스</kbd> 또는 아래 큰 버튼을 누르세요. 빈 줄은
          건너뜁니다. 저장하면 이 곡에서는 기록한 시간으로 가사가 넘어가고, 번역·발음은 그대로입니다. 전체적으로 조금
          늦으면 설정의 &quot;전체 싱크 보정&quot;으로 맞출 수 있습니다.
        </Note>
        <div className="dim">
          {taps.length} / {targets.length}줄 기록
        </div>
      </div>
      <div className="screen-body">
        {targets.map((item, index) => {
          const t = taps[index];
          const isNext = index === taps.length;
          return (
            <div
              key={item.id}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              className={`rec-line${isNext ? ' rec-next' : ''}${t !== undefined ? ' rec-done' : ''}`}
            >
              <span className="grow">{item.text}</span>
              <span className="rec-time">{t !== undefined ? clockText(t) : ''}</span>
            </div>
          );
        })}
      </div>
      <div className="screen-foot stack">
        {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
        <button
          type="button"
          className="big-tap"
          disabled={done}
          aria-label={done ? '모든 줄을 기록했습니다' : `다음 줄 시작 기록: ${next?.text ?? ''}`}
          // 버튼을 뗄 때(click)보다 누르는 순간이 실제 반응에 가깝다
          onPointerDown={(e) => {
            if (e.button === 0) tap();
          }}
          onKeyDown={(e) => e.preventDefault()}
        >
          <strong>{done ? '모든 줄 기록 완료' : isPlaying ? '다음 줄 시작 (스페이스)' : '재생 후 누르세요'}</strong>
          {next ? <span>{next.text}</span> : null}
        </button>
        <div className="row">
          <Button label="되돌리기" className="grow" onClick={undo} disabled={taps.length === 0} />
          <Button label="처음부터" className="grow" onClick={() => void restart()} />
          <Button
            label={isPlaying ? '일시정지' : '재생'}
            className="grow"
            onClick={() => void (isPlaying ? control.pause() : control.play()).then(pb.resync).catch(() => undefined)}
          />
        </div>
        <div className="row">
          <Button label="취소" className="grow" onClick={props.onDone} />
          <Button
            kind="primary"
            className="grow2"
            label={saving ? '저장 중…' : done ? '저장' : `여기까지 저장 (${taps.length}/${targets.length})`}
            onClick={() => void save()}
            disabled={saving || taps.length === 0}
          />
        </div>
        {!done && taps.length > 0 ? (
          <Note>끝까지 기록하지 않고 저장하면 기록하지 않은 줄은 강조되지 않습니다.</Note>
        ) : null}
      </div>
    </div>
  );
}
