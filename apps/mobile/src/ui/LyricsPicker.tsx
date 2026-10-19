import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  rankLyricsRecords,
  summarizeLyricsCandidate,
  type LrclibRecord,
  type RankedLyricsRecord,
} from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note } from './common';
import { ManualLyricsEntry } from './ManualLyricsEntry';
import type { Theme } from './theme';

function mmss(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 가사 고르기: 자동 조회가 확정하지 못한 후보 + LRCLIB 직접 검색.
 * 사용자가 고른 레코드만 현재 곡에 적용한다(같은 녹음인지 사용자가 확인, 불변조건 6).
 * 목록은 자동 조회와 같은 순위(곡 일치 → 싱크 → 원문 → 한국어 뜻 → 한글 발음, D-43)로 정렬하고
 * 레코드마다 무엇이 있는지와 곡이 다를 수 있다는 경고(길이 ±2초 초과·제목/버전 다름·가수 표기 다름)를 보여 준다.
 * 검색으로도 못 찾으면 "가사 직접 등록"(TXT/LRC 파일·붙여넣기, D-40)으로 넘어간다.
 */
export function LyricsPicker(props: {
  services: AppServices;
  theme: Theme;
  initialQuery: string;
  /** 지금 곡(순위·경고 계산용) */
  song: { title: string; artist: string; album: string | null };
  durationMs: number | null;
  candidates: LrclibRecord[];
  /** 지금 표시 중인 가사가 있는지(직접 등록 화면 안내용) */
  hasCurrentLyrics: boolean;
  /** 처음부터 직접 등록 화면으로 열기 */
  startManual?: boolean;
  onDone: () => void;
}) {
  const { services, theme } = props;
  const [manual, setManual] = useState(props.startManual ?? false);
  const [term, setTerm] = useState(props.initialQuery);
  const [records, setRecords] = useState<LrclibRecord[]>(props.candidates);
  const { title, artist, album } = props.song;
  const rows = useMemo<RankedLyricsRecord[]>(
    () => rankLyricsRecords(records, { variants: [{ title, artist, album }], durationMs: props.durationMs }),
    [records, title, artist, album, props.durationMs],
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(
    props.candidates.length > 0 ? '자동으로 확정하지 못한 후보입니다. 지금 듣는 곡과 같은 가사를 골라 주세요.' : null,
  );

  const search = async () => {
    const q = term.trim();
    if (!q) return;
    setBusy(true);
    setMsg(null);
    const r = await services.lrclib.search({ q });
    setBusy(false);
    if (r.status === 'ok') {
      setRecords(r.records);
      if (r.records.length === 0)
        setMsg(
          '찾지 못했습니다. 제목만, 또는 일본어 원제로 검색해 보세요. 그래도 없으면 아래 "가사 직접 등록"으로 넣을 수 있습니다.',
        );
    } else if (r.status === 'rate_limited') setMsg('가사 서버 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.');
    else setMsg(r.kind === 'offline' ? '오프라인입니다.' : '가사 검색에 실패했습니다.');
  };

  const choose = async (r: LrclibRecord) => {
    const res = await services.session.chooseLyricsRecord(r);
    if (res.ok) props.onDone();
    else setMsg(res.error ?? '적용하지 못했습니다');
  };

  if (manual) {
    return (
      <ManualLyricsEntry
        services={services}
        theme={theme}
        durationMs={props.durationMs}
        hasCurrentLyrics={props.hasCurrentLyrics}
        onBack={() => (props.startManual ? props.onDone() : setManual(false))}
        onSaved={props.onDone}
      />
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <View style={styles.pad}>
        <View style={styles.searchRow}>
          <TextInput
            value={term}
            onChangeText={setTerm}
            onSubmitEditing={() => void search()}
            placeholder="곡 제목 또는 가수"
            placeholderTextColor={theme.textFaint}
            returnKeyType="search"
            autoCorrect={false}
            style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
          />
          <Button
            theme={theme}
            kind="primary"
            label={busy ? '…' : '검색'}
            onPress={() => void search()}
            disabled={busy}
          />
          <Button theme={theme} label="닫기" onPress={props.onDone} />
        </View>
        {msg ? <Note theme={theme}>{msg}</Note> : null}
        <Button
          theme={theme}
          icon="edit"
          label="가사 직접 등록 (파일·붙여넣기)"
          onPress={() => setManual(true)}
          style={{ marginTop: 8 }}
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.record.id)}
        renderItem={({ item }) => {
          const rec = item.record;
          const sum = summarizeLyricsCandidate(item, props.durationMs);
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => void choose(rec)}
              style={({ pressed }) => [styles.item, { borderColor: theme.border, opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={{ color: theme.text, fontSize: 17, fontWeight: '600' }} numberOfLines={1}>
                {rec.trackName}
              </Text>
              <Text style={{ color: theme.textDim, fontSize: 14 }} numberOfLines={1}>
                {rec.artistName}
                {rec.albumName ? ` · ${rec.albumName}` : ''} · {mmss(rec.duration)}
              </Text>
              <Text style={{ color: theme.textDim, fontSize: 13 }} numberOfLines={1}>
                {sum.features}
              </Text>
              {sum.warning ? <Text style={{ color: theme.danger, fontSize: 13 }}>{sum.warning}</Text> : null}
              <Text style={{ color: theme.textFaint, fontSize: 14 }} numberOfLines={1}>
                {sum.preview}
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
  pad: { padding: 16 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 16,
  },
  item: { paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
