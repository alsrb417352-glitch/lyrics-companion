import { useCallback, useEffect, useRef, useState } from 'react';
import { PositionFilter, sameServiceTrack, type PlaybackSnapshot, type ServiceTrackRef } from '@lyrics-companion/core';
import type { WebPlaybackStatus } from '../adapters/web-playback';
import type { AppServices } from '../services';

/** 화면을 다시 그려야 하는 변화(위치 값 자체는 ref로만 전달해 매 측정마다 다시 그리지 않는다) */
function visibleKey(s: PlaybackSnapshot | null): string {
  if (!s) return 'none';
  return `${s.status}|${s.positionMs === null ? 'nopos' : 'pos'}|${s.track?.serviceTrackId ?? ''}|${s.track?.title ?? ''}`;
}

/**
 * Apple Music 웹 플레이어 재생 상태 훅.
 * - 탭이 보내는 측정(재생 중 0.25초 간격 + 이벤트)을 core PositionFilter로 걸러 늦게 읽힌 값을 버린다(D-25).
 * - 곡이 바뀌면 세션에 알린다(곡 식별·가사·번역 정책은 core).
 * - 패널이 숨겨져 있는 동안 받은 측정 기록은 믿지 않는다(다시 보이면 기록을 비운다).
 */
export function usePlayback(services: AppServices) {
  const { playback, session } = services;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [status, setStatus] = useState<WebPlaybackStatus>(playback.status());
  const snapshotRef = useRef<PlaybackSnapshot | null>(null);
  const lastTrack = useRef<ServiceTrackRef | null>(null);
  const filter = useRef(new PositionFilter());
  const lastKey = useRef('');

  const handle = useCallback(
    (raw: PlaybackSnapshot | null) => {
      const snap = raw ? filter.current.push(raw) : null;
      if (!raw) filter.current.reset();
      snapshotRef.current = snap;
      const key = visibleKey(snap);
      if (key !== lastKey.current) {
        lastKey.current = key;
        setSnapshot(snap);
      }
      const track = snap?.track ?? null;
      // 곡이 사라진 것(정지)은 곡 변경으로 보지 않는다 — 마지막 곡 가사를 그대로 둔다.
      if (track && !sameServiceTrack(lastTrack.current, track)) {
        lastTrack.current = track;
        void session.onTrackChanged(track);
      }
    },
    [session],
  );

  useEffect(() => {
    const unsubscribe = playback.subscribe(handle);
    const unStatus = playback.onStatus(setStatus);
    void playback.current().then((s) => {
      if (s) handle(s);
    });
    void playback.reconnect();
    const onVisible = () => {
      if (document.visibilityState === 'visible') filter.current.reset();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      unStatus();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [playback, handle]);

  /** 화면 계산용 최신 스냅샷(렌더 사이에도 최신 값을 쓰기 위해 ref로 읽는다) */
  const latest = useCallback(() => snapshotRef.current, []);

  /**
   * 우리 앱이 탐색·재생 제어를 한 직후: 이전 측정 기록을 버린다. 웹 플레이어가 명령 직후 새 측정을 보내 오므로
   * 마지막(명령 전) 값을 다시 넣지 않는다.
   */
  const resync = useCallback(async () => {
    filter.current.reset();
  }, []);

  return { snapshot, status, latest, resync };
}

export type PlaybackApi = ReturnType<typeof usePlayback>;
