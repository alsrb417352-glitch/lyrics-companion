import type { MusicKitItemRaw, MusicKitSnapshotRaw } from '@lyrics-companion/core';
import { isRelayMessage, TAG, type PageMessage, type QueueRaw, type RelayMessage } from '../shared/protocol';

/**
 * music.apple.com 페이지 안(MAIN world)에서 도는 다리. 웹 플레이어의 MusicKit 인스턴스에서 값을 읽어 그대로 넘기고,
 * 패널이 보낸 재생 제어 명령만 실행한다. 값의 해석·검증은 core(musickit-web.ts)가 한다.
 * - 패널이 연결되어 있을 때(watch)만 읽는다: 재생 중 0.25초, 멈춤 1초 간격 + MusicKit 이벤트 즉시.
 * - 페이지 데이터(계정·토큰·보관함)를 읽거나 Apple 서버에 요청하지 않는다. 지금 재생·대기열 값만 읽는다.
 */

type Listener = (...args: unknown[]) => void;

interface MediaItemLike {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  artistName?: unknown;
  albumName?: unknown;
  playbackDuration?: unknown;
  isrc?: unknown;
  catalogId?: unknown;
  attributes?: {
    name?: unknown;
    artistName?: unknown;
    albumName?: unknown;
    durationInMillis?: unknown;
    isrc?: unknown;
    playParams?: { id?: unknown; kind?: unknown; catalogId?: unknown };
  };
}

interface MusicKitLike {
  nowPlayingItem?: MediaItemLike | null;
  playbackState?: unknown;
  currentPlaybackTime?: unknown;
  playbackRate?: unknown;
  previewOnly?: unknown;
  queue?: { items?: MediaItemLike[]; position?: unknown };
  play(): Promise<unknown>;
  pause(): unknown;
  seekToTime(sec: number): Promise<unknown>;
  skipToNextItem(): Promise<unknown>;
  skipToPreviousItem(): Promise<unknown>;
  changeToMediaAtIndex(i: number): Promise<unknown>;
  addEventListener(name: string, fn: Listener): void;
}

declare global {
  interface Window {
    MusicKit?: { getInstance(): MusicKitLike | undefined };
    __lcPageBridge?: boolean;
  }
}

const PLAYING_POLL_MS = 250;
const IDLE_POLL_MS = 1000;

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function itemRaw(it: MediaItemLike | null | undefined): MusicKitItemRaw | null {
  if (!it || typeof it !== 'object') return null;
  const a = safe(() => it.attributes) ?? {};
  const pp = safe(() => a.playParams) ?? {};
  return {
    id: safe(() => it.id),
    type: safe(() => it.type),
    title: safe(() => a.name) ?? safe(() => it.title),
    artist: safe(() => a.artistName) ?? safe(() => it.artistName),
    album: safe(() => a.albumName) ?? safe(() => it.albumName),
    durationMs: safe(() => a.durationInMillis) ?? safe(() => it.playbackDuration),
    isrc: safe(() => a.isrc) ?? safe(() => it.isrc),
    playParamsId: safe(() => pp.id),
    playParamsKind: safe(() => pp.kind),
    catalogId: safe(() => pp.catalogId) ?? safe(() => it.catalogId),
  };
}

function audioElement(): HTMLMediaElement | null {
  const el = document.getElementById('apple-music-player');
  return el instanceof HTMLMediaElement ? el : null;
}

function readSnapshot(mk: MusicKitLike): MusicKitSnapshotRaw {
  const el = audioElement();
  return {
    item: itemRaw(safe(() => mk.nowPlayingItem)),
    state: safe(() => mk.playbackState),
    mkTimeSec: safe(() => mk.currentPlaybackTime),
    // 실제 소리를 내는 오디오 요소의 위치를 마지막에 읽는다(보내기 직전 값)
    mkRate: safe(() => mk.playbackRate),
    previewOnly: safe(() => mk.previewOnly),
    elementRate: el ? safe(() => el.playbackRate) : null,
    elementTimeSec: el ? safe(() => el.currentTime) : null,
  };
}

