import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { BatchState, NowPlayingSession, PlaylistLyricsBatch, SessionState } from '@lyrics-companion/core';
import { Icon, type IconName } from './icons';

export function useSessionState(session: NowPlayingSession): SessionState {
  const [state, setState] = useState(session.current);
  useEffect(() => {
    setState(session.current);
    const unsubscribe = session.subscribe(setState);
    return () => {
      unsubscribe();
    };
  }, [session]);
  return state;
}

/** 일괄 받기 상태 구독(탭을 옮겼다 돌아와도 진행 상황이 이어서 보임) */
export function useBatchState(batch: PlaylistLyricsBatch): BatchState {
  const [state, setState] = useState(batch.current);
  useEffect(() => {
    setState(batch.current);
    return batch.subscribe(setState);
  }, [batch]);
  return state;
}

type Kind = 'plain' | 'primary' | 'danger' | 'soft';

export function Button(
  props: { label: string; kind?: Kind; icon?: IconName } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
) {
  const { label, kind = 'plain', icon, className, ...rest } = props;
  return (
    <button type="button" className={`btn btn-${kind}${className ? ` ${className}` : ''}`} {...rest}>
      {icon ? <Icon name={icon} size={18} /> : null}
      <span>{label}</span>
    </button>
  );
}

/** 아이콘만 있는 버튼: 접근성 이름(label)을 반드시 받는다. 마우스를 올리면 같은 이름이 보인다. */
export function IconButton(
  props: { icon: IconName; label: string; size?: number; iconSize?: number; kind?: Kind } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'children'
  >,
) {
  const { icon, label, size = 36, iconSize = 20, kind = 'plain', className, style, ...rest } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn icon-btn-${kind}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}

export function Chip(props: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`chip${props.on ? ' chip-on' : ''}`}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

export function Note(props: { children: ReactNode; tone?: 'dim' | 'danger' }) {
  return (
    <p
      className={`note${props.tone === 'danger' ? ' note-danger' : ''}`}
      role={props.tone === 'danger' ? 'alert' : undefined}
    >
      {props.children}
    </p>
  );
}

/** 이름으로 색이 정해지는 자체 디자인 타일(실제 앨범 아트 아님, D-32) */
export function ArtworkTile(props: { seed: string; size: number; icon?: IconName }) {
  let h = 0;
  for (const ch of props.seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const hue = h % 360;
  const hue2 = (hue + 40) % 360;
  return (
    <div
      className="art"
      aria-hidden="true"
      style={{
        width: props.size,
        height: props.size,
        background: `linear-gradient(135deg, hsl(${hue} 55% 52%), hsl(${hue2} 60% 38%))`,
      }}
    >
      <Icon name={props.icon ?? 'note'} size={Math.round(props.size * 0.45)} />
    </div>
  );
}

export function mmss(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '–:––';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type Msg = { text: string; danger?: boolean } | null;
