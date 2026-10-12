import { useEffect, useState } from 'react';
import type { PlaybackControl } from '@lyrics-companion/core';
import { IconButton, mmss } from './common';

const SKIP_MS = 10_000;

/**
 * 재생 막대: 진행 막대(클릭하면 이동)·경과/남은 시간·이전/10초 뒤로/재생·일시정지/10초 앞으로/다음.
 * 위치를 모르면 진행 막대를 비워 두고 탐색 버튼을 끈다(불변조건 5 — 진행을 꾸며내지 않음).
 */
export function PlaybackBar(props: {
  control: PlaybackControl;
  isPlaying: boolean;
  durationMs: number | null;
  position: () => number | null;
  resync: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { control, durationMs } = props;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!props.isPlaying) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [props.isPlaying]);

  const pos = props.position();
  const pct = pos !== null && durationMs ? Math.min(100, (pos / durationMs) * 100) : null;

  const run = (p: Promise<void>) =>
    void p.then(props.resync).catch((e: unknown) => props.onError(e instanceof Error ? e.message : '실패했습니다'));

  const seekBy = (delta: number) => {
    const p = props.position();
    if (p === null) return;
    const target = Math.max(0, durationMs ? Math.min(durationMs - 500, p + delta) : p + delta);
    run(control.seekTo(target));
  };

  return (
    <div className="pbar">
      <div className="pbar-progress">
        <span className="pbar-time">{mmss(pos)}</span>
        <div
          className="pbar-track"
          role="slider"
          aria-label="재생 위치"
          aria-valuemin={0}
          aria-valuemax={durationMs ? Math.round(durationMs / 1000) : 0}
          aria-valuenow={pos !== null ? Math.round(pos / 1000) : undefined}
          aria-valuetext={pos !== null ? mmss(pos) : '위치 모름'}
          tabIndex={pct === null ? -1 : 0}
          onClick={(e) => {
            if (pct === null || !durationMs) return;
            const r = e.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            run(control.seekTo(ratio * durationMs));
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seekBy(5_000);
            else if (e.key === 'ArrowLeft') seekBy(-5_000);
          }}
        >
          <div className="pbar-fill" style={{ width: `${pct ?? 0}%` }} />
        </div>
        <span className="pbar-time">
          {durationMs && pos !== null ? `-${mmss(Math.max(0, durationMs - pos))}` : mmss(durationMs)}
        </span>
      </div>
      <div className="pbar-buttons">
        <IconButton icon="prev" label="이전 곡" onClick={() => run(control.skipPrevious())} />
        <IconButton icon="back10" label="10초 뒤로" onClick={() => seekBy(-SKIP_MS)} disabled={pos === null} />
        <IconButton
          icon={props.isPlaying ? 'pause' : 'play'}
          label={props.isPlaying ? '일시정지' : '재생'}
          kind="primary"
          size={48}
          iconSize={24}
          className="round"
          onClick={() => run(props.isPlaying ? control.pause() : control.play())}
        />
        <IconButton icon="fwd10" label="10초 앞으로" onClick={() => seekBy(SKIP_MS)} disabled={pos === null} />
        <IconButton icon="next" label="다음 곡" onClick={() => run(control.skipNext())} />
      </div>
    </div>
  );
}
