import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  filterPlaylists,
  mapLibraryPlaylists,
  mapLibraryTracks,
  type LibraryPlaylist,
  type LibraryTrack,
} from '@lyrics-companion/core';
import { NowPlaying } from '../../modules/now-playing';
import type { AppServices } from '../services';
import { Button, Note } from './common';
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
    return (
      <View style={[styles.flex, { backgroundColor: theme.bg }]}>
        <View style={[styles.pad, { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border }]}>
          <Pressable accessibilityRole="button" onPress={() => setOpen(null)} hitSlop={12}>
            <Text style={{ color: theme.accent, fontSize: 16, fontWeight: '600' }}>‹ 플레이리스트</Text>
          </Pressable>
          <Text style={[styles.h1, { color: theme.text }]} numberOfLines={2}>
            {open.name}
          </Text>
          {tracks ? <Note theme={theme}>{tracks.length}곡</Note> : null}
          <View style={styles.row}>
            <Button
              theme={theme}
              kind="primary"
              label={busy ? '…' : '▶ 재생'}
              accessibilityLabel="처음부터 재생"
              onPress={() => void play(null, false)}
              disabled={busy || !tracks || tracks.length === 0}
              style={styles.grow}
            />
            <Button
              theme={theme}
              label="셔플"
              accessibilityLabel="섞어서 재생"
              onPress={() => void play(null, true)}
              disabled={busy || !tracks || tracks.length === 0}
              style={styles.grow}
            />
          </View>
          {message ? (
            <Note theme={theme} tone="danger">
              {message}
            </Note>
          ) : null}
        </View>
        {tracks === null ? (
          <ActivityIndicator style={{ marginTop: 24 }} />
        ) : (
          <FlatList
            data={tracks}
            keyExtractor={(t, i) => `${t.persistentId}-${i}`}
            ListEmptyComponent={
              <View style={styles.pad}>
                <Note theme={theme}>곡이 없습니다.</Note>
              </View>
            }
            renderItem={({ item, index }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title}, ${item.artist}. 이 곡부터 재생`}
                onPress={() => void play(item.persistentId, false)}
                disabled={busy}
                style={({ pressed }) => [styles.item, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={{ color: theme.textFaint, width: 32, fontSize: 14 }}>{index + 1}</Text>
                <View style={styles.flex}>
                  <Text style={{ color: theme.text, fontSize: 17, fontWeight: '600' }} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.textDim, fontSize: 14 }} numberOfLines={1}>
                    {item.artist}
                    {item.album ? ` · ${item.album}` : ''}
                  </Text>
                </View>
                <Text style={{ color: theme.textFaint, fontSize: 14, marginLeft: 8 }}>{mmss(item.durationMs)}</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    );
  }

  // ---------- 플레이리스트 목록
  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <View style={styles.pad}>
        <Text style={[styles.h1, { color: theme.text }]}>플레이리스트</Text>
        <Note theme={theme}>
          보관함에 있는 플레이리스트입니다. 고르고 재생을 누르면 Music 앱을 열지 않아도 바로 재생되고, 가사가 자동으로
          맞춰집니다.
        </Note>
        <View style={styles.row}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="플레이리스트 이름"
            placeholderTextColor={theme.textFaint}
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
          />
          <Button theme={theme} label="새로고침" onPress={() => void loadLists()} />
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
              style={({ pressed }) => [styles.item, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}
            >
              <View style={styles.flex}>
                <Text style={{ color: theme.text, fontSize: 17, fontWeight: '600' }} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={{ color: theme.textDim, fontSize: 14 }}>
                  {item.count != null ? `${item.count}곡` : ''}
                  {item.smart ? ' · 자동 플레이리스트' : ''}
                </Text>
              </View>
              <Text style={{ color: theme.textFaint, fontSize: 20 }}>›</Text>
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
  h1: { fontSize: 24, fontWeight: '800', marginTop: 6, marginBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 16,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
