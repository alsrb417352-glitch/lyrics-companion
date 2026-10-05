import { useState } from 'react';
import { FlatList, Modal, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  applyTranslationBundle,
  BUNDLE_LIMITS,
  buildTranslationBundle,
  parseTranslationBundle,
  previewTranslationBundle,
  summarizeBundle,
  translationBundleFileName,
  type BundleExportCounts,
  type BundleItem,
  type BundlePreview,
  type ServiceTrackRef,
} from '@lyrics-companion/core';
import { pickTextFile, shareTextFile } from '../adapters/text-export';
import type { AppServices } from '../services';
import { Button, Note } from './common';
import { Icon } from './icons';
import type { Theme } from './theme';

function itemLabel(it: BundleItem): string {
  switch (it.status) {
    case 'ready':
      return it.replacesAi ? `저장 · ${it.translatedLines}줄 (AI 번역 대신 표시)` : `저장 · ${it.translatedLines}줄`;
    case 'empty':
      return '번역이 비어 있음 — 건너뜀';
    case 'has-user-translation':
      return '이미 내 번역이 있음 — 건너뜀';
    case 'line-count-mismatch':
      return `줄 수가 다름(원문 ${it.originalLines} / 번역 ${it.translatedLines}) — 건너뜀`;
    case 'same-as-original':
      return '번역 칸이 원문과 같음 — 건너뜀';
    case 'invalid':
      return '깨진 글자나 너무 긴 줄이 있음 — 건너뜀';
    case 'unknown-lyrics':
      return '이 기기에 없는 곡 — 건너뜀';
    case 'lyrics-changed':
      return '내보낸 뒤 가사가 바뀜 — 다시 내보내 주세요';
    case 'duplicate':
      return '파일에 같은 곡이 또 있음 — 건너뜀';
  }
}

function skippedNote(c: BundleExportCounts): string {
  const parts: string[] = [];
  if (c.hasUserTranslation) parts.push(`이미 내 번역 있음 ${c.hasUserTranslation}곡`);
  if (c.noLyrics) parts.push(`가사 원문 없음 ${c.noLyrics}곡`);
  if (c.nothingToTranslate) parts.push(`연주곡 등 ${c.nothingToTranslate}곡`);
  if (c.korean) parts.push(`한국어 가사 ${c.korean}곡`);
  if (c.duplicate) parts.push(`중복 ${c.duplicate}곡`);
  return parts.length ? `빠진 곡: ${parts.join(' · ')}.` : '';
}

/**
 * 플레이리스트 번역 묶음 내보내기·가져오기(REQ-ED-05, docs/plan.md D-34).
 * 판단(곡 고르기·파싱·행 맞추기·건너뛰기)은 core translation-bundle이 하고, 이 화면은 파일 입출력·확인만 한다.
 * AI를 부르지 않는다. 미리보기에서 사용자가 "저장"을 눌러야 저장된다.
 */
