import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ServiceTrackRef } from '@lyrics-companion/core';
import type { AndroidMediaPlayback, AndroidQueue } from '../adapters/android-playback-source';
import type { AppServices } from '../services';
import { ArtworkTile, Button, IconButton, Note } from './common';
import { Icon } from './icons';
import { ITEM_BADGE, PlaylistLyricsBatchPanel, useBatchState } from './PlaylistLyricsBatchPanel';
import type { Theme } from './theme';
import { TranslationBundlePanel } from './TranslationBundlePanel';
import type { PlaybackApi } from './usePlayback';

function mmss(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 일괄 작업 구분 키(앱·곡 구성이 같으면 같은 키 → 결과 표시가 이어진다) */
function queueKey(pkg: string, refs: readonly ServiceTrackRef[]): string {
  let h = 0;
  for (const r of refs) for (const ch of `${r.serviceTrackId ?? r.title}|`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `queue:${pkg}:${refs.length}:${h.toString(36)}`;
}

/**
 * 플레이리스트 탭(Android, docs/plan.md D-41). Spotify·YouTube Music은 플레이리스트 목록을 읽는 공개 OS API가 없어서,
 * iPhone의 "플레이리스트 안" 화면과 같은 모양으로 **지금 따르는 앱의 재생 목록(대기열)**을 보여 준다(PC 대기열 탭과 같은 방식, D-36).
 * - 재생 앱이 미디어 세션으로 알려 준 재생 목록만 읽는다(앱 서버에 따로 요청하지 않음). 플레이리스트 고르기는 그 앱에서.
 * - 곡을 누르면 그 곡부터 재생. 가사 원문 일괄 받기(D-31)·번역 묶음(D-34·D-35)은 iPhone과 같은 core 기능.
 */
export function QueueScreen(props: {
  services: AppServices;
  android: AndroidMediaPlayback;
  playback: PlaybackApi;
  theme: Theme;
  onOpenNowPlaying: () => void;
}) {
  const { services, android, playback: pb, theme } = props;
  const [queue, setQueue] = useState<AndroidQueue | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<number> | null>(null);
  const batchState = useBatchState(services.playlistBatch);
  const followedService = pb.snapshot?.track?.service ?? null;

  const load = useCallback(async () => {
    try {
      setQueue(await android.queue());
    } catch {
      setQueue(null);
      setMessage('재생 목록을 읽지 못했습니다.');
    }
  }, [android]);

  // 처음 열 때, 따르는 앱이 바뀔 때 다시 읽는다
  useEffect(() => {
    if (pb.access === 'granted') void load();
  }, [pb.access, followedService, load]);

  const tracks = queue && queue !== 'loading' ? queue.tracks : null;
  const refs = useMemo(() => (tracks ? tracks.map((t) => t.ref) : null), [tracks]);
  const key = useMemo(
    () => (queue && queue !== 'loading' && refs ? queueKey(queue.app.packageName, refs) : ''),
    [queue, refs],
  );

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
  }, [refs, services.playlistBatch, batchState.running]);

  const { batchBadges, savedNow } = useMemo(() => {
    const badges = new Map<number, string>();
    if (batchState.key !== key || !saved) return { batchBadges: badges, savedNow: saved };
    const merged = new Set(saved);
    for (const it of batchState.items) {
      if (it.status === 'saved' || it.status === 'already-saved') merged.add(it.index);
      const b = ITEM_BADGE[it.status];
      if (b) badges.set(it.index, b);
    }
    return { batchBadges: badges, savedNow: merged };
  }, [key, saved, batchState.key, batchState.items]);

  const run = async (action: () => Promise<boolean>, failText: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!(await action())) {
        setMessage(failText);
        return;
      }
      void pb.resync();
      props.onOpenNowPlaying();
    } catch {
      setMessage(failText);
    } finally {
      setBusy(false);
    }
  };

  const playFrom = (queueId: string) =>
    run(
      () => android.playQueueItem(queueId),
      '그 곡을 재생하지 못했습니다. 재생 앱이 곡 선택을 지원하지 않을 수 있습니다.',
    );

  const playAll = (shuffle: boolean) =>
    run(async () => {
      const first = tracks?.[0];
      if (!first) return false;
      // iPhone과 같은 동작: "재생"은 셔플 끄고 처음부터, "셔플"은 셔플 켜고 재생
      await android.setShuffle(shuffle).catch(() => false);
      if (shuffle) {
        await android.control.play();
        return true;
      }
      return android.playQueueItem(first.queueId);
    }, '재생하지 못했습니다. 재생 앱에서 직접 재생해 주세요.');

  if (pb.access !== 'granted') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Note theme={theme}>재생 목록을 보려면 알림 접근을 허용해야 합니다(지금 재생 탭에서 허용할 수 있습니다).</Note>
      </View>
    );
  }
  if (queue === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!queue) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ArtworkTile seed="queue" size={96} icon="playlist" radius={18} />
        <Note theme={theme}>
          {message ??
            'Spotify·YouTube Music·Apple Music에서 플레이리스트나 앨범을 재생하면 그 재생 목록이 여기에 보이고, 가사 원문을 한 번에 받거나 번역을 한꺼번에 넣을 수 있습니다.'}
        </Note>
        <Button theme={theme} icon="refresh" label="다시 읽기" onPress={() => void load()} />
      </View>
    );
  }

  const title = queue.title ?? `${queue.app.label} 재생 목록`;
  const canPlay = !busy && !!tracks && tracks.length > 0;
  const header = (
    <View style={styles.pad}>
      <View style={styles.topBar}>
        <Text style={[styles.h1, { color: theme.text }]}>플레이리스트</Text>
        <IconButton
          theme={theme}
          icon="refresh"
          label="새로고침"
          kind="soft"
          size={36}
          iconSize={18}
          onPress={() => void load()}
        />
      </View>
      <View style={styles.hero}>
        <ArtworkTile seed={title} size={168} icon="playlist" radius={18} />
        <Text style={[styles.heroTitle, { color: theme.text }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={{ color: theme.textDim, fontSize: 14 }}>
          {queue.app.label} · 지금 재생 목록 {tracks ? `${tracks.length}곡` : ''}
          {tracks && savedNow ? ` · 가사 ${savedNow.size}곡 저장됨` : ''}
        </Text>
      </View>
      <View style={styles.row}>
        <Button
          theme={theme}
          kind="primary"
          icon="play"
          label={busy ? '…' : '재생'}
          accessibilityLabel="처음부터 재생"
          onPress={() => void playAll(false)}
          disabled={!canPlay}
          style={styles.pill}
        />
        <Button
          theme={theme}
          icon="shuffle"
          label="셔플"
          accessibilityLabel="섞어서 재생"
          onPress={() => void playAll(true)}
          disabled={!canPlay}
          style={styles.pill}
        />
      </View>
      {message ? (
        <Note theme={theme} tone="danger">
          {message}
        </Note>
      ) : null}
      {tracks && tracks.length > 0 ? (
        <>
          <PlaylistLyricsBatchPanel
            batch={services.playlistBatch}
            theme={theme}
            playlistKey={key}
            playlistName={title}
            tracks={refs}
            savedCount={savedNow ? savedNow.size : null}
          />
          <TranslationBundlePanel services={services} theme={theme} playlistName={title} tracks={refs} />
        </>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <FlatList
        data={tracks ?? []}
        keyExtractor={(t) => t.queueId}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.pad}>
            <Note theme={theme}>
              {queue.app.label} 앱이 재생 목록을 알려 주지 않았습니다. 그 앱에서 플레이리스트나 앨범을 재생한 뒤
              새로고침해 보세요(앱에 따라 재생 목록을 제공하지 않을 수 있습니다).
            </Note>
          </View>
        }
        renderItem={({ item, index }) => {
          const active = queue.activeQueueId === item.queueId;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.ref.title}, ${item.ref.artist}${savedNow?.has(index) ? ', 가사 저장됨' : ''}${active ? ', 지금 재생 중' : ''}. 이 곡부터 재생`}
              onPress={() => void playFrom(item.queueId)}
              disabled={busy}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
            >
              <ArtworkTile seed={`${item.ref.album ?? item.ref.title}|${item.ref.artist}`} size={48} />
              <View style={styles.itemText}>
                <Text
                  style={{ color: active ? theme.accent : theme.text, fontSize: 16, fontWeight: '600' }}
                  numberOfLines={1}
                >
                  {item.ref.title}
                </Text>
                <View style={styles.subRow}>
                  {savedNow?.has(index) ? <Icon name="check" size={14} color={theme.accent} strokeWidth={2.6} /> : null}
                  <Text style={{ color: theme.textDim, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
                    {item.ref.artist}
                  </Text>
                </View>
              </View>
              {!savedNow?.has(index) && batchBadges.has(index) ? (
                <View style={[styles.badge, { backgroundColor: theme.surface }]}>
                  <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '600' }}>
                    {batchBadges.get(index)}
                  </Text>
                </View>
              ) : null}
              <Text style={{ color: theme.textFaint, fontSize: 13, marginLeft: 8, fontVariant: ['tabular-nums'] }}>
                {mmss(item.ref.durationMs)}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'stretch', padding: 24, gap: 8 },
  pad: { padding: 16 },
  h1: { fontSize: 30, fontWeight: '800' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  hero: { alignItems: 'center', gap: 6, marginTop: 4 },
  heroTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  pill: { flex: 1, borderRadius: 999, minHeight: 46 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  itemText: { flex: 1, minWidth: 0 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, marginLeft: 6 },
});
