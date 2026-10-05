import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CatalogTrack } from '@lyrics-companion/core';
import { NowPlaying, type LibraryItemRaw } from '../../modules/now-playing';
import type { AppServices } from '../services';
import { ArtworkTile, Chip, Note } from './common';
import { Icon } from './icons';
import type { Theme } from './theme';
import type { PlaybackApi } from './usePlayback';

type Source = 'catalog' | 'library';

interface Row {
  key: string;
  title: string;
  sub: string;
  /** 아트 타일 색을 정하는 값(앨범·가수) */
  seed: string;
  onPress: () => Promise<void>;
}

function mmss(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 곡 선택(REQ-PB-05). Apple Music 전용(docs/plan.md D-17).
 * - Apple Music: 우리 앱에서 고르면 Music 앱이 재생한다(Music 앱을 따로 열 필요 없음). 구독 필요.
 * - 내 보관함: 기기 보관함 곡을 재생한다.
 * 재생이 시작되면 지금 재생 탭이 곡을 자동 인식해 가사를 싱크한다.
 */
export function SearchScreen(props: {
  services: AppServices;
  playback: PlaybackApi;
  theme: Theme;
  onOpenNowPlaying: () => void;
}) {
  const { services, playback: pb, theme } = props;
  const hasMusic = NowPlaying !== null && services.playback !== null;
  const [source, setSource] = useState<Source>('catalog');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const playedInMusic = () => {
    void pb.refresh();
    props.onOpenNowPlaying();
  };

  const catalogRows = (tracks: CatalogTrack[]): Row[] =>
    tracks.map((t) => ({
      key: `c-${t.storeId}`,
      title: t.title,
      sub: `${t.artist}${t.album ? ` · ${t.album}` : ''}${mmss(t.durationMs)}`,
      seed: `${t.album ?? t.title}|${t.artist}`,
      onPress: async () => {
        if (!NowPlaying) return;
        try {
          await NowPlaying.playStoreId(t.storeId);
          playedInMusic();
        } catch {
          setMessage(
            '재생하지 못했습니다. Apple Music 구독 상태와, 이 곡이 한국 Apple Music에서 제공되는지 확인해 주세요.',
          );
        }
      },
    }));

  const libraryRows = (items: LibraryItemRaw[]): Row[] =>
    items.map((it) => ({
      key: `l-${it.persistentId}`,
      title: it.title,
      sub: `${it.artist}${it.album ? ` · ${it.album}` : ''}${mmss(it.durationSec * 1000)}`,
      seed: `${it.album ?? it.title}|${it.artist}`,
      onPress: async () => {
        if (!NowPlaying) return;
        try {
          await NowPlaying.playLibraryItem(it.persistentId);
          playedInMusic();
        } catch {
          setMessage('보관함 곡을 재생하지 못했습니다.');
        }
      },
    }));

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setBusy(true);
    setMessage(null);
    setRows([]);
    try {
      if (source === 'catalog') {
        const r = await services.catalog.search(q);
        if (r.status === 'ok') {
          setRows(catalogRows(r.tracks));
          if (r.tracks.length === 0) setMessage('검색 결과가 없습니다.');
        } else
          setMessage(r.kind === 'offline' ? '오프라인입니다.' : '검색에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      } else if (source === 'library') {
        const items = (await NowPlaying?.searchLibrary(q)) ?? [];
        setRows(libraryRows(items));
        if (items.length === 0) setMessage('보관함에서 찾지 못했습니다(제목으로 검색합니다).');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <View style={styles.pad}>
        {!hasMusic ? <Note theme={theme}>이 기기에서는 Music 앱을 제어할 수 없습니다(iPhone 전용).</Note> : null}
        <View style={styles.rowWrap}>
          <Chip theme={theme} label="Apple Music" on={source === 'catalog'} onPress={() => setSource('catalog')} />
          <Chip theme={theme} label="내 보관함" on={source === 'library'} onPress={() => setSource('library')} />
        </View>
        <Note theme={theme}>
          {source === 'catalog'
            ? '고른 곡을 Music 앱이 재생하고, 가사는 자동으로 맞춰집니다.'
            : '기기 보관함에 있는 곡을 제목으로 찾습니다.'}
        </Note>
        <View style={[styles.searchBox, { backgroundColor: theme.surface }]}>
          <Icon name="search" size={18} color={theme.textFaint} />
          <TextInput
            value={term}
            onChangeText={setTerm}
            onSubmitEditing={() => void search()}
            placeholder="곡 제목 또는 가수"
            placeholderTextColor={theme.textFaint}
            returnKeyType="search"
            autoCorrect={false}
            clearButtonMode="while-editing"
            editable={!busy}
            style={[styles.input, { color: theme.text }]}
          />
          {busy ? <Text style={{ color: theme.textFaint }}>…</Text> : null}
        </View>
        {message ? <Note theme={theme}>{message}</Note> : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.sub}. 재생`}
            onPress={() => void item.onPress()}
            style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
          >
            <ArtworkTile seed={item.seed} size={48} />
            <View style={styles.itemText}>
              <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={{ color: theme.textDim, fontSize: 13 }} numberOfLines={1}>
                {item.sub}
              </Text>
            </View>
            <Icon name="play" size={20} color={theme.accent} />
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: 16 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  input: { flex: 1, height: 42, fontSize: 16 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  itemText: { flex: 1, minWidth: 0 },
});
