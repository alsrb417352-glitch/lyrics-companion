import { useEffect, useMemo, useState } from 'react';
import type { ServiceTrackRef } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { BatchPanel, ITEM_BADGE } from './BatchPanel';
import { BundlePanel } from './BundlePanel';
import { ArtworkTile, Note, mmss, useBatchState, type Msg } from './common';
import { Icon } from './icons';
import type { PlaybackApi } from './usePlayback';

/** 대기열 일괄 작업 구분 키(곡 구성이 같으면 같은 키 → 결과 표시가 이어진다) */
function queueKey(refs: readonly ServiceTrackRef[]): string {
  let h = 0;
  for (const r of refs) for (const ch of `${r.serviceTrackId ?? r.title}|`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `queue:${refs.length}:${h.toString(36)}`;
}

/**
 * 대기열 탭(PC). iPhone의 "플레이리스트" 탭 대신, Apple Music 웹에서 재생한 플레이리스트·앨범의 **현재 대기열**을 쓴다.
 * - 웹 플레이어가 이미 가진 대기열 값만 읽는다(Apple 서버에 따로 요청하지 않음). 플레이리스트 고르기·재생은 Apple Music 웹에서.
 * - 곡을 누르면 그 곡부터 재생. 가사 원문 일괄 받기(D-31)·번역 묶음(D-34·D-35)은 iPhone과 같은 core 기능.
 */
export function QueueTab(props: { services: AppServices; playback: PlaybackApi; onOpenNowPlaying: () => void }) {
  const { services, playback: pb } = props;
  const queue = pb.status.queue;
  const refs = useMemo(() => (queue ? queue.map((q) => q.ref) : null), [queue]);
  const key = useMemo(() => (refs ? queueKey(refs) : ''), [refs]);
  const batchState = useBatchState(services.playlistBatch);
  const [saved, setSaved] = useState<Set<number> | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!refs) {
      setSaved(null);
      return;
    }
    let alive = true;
    services.playlistBatch.savedIndexes(refs).then(
      (set) => {
        if (alive) setSaved(set);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [refs, services.playlistBatch, batchState.running, refresh]);

  const { badges, savedNow } = useMemo(() => {
    const b = new Map<number, string>();
    if (batchState.key !== key || !saved) return { badges: b, savedNow: saved };
    const merged = new Set(saved);
    for (const it of batchState.items) {
      if (it.status === 'saved' || it.status === 'already-saved') merged.add(it.index);
      const t = ITEM_BADGE[it.status];
      if (t) b.set(it.index, t);
    }
    return { badges: b, savedNow: merged };
  }, [key, saved, batchState.key, batchState.items]);

  if (pb.status.tabs === 0) {
    return (
      <div className="center-box">
        <Note>Apple Music 웹과 연결되면 지금 대기열의 곡이 여기에 보입니다.</Note>
      </div>
    );
  }
  if (!queue || queue.length === 0) {
    return (
      <div className="center-box">
        <ArtworkTile seed="queue" size={64} icon="queue" />
        <Note>
          대기열이 비어 있습니다. Apple Music 웹에서 플레이리스트나 앨범을 재생하면 그 곡들이 여기에 보이고, 가사 원문을
          한 번에 받거나 번역을 한꺼번에 넣을 수 있습니다.
        </Note>
      </div>
    );
  }

  const label = `Apple Music 대기열 ${queue.length}곡`;
  return (
    <div className="scroll">
      <div className="pad stack">
        <h2>
          지금 대기열 <span className="dim">· {queue.length}곡</span>
          {savedNow ? <span className="dim"> · 가사 {savedNow.size}곡 저장됨</span> : null}
        </h2>
        {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
        <BatchPanel
          batch={services.playlistBatch}
          listKey={key}
          listName={label}
          tracks={refs}
          savedCount={savedNow ? savedNow.size : null}
        />
        <BundlePanel
          services={services}
          listName="Apple Music 대기열"
          tracks={refs}
          onSaved={() => setRefresh((n) => n + 1)}
        />
      </div>
      <ol className="queue">
        {queue.map((q, i) => {
          const isNow = pb.status.queuePosition === q.index;
          const has = savedNow?.has(i) ?? false;
          return (
            <li key={`${q.index}-${q.ref.serviceTrackId ?? q.ref.title}`}>
              <button
                type="button"
                className={`queue-item${isNow ? ' queue-now' : ''}`}
                aria-current={isNow ? 'true' : undefined}
                aria-label={`${q.ref.title}, ${q.ref.artist}${has ? ', 가사 저장됨' : ''}. 이 곡 재생`}
                onClick={() => {
                  setMsg(null);
                  services.playback
                    .playQueueIndex(q.index)
                    .then(props.onOpenNowPlaying, (e: unknown) =>
                      setMsg({ text: e instanceof Error ? e.message : '재생하지 못했습니다', danger: true }),
                    );
                }}
              >
                <ArtworkTile seed={`${q.ref.album ?? q.ref.title}|${q.ref.artist}`} size={40} />
                <span className="grow min0">
                  <span className="li-title ellipsis">
                    {isNow ? <Icon name="play" size={12} className="accent" /> : null} {q.ref.title}
                  </span>
                  <span className="li-sub ellipsis">
                    {has ? <Icon name="check" size={12} className="accent" /> : null} {q.ref.artist}
                    {q.ref.album ? ` · ${q.ref.album}` : ''}
                  </span>
                </span>
                {!has && badges.has(i) ? <span className="badge">{badges.get(i)}</span> : null}
                <span className="faint tabular">{mmss(q.ref.durationMs)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