function readQueue(mk: MusicKitLike): QueueRaw {
  const items = safe(() => mk.queue?.items) ?? [];
  return {
    items: (Array.isArray(items) ? items.slice(0, 1000) : []).map((it) => itemRaw(it) ?? {}),
    position: safe(() => mk.queue?.position),
  };
}

function post(msg: PageMessage): void {
  window.postMessage(msg, location.origin);
}

function start(): void {
  if (window.__lcPageBridge) return; // 다시 주입되어도 한 번만
  window.__lcPageBridge = true;

  let mk: MusicKitLike | null = null;
  let watching = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const sendState = (withQueue = false) => {
    if (!mk || !watching) return;
    const raw = readSnapshot(mk);
    // 측정 시각: 다른 문서와 비교할 수 있는 고해상도 epoch(패널이 전달 지연만큼만 보정한다)
    const sentAt = performance.timeOrigin + performance.now();
    post({ __lc: TAG, from: 'page', kind: 'state', raw, sentAt, ...(withQueue ? { queue: readQueue(mk) } : {}) });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!mk || !watching) return;
    const playing = safe(() => mk?.playbackState) === 2;
    timer = setTimeout(
      () => {
        sendState();
        schedule();
      },
      playing ? PLAYING_POLL_MS : IDLE_POLL_MS,
    );
  };

  const attach = (instance: MusicKitLike) => {
    mk = instance;
    const onChange = () => {
      sendState();
      schedule();
    };
    for (const ev of ['playbackStateDidChange', 'nowPlayingItemDidChange', 'playbackRateDidChange']) {
      safe(() => instance.addEventListener(ev, onChange));
    }
    for (const ev of ['queueItemsDidChange', 'queuePositionDidChange']) {
      safe(() => instance.addEventListener(ev, () => sendState(true)));
    }
    post({ __lc: TAG, from: 'page', kind: 'status', musicKit: 'ready' });
    sendState(true);
    schedule();
  };

  // 웹 플레이어가 MusicKit을 늦게 만들 수 있어 잠시 기다린다(최대 약 60초).
  let tries = 0;
  const find = () => {
    const instance = safe(() => window.MusicKit?.getInstance());
    if (instance) {
      attach(instance);
      return;
    }
    tries += 1;
    if (tries === 20) post({ __lc: TAG, from: 'page', kind: 'status', musicKit: 'missing' });
    if (tries < 120) setTimeout(find, 500);
  };
  find();

  const run = async (m: Extract<RelayMessage, { kind: 'command' }>): Promise<{ queue?: QueueRaw }> => {
    if (!mk) throw new Error('웹 플레이어가 아직 준비되지 않았습니다');
    const arg = typeof m.arg === 'number' && Number.isFinite(m.arg) ? m.arg : null;
    switch (m.cmd) {
      case 'play':
        await mk.play();
        return {};
      case 'pause':
        await mk.pause();
        return {};
      case 'seek':
        if (arg === null || arg < 0) throw new Error('잘못된 위치');
        await mk.seekToTime(arg);
        return {};
      case 'next':
        await mk.skipToNextItem();
        return {};
      case 'prev':
        await mk.skipToPreviousItem();
        return {};
      case 'playAt':
        if (arg === null || !Number.isInteger(arg) || arg < 0) throw new Error('잘못된 위치');
        await mk.changeToMediaAtIndex(arg);
        await mk.play();
        return {};
      case 'queue':
        return { queue: readQueue(mk) };
    }
  };

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== location.origin || !isRelayMessage(e.data)) return;
    const m = e.data;
    if (m.kind === 'watch') {
      watching = m.on === true;
      if (watching) sendState(true);
      schedule();
      return;
    }
    if (m.kind === 'command') {
      run(m).then(
        (r) => {
          post({ __lc: TAG, from: 'page', kind: 'result', id: m.id, ok: true, ...r });
          sendState();
          schedule();
        },
        (err: unknown) =>
          post({
            __lc: TAG,
            from: 'page',
            kind: 'result',
            id: m.id,
            ok: false,
            error: err instanceof Error ? err.message.slice(0, 200) : '실패',
          }),
      );
    }
  });
}

start();
