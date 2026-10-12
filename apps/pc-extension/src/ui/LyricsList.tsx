import { memo, useEffect, useRef, useState } from 'react';
import type { LyricsScreenView } from '@lyrics-companion/core';
import { Button } from './common';

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * 가사 목록: 원문·발음·번역을 한 행 묶음으로 표시(REQ-UI-02).
 * 현재 행으로 자동 스크롤하되, 사용자가 직접 스크롤하면 추적을 멈추고 "현재 가사로" 버튼을 보인다(REQ-UI-05).
 * '동작 줄이기'(Windows 애니메이션 효과 끔)면 애니메이션 없이 이동한다(REQ-UI-04). 행 단위로만 강조한다.
 */
function LyricsListImpl(props: { view: LyricsScreenView; onPressLine?: (index: number) => void }) {
  const { view } = props;
  const box = useRef<HTMLDivElement>(null);
  const rows = useRef<Array<HTMLElement | null>>([]);
  const [follow, setFollow] = useState(true);
  const auto = useRef(false);
  const pressRef = useRef(props.onPressLine);
  pressRef.current = props.onPressLine;
  const canPress = !!props.onPressLine;

  useEffect(() => {
    if (!follow || view.activeIndex === null) return;
    const el = rows.current[view.activeIndex];
    const container = box.current;
    if (!el || !container) return;
    const target = el.offsetTop - container.clientHeight * 0.35 + el.offsetHeight / 2;
    auto.current = true;
    container.scrollTo({ top: Math.max(0, target), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const t = setTimeout(() => {
      auto.current = false;
    }, 700);
    return () => clearTimeout(t);
  }, [view.activeIndex, follow]);

  // 사용자가 직접 움직였을 때만 추적을 멈춘다(자동 스크롤 이벤트는 무시)
  const stopFollow = () => {
    if (!auto.current) setFollow(false);
  };

  return (
    <div className="lyrics-wrap">
      <div
        className={`lyrics mode-${view.mode}`}
        ref={box}
        onWheel={stopFollow}
        onTouchMove={stopFollow}
        onKeyDown={(e) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) stopFollow();
        }}
        tabIndex={0}
        aria-label="가사"
      >
        {view.rows.map((row, i) => {
          const cls = `line line-${row.state}${canPress ? ' line-press' : ''}`;
          const content = (
            <>
              <span className="orig">{row.original || ' '}</span>
              {row.pronunciation ? <span className="pron">{row.pronunciation}</span> : null}
              {row.translation ? <span className="trans">{row.translation}</span> : null}
            </>
          );
          return canPress ? (
            <button
              type="button"
              key={row.lineId}
              ref={(el) => {
                rows.current[i] = el;
              }}
              className={cls}
              aria-label={`${row.accessibilityLabel}. 이 줄로 이동`}
              aria-current={row.state === 'active' ? 'true' : undefined}
              onClick={() => pressRef.current?.(i)}
            >
              {content}
            </button>
          ) : (
            <div
              key={row.lineId}
              ref={(el) => {
                rows.current[i] = el;
              }}
              className={cls}
              aria-label={row.accessibilityLabel}
              aria-current={row.state === 'active' ? 'true' : undefined}
            >
              {content}
            </div>
          );
        })}
        <div className="lyrics-tail" />
      </div>
      {!follow && view.mode === 'synced' ? (
        <div className="floating">
          <Button kind="primary" label="현재 가사로" onClick={() => setFollow(true)} />
        </div>
      ) : null}
    </div>
  );
}

/** 같은 화면 구성(view)이면 다시 그리지 않는다 */
export const LyricsList = memo(LyricsListImpl, (a, b) => a.view === b.view && !!a.onPressLine === !!b.onPressLine);