export function TranslationBundlePanel(props: {
  services: AppServices;
  theme: Theme;
  playlistName: string;
  /** 곡 목록(null이면 아직 읽는 중) */
  tracks: readonly ServiceTrackRef[] | null;
  /** 저장 뒤 목록 표시를 다시 읽게 한다 */
  onSaved?: () => void;
}) {
  const { services, theme, tracks } = props;
  const [busy, setBusy] = useState<null | 'export' | 'import' | 'apply'>(null);
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);

  const exportBundle = async () => {
    if (!tracks || busy) return;
    setBusy('export');
    setMsg(null);
    try {
      const out = await buildTranslationBundle(services.store, { label: props.playlistName, tracks });
      const skipped = skippedNote(out.counts);
      if (out.counts.included === 0) {
        setMsg({
          text: `번역할 곡이 없습니다. ${skipped}${out.counts.noLyrics ? ' 먼저 위의 "가사 원문 일괄 받기"를 해 주세요.' : ''}`,
        });
        return;
      }
      await shareTextFile({
        text: out.text,
        fileName: translationBundleFileName(props.playlistName),
        dialogTitle: '번역 묶음 내보내기',
      });
      setMsg({
        text: `${out.counts.included}곡을 한 파일로 내보냈습니다. 각 곡의 [번역] 아래에 번역을 채운 뒤 "번역 묶음 가져오기"를 누르세요. ${skipped}`,
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : '내보내지 못했습니다', danger: true });
    } finally {
      setBusy(null);
    }
  };

  const loadText = async (text: string) => {
    const parsed = parseTranslationBundle(text);
    if (!parsed.ok) {
      setMsg({ text: parsed.error, danger: true });
      return;
    }
    setPreview(await previewTranslationBundle(services.store, parsed.sections));
    setPasting(false);
    setPasteText('');
  };

  const importFile = async () => {
    if (busy) return;
    setBusy('import');
    setMsg(null);
    try {
      const picked = await pickTextFile(BUNDLE_LIMITS.maxChars);
      if (picked.canceled) return;
      if ('error' in picked) {
        setMsg({ text: picked.error, danger: true });
        return;
      }
      await loadText(picked.text);
    } catch {
      setMsg({ text: '파일을 읽지 못했습니다. UTF-8 텍스트(.txt) 파일인지 확인해 주세요.', danger: true });
    } finally {
      setBusy(null);
    }
  };

  const importPasted = async () => {
    if (busy || pasteText.trim() === '') return;
    setBusy('import');
    setMsg(null);
    try {
      await loadText(pasteText);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview || busy) return;
    setBusy('apply');
    try {
      const r = await applyTranslationBundle(
        { store: services.store, clock: services.clock, ids: services.ids, logger: services.logger },
        preview,
      );
      // 지금 재생 중인 곡에 저장했으면 화면을 저장소 기준으로 다시 연다(AI 호출 없음, 불변조건 1).
      const currentId = services.session.current.song?.id;
      if (currentId && r.savedSongIds.includes(currentId)) await services.session.reloadCurrent();
      const extra = [
        r.skippedNow ? `그 사이 내 번역이 생기거나 가사가 바뀐 ${r.skippedNow}곡은 건너뜀.` : '',
        r.failed ? `${r.failed}곡은 저장하지 못했습니다.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      setMsg({ text: `${r.saved}곡에 "내 번역"을 저장했습니다. ${extra}`, danger: r.failed > 0 });
      setPreview(null);
      props.onSaved?.();
    } catch {
      setMsg({ text: '저장하지 못했습니다. 이미 저장한 곡은 그대로 남아 있습니다.', danger: true });
    } finally {
      setBusy(null);
    }
  };

  const ready = preview?.counts.ready ?? 0;

  return (
    <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <View style={styles.head}>
        <Icon name="edit" size={20} color={theme.accent} />
        <Text style={[styles.title, { color: theme.text }]}>번역 한꺼번에 넣기</Text>
      </View>
      <Note theme={theme}>
        ① 번역할 곡(가사 원문이 있고 내 번역이 없는 곡)을 한 파일로 내보내고 ② 각 곡의 [번역] 아래에 번역을 채운 뒤 ③
        가져오면 여러 곡에 &quot;내 번역&quot;이 한 번에 저장됩니다. 줄 수가 원문과 같은 곡만 저장하고, 이미 내 번역이
        있는 곡은 건너뜁니다.
      </Note>
      {msg ? (
        <Note theme={theme} tone={msg.danger ? 'danger' : 'dim'}>
          {msg.text}
        </Note>
      ) : null}
      <Button
        theme={theme}
        icon="share"
        label={busy === 'export' ? '만드는 중…' : '번역할 곡 내보내기'}
        onPress={() => void exportBundle()}
        disabled={!tracks || tracks.length === 0 || busy !== null}
      />
      <Button
        theme={theme}
        kind="primary"
        icon="download"
        label={busy === 'import' ? '읽는 중…' : '번역 묶음 가져오기(파일)'}
        onPress={() => void importFile()}
        disabled={busy !== null}
      />
      {pasting ? (
        <View>
          <TextInput
            value={pasteText}
            onChangeText={setPasteText}
            multiline
            placeholder="번역을 채운 묶음 내용을 통째로 붙여 넣으세요"
            placeholderTextColor={theme.textFaint}
            autoCorrect={false}
            style={[styles.paste, { color: theme.text, backgroundColor: theme.bg, borderColor: theme.border }]}
          />
          <View style={styles.row}>
            <Button theme={theme} label="닫기" onPress={() => setPasting(false)} />
            <Button
              theme={theme}
              kind="primary"
              label="미리보기"
              onPress={() => void importPasted()}
              disabled={busy !== null || pasteText.trim() === ''}
              style={styles.grow}
            />
          </View>
        </View>
      ) : (
        <Button theme={theme} label="붙여넣기로 가져오기" onPress={() => setPasting(true)} disabled={busy !== null} />
      )}

      <Modal
        visible={preview !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPreview(null)}
      >
        <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>번역 가져오기 확인</Text>
          {preview ? <Note theme={theme}>{summarizeBundle(preview)}</Note> : null}
          <Note theme={theme}>
            &quot;저장&quot;을 누르면 아래 저장 표시된 곡마다 새 &quot;내 번역&quot;이 추가되어 AI 번역보다 먼저
            보입니다. 기존 번역은 지워지지 않습니다. 건너뛴 곡은 그 곡의 번역 편집에서 따로 고칠 수 있습니다.
          </Note>
          <FlatList
            style={styles.grow}
            data={preview?.items ?? []}
            keyExtractor={(it) => `${it.index}`}
            renderItem={({ item }) => (
              <View style={[styles.item, { borderColor: theme.border }]}>
                <Icon
                  name={item.status === 'ready' ? 'check' : 'close'}
                  size={16}
                  color={item.status === 'ready' ? theme.accent : theme.textFaint}
                />
                <View style={styles.grow}>
                  <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                    {item.title || '제목 없음'}
                    {item.artist ? ` — ${item.artist}` : ''}
                  </Text>
                  <Text style={{ color: item.status === 'ready' ? theme.textDim : theme.textFaint, fontSize: 13 }}>
                    {itemLabel(item)}
                  </Text>
                </View>
              </View>
            )}
          />
          <View style={styles.row}>
            <Button theme={theme} label="취소" onPress={() => setPreview(null)} disabled={busy === 'apply'} />
            <Button
              theme={theme}
              kind="primary"
              label={busy === 'apply' ? '저장 중…' : ready > 0 ? `${ready}곡 저장` : '저장할 곡 없음'}
              onPress={() => void apply()}
              disabled={busy === 'apply' || ready === 0}
              style={styles.grow}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  grow: { flex: 1 },
  paste: {
    height: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    textAlignVertical: 'top',
    marginTop: 6,
  },
  sheet: { flex: 1, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 20, fontWeight: '800', marginTop: 8 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
