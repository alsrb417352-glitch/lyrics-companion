import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  PositionFilter,
  sameIosTrack,
  type PlaybackAccess,
  type PlaybackSnapshot,
  type ServiceTrackRef,
} from '@lyrics-companion/core';
import type { AppServices } from '../services';

/**
 * 화면 표시 중 재조회 간격. Music 앱은 탐색(seek) 알림이 없을 수 있어 짧게 다시 읽어 위치를 맞춘다.
 * 측정이 많을수록 PositionFilter가 "가장 덜 늦은" 측정을 고르기 쉬워진다(D-25). 호출은 가볍다.
 */
const POLL_MS = 250;

/** 화면을 다시 그려야 하는 변화(위치 값 자체는 ref로만 전달해 매 측정마다 다시 그리지 않는다) */
function visibleKey(s: PlaybackSnapshot | null): string {
  if (!s) return 'none';
  return `${s.status}|${s.positionMs === null ? 'nopos' : 'pos'}|${s.track?.serviceTrackId ?? ''}|${s.track?.title ?? ''}`;
}

/**
 * Music 앱 재생 상태 훅(Apple Music 전용, docs/plan.md D-17).
 * - 곡 변경·재생 상태 알림을 받고, 화면이 보이는 동안 0.5초마다 위치를 다시 읽는다.
 * - 앱이 백그라운드면 조회하지 않고, 돌아오면 즉시 다시 읽는다(오래된 측정값으로 진행을 꾸며내지 않음).
 */
export function usePlayback(services: AppServices) {
  const { playback, session } = services;
  const [access, setAccess] = useState<PlaybackAccess | 'loading'>(playback ? 'loading' : 'unsupported');
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const snapshotRef = useRef<PlaybackSnapshot | null>(null);
  const lastTrack = useRef<ServiceTrackRef | null>(null);
  const filter = useRef(new PositionFilter());
  const lastKey = useRef('');

  const handle = useCallback(
    (raw: PlaybackSnapshot | null) => {
      // 늦게 읽힌 측정을 걸러 낸 위치(core PositionFilter, AT-17)
      const snap = raw ? filter.current.push(raw) : null;
      if (!raw) filter.current.reset();
      snapshotRef.current = snap;
      const key = visibleKey(snap);
      if (key !== lastKey.current) {
        lastKey.current = key;
        setSnapshot(snap);
      }
      const track = snap?.track ?? null;
      if (!sameIosTrack(lastTrack.current, track)) {
        lastTrack.current = track;
        if (track) void session.onTrackChanged(track);
      }
    },
    [session],
  );

  const refresh = useCallback(async () => {
    if (!playback) return;
    try {
      handle(await playback.current());
    } catch {
      // 일시적 오류는 다음 주기에 다시 읽는다. 위치를 꾸며내지 않는다.
    }
  }, [playback, handle]);

  useEffect(() => {
    if (!playback) return;
    let cancelled = false;
    void playback.access().then((a) => {
      if (!cancelled) setAccess(a);
    });
    return () => {
      cancelled = true;
    };
  }, [playback]);

  useEffect(() => {
    if (!playback || access !== 'granted') return;
    const unsubscribe = playback.subscribe(handle);
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      // 백그라운드에 있던 동안의 측정 기록은 믿지 않는다
      filter.current.reset();
    };
    start();
    const appSub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => {
      stop();
      appSub.remove();
      unsubscribe();
    };
  }, [playback, access, handle, refresh]);

  const requestAccess = useCallback(async () => {
    if (!playback) return;
    setAccess(await playback.requestAccess());
  }, [playback]);

  /** 화면 계산용 최신 스냅샷(렌더 사이에도 최신 값을 쓰기 위해 ref로 읽는다) */
  const latest = useCallback(() => snapshotRef.current, []);

  /** 우리 앱이 탐색·재생 제어를 한 직후: 이전 측정 기록을 버리고 바로 다시 읽는다 */
  const resync = useCallback(async () => {
    filter.current.reset();
    await refresh();
  }, [refresh]);

  return { access, snapshot, latest, requestAccess, refresh, resync };
}

export type PlaybackApi = ReturnType<typeof usePlayback>;
