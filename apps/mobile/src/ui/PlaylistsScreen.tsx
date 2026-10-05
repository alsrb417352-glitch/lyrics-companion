import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  filterPlaylists,
  libraryTrackToRef,
  mapLibraryPlaylists,
  mapLibraryTracks,
  type LibraryPlaylist,
  type LibraryTrack,
} from '@lyrics-companion/core';
import { NowPlaying } from '../../modules/now-playing';
import type { AppServices } from '../services';
import { ArtworkTile, Button, IconButton, Note } from './common';
import { Icon } from './icons';
import { ITEM_BADGE, PlaylistLyricsBatchPanel, useBatchState } from './PlaylistLyricsBatchPanel';
import type { Theme } from './theme';
import type { PlaybackApi } from './usePlayback';

function mmss(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 플레이리스트(REQ-PB-06, docs/plan.md D-30).
 * - 기기 보관함의 플레이리스트(직접 만든 것 + 보관함에 추가한 Apple Music 플레이리스트)를 보여 준다.
 * - 재생·셔플·곡 탭 → Music 앱 대기열을 그 플레이리스트로 바꾸고 바로 재생한다. Music 앱을 열 필요가 없다.
 *   재생이 시작되면 지금 재생 탭으로 넘어가고, 곡이 자동 인식되어 가사가 맞춰진다.
 * - MusicKit 카탈로그 API를 쓰지 않으므로(무료 서명, ADR-0002) 보관함에 추가하지 않은 플레이리스트는 보이지 않는다.
 * - 가사 원문 일괄 받기(REQ-LY-05, D-31): 플레이리스트 곡들의 원문을 한 번에 받아 둔다. 곡 옆 ✓는 가사가 저장된 곡.
 */
export function PlaylistsScreen(props: {
  services: AppServices;
  playback: PlaybackApi;
  theme: Theme;
  onOpenNowPlaying: () => void;
}) {
  const { services, playback: pb, theme } = props;
  const hasMusic = NowPlaying !== null && services.playback !== null;
  const [lists, setLists] = useState<LibraryPlaylist[] | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<LibraryPlaylist | null>(null);
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 가사가 이미 저장된 곡의 위치(저장소만 조회, 네트워크 없음) */
  const [saved, setSaved] = useState<Set<number> | null>(null);
  const batchState = useBatchState(services.playlistBatch);
  const refs = useMemo(() => (tracks ? tracks.map(libraryTrackToRef) : null), [tracks]);

  // 곡 목록을 읽었을 때와 일괄 받기가 시작·끝날 때 저장소로 저장 여부를 확인한다(진행 중에는 결과로 더한다).
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

  /** 이 플레이리스트의 마지막 일괄 받기 결과: 곡 위치 → 상태 문구, 그리고 저장된 곡을 더한 집합 */
  const { batchBadges, savedNow } = useMemo(() => {
    const badges = new Map<number, string>();
    const mineBatch = open !== null && batchState.key === open.persistentId;
    if (!mineBatch || !saved) return { batchBadges: badges, savedNow: saved };
    const merged = new Set(saved);
    for (const it of batchState.items) {
      if (it.status === 'saved' || it.status === 'already-saved') merged.add(it.index);
      const b = ITEM_BADGE[it.status];
      if (b) badges.set(it.index, b);
    }
    return { batchBadges: badges, savedNow: merged };
  }, [open, saved, batchState.key, batchState.items]);

  const loadLists = useCallback(async () => {
    if (!NowPlaying) return;
    setMessage(null);
    try {
      setLists(mapLibraryPlaylists(await NowPlaying.listPlaylists()));
    } catch {
      setLists([]);
      setMessage('플레이리스트를 읽지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    if (hasMusic && pb.access === 'granted') void loadLists();
  }, [hasMusic, pb.access, loadLists]);

  const openList = async (p: LibraryPlaylist) => {
    if (!NowPlaying) return;
    setOpen(p);
    setTracks(null);
    setMessage(null);
    try {
      setTracks(mapLibraryTracks(await NowPlaying.playlistItems(p.persistentId)));
    } catch {
      setTracks([]);
      setMessage('곡 목록을 읽지 못했습니다.');
    }
  };

  const play = async (startItemId: string | null, shuffle: boolean) => {
    if (!NowPlaying || !open || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await NowPlaying.playPlaylist(open.persistentId, startItemId, shuffle);
      void pb.refresh();
      props.onOpenNowPlaying();
    } catch {
      setMessage(
        '재생하지 못했습니다. Apple Music 구독 상태와 곡이 아직 재생 가능한지(Apple Music에서 내려간 곡 등) 확인해 주세요.',
      );
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => (lists ? filterPlaylists(lists, query) : []), [lists, query]);

  if (!hasMusic) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Note theme={theme}>이 기기에서는 Music 앱을 제어할 수 없습니다(iPhone 전용).</Note>
      </View>
    );
  }
  if (pb.access !== 'granted') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Note theme={theme}>
          플레이리스트를 보려면 Apple Music·보관함 접근을 허용해야 합니다(지금 재생 탭에서 허용할 수 있습니다).
        </Note>
        {pb.access === 'not-determined' ? (
          <Button theme={theme} kind="primary" label="접근 허용" onPress={() => void pb.requestAccess()} />
        ) : null}
      </View>
    );
  }

  // ---------- 플레이리스트 안
  if (open) {
    const canPlay = !busy && !!tracks && tracks.length > 0;
    const header = (
      <View style={styles.pad}>
        <View style={styles.topBar}>
          <IconButton
            theme={theme}
            icon="chevronLeft"
            label="플레이리스트 목록으로"
            size={40}
            iconSize={24}
            color={theme.accent}
            onPress={() => setOpen(null)}
          />
        </View>
        <View style={styles.hero}>
          <ArtworkTile seed={open.name} size={168} icon="playlist" radius={18} />
          <Text style={[styles.heroTitle, { color: theme.text }]} numberOfLines={2}>
            {open.name}
          </Text>
          <Text style={{ color: theme.textDim, fontSize: 14 }}>
            {tracks ? `${tracks.length}곡` : '불러오는 중…'}
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
            onPress={() => void play(null, false)}
            disabled={!canPlay}
            style={styles.pill}
          />
          <Button
            theme={theme}
            icon="shuffle"
            label="셔플"
            accessibilityLabel="섞어서 재생"
            onPress={() => void play(null, true)}
            disabled={!canPlay}
            style={styles.pill}
          />
        </View>
        {message ? (
          <Note theme={theme} tone="danger">
            {message}
          </Note>
        ) : null}
        <PlaylistLyricsBatchPanel
          batch={services.playlistBatch}
          theme={theme}
          playlistKey={open.persistentId}
          playlistName={open.name}
          tracks={refs}
          savedCount={savedNow ? savedNow.size : null}
        />
      </View>
    );
    return (
      <View style={[styles.flex, { backgroundColor: theme.bg }]}>
        <FlatList
          data={tracks ?? []}
          keyExtractor={(t, i) => `${t.persistentId}-${i}`}
          ListHeaderComponent={header}
          ListEmptyComponent={
            tracks === null ? (
              <ActivityIndicator style={{ marginTop: 24 }} />
            ) : (
              <View style={styles.pad}>
                <Note theme={theme}>곡이 없습니다.</Note>
              </View>
            )
          }
          renderItem={({ item, index }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.title}, ${item.artist}${savedNow?.has(index) ? ', 가사 저장됨' : ''}. 이 곡부터 재생`}
              onPress={() => void play(item.persistentId, false)}
              disabled={busy}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
            >
              <ArtworkTile seed={`${item.album ?? item.title}|${item.artist}`} size={48} />
              <View style={styles.itemText}>
                <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                  {item.title}
                </Text>
                <View style={styles.subRow}>
                  {savedNow?.has(index) ? <Icon name="check" size={14} color={theme.accent} strokeWidth={2.6} /> : null}
                  <Text style={{ color: theme.textDim, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
                    {item.artist}
                    {item.album ? ` · ${item.album}` : ''}
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
                {mmss(item.durationMs)}
              </Text>
            </Pressable>
          )}
        />
      </View>
    );
  }

  // ---------- 플레이리스트 목록
  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <View style={styles.pad}>
        <View style={styles.titleRow}>
          <Text style={[styles.h1, { color: theme.text }]}>플레이리스트</Text>
          <IconButton
            theme={theme}
            icon="refresh"
            label="새로고침"
            kind="soft"
            size={36}
            iconSize={18}
            onPress={() => void loadLists()}
          />
        </View>
        <View style={[styles.searchBox, { backgroundColor: theme.surface }]}>
          <Icon name="search" size={18} color={theme.textFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="플레이리스트 찾기"
            placeholderTextColor={theme.textFaint}
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.input, { color: theme.text }]}
          />
        </View>
        {message ? (
          <Note theme={theme} tone="danger">
            {message}
          </Note>
        ) : null}
        {lists && lists.length === 0 && !message ? (
          <Note theme={theme}>
            보관함에 플레이리스트가 없습니다. Apple Music에서 플레이리스트를 만들거나 &quot;보관함에 추가&quot;하면
            여기에 보입니다.
          </Note>
        ) : null}
      </View>
      {lists === null ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(p) => p.persistentId}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}${item.count != null ? `, ${item.count}곡` : ''}`}
              onPress={() => void openList(item)}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
            >
              <ArtworkTile seed={item.name} size={56} icon="playlist" />
              <View style={styles.itemText}>
                <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ color: theme.textDim, fontSize: 13 }}>
                  {item.count != null ? `${item.count}곡` : ''}
                  {item.smart ? ' · 자동 플레이리스트' : ''}
                </Text>
              </View>
              <Icon name="chevronRight" size={20} color={theme.textFaint} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  pad: { padding: 16 },
  h1: { fontSize: 30, fontWeight: '800' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  topBar: { flexDirection: 'row', marginLeft: -8 },
  hero: { alignItems: 'center', gap: 6, marginTop: 4 },
  heroTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  pill: { flex: 1, borderRadius: 999, minHeight: 46 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginTop: 10,
  },
  input: { flex: 1, height: 40, fontSize: 16 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  itemText: { flex: 1, minWidth: 0 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, marginLeft: 6 },
});
