import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { sameIosTrack, type PlaybackAccess, type PlaybackSnapshot, type ServiceTrackRef } from '@lyrics-companion/core';
import type { AppServices } from '../services';

/** 화면 표시 중 재조회 간격. Music 앱은 탐색(seek) 알림이 없을 수 있어 짧게 다시 읽어 위치를 맞춘다. */
const POLL_MS = 500;

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

  const handle = useCallback(
    (snap: PlaybackSnapshot | null) => {
      snapshotRef.current = snap;
      setSnapshot(snap);
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

  return { access, snapshot, latest, requestAccess, refresh };
}

export type PlaybackApi = ReturnType<typeof usePlayback>;
