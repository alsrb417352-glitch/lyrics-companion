import { useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  hasJapaneseScript,
  previewLrcImport,
  previewTxtImport,
  type ImportIssue,
  type LyricsVersion,
  type PronunciationVersion,
  type TranslationVersion,
} from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note } from './common';
import type { Theme } from './theme';

export type EditMode = 'translation' | 'pronunciation';

const ISSUE_TEXT: Record<ImportIssue['code'], string> = {
  TOO_LARGE: '붙여 넣은 내용이 너무 깁니다.',
  ENCODING_SUSPECT: '깨진 글자가 있습니다. UTF-8 텍스트인지 확인하세요.',
  EMPTY: '붙여 넣은 내용이 비어 있습니다.',
  LINE_COUNT_MISMATCH: '행 수가 원문과 달라 자동으로 맞추지 않았습니다. 아래 칸에 직접 넣어 주세요.',
  INVALID_LRC: 'LRC 형식이 올바르지 않습니다.',
  UNMATCHED_TIMESTAMP: '시간이 원문과 맞지 않는 행은 넣지 않았습니다.',
  ORIGINAL_NOT_SYNCED: '원문에 시간 정보가 없어 LRC 시간으로 맞출 수 없습니다. 시간 없이 행 순서대로 붙여 넣어 주세요.',
  LINE_TOO_LONG: '너무 긴 행이 있습니다(1000자 초과).',
};

const LRC_TAG = /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m;

/**
 * 사용자 번역·발음 편집(REQ-ED-01·02·03).
 * - 현재 화면에 보이는 번역(내 번역 또는 AI 번역)으로 칸을 채워 시작한다.
 *   저장하면 이 화면 내용 그대로 "내 번역"이 되어 AI 번역보다 우선한다(불변조건 2).
 * - 빈 칸은 번역 없이 표시된다. AI로 채우지 않는다(불변조건 3).
 * - 저장할 때마다 새 버전으로 추가되고 이전 버전은 보존된다. 이 화면은 AI를 호출하지 않는다.
 * - 붙여넣기(TXT/LRC)는 행 수·시간이 정확히 맞을 때만 칸을 채우고, 저장은 사용자가 확인한 뒤에만 한다.
 */
export function EditScreen(props: {
  services: AppServices;
  theme: Theme;
  mode: EditMode;
  lyrics: LyricsVersion;
  translation: TranslationVersion | null;
  pronunciation: PronunciationVersion | null;
  onDone: () => void;
}) {
  const { services, theme, mode, lyrics } = props;
  const rows = useMemo(
    () => lyrics.lines.filter((l) => l.text.trim() !== '' && (mode === 'translation' || hasJapaneseScript(l.text))),
    [lyrics, mode],
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const l of rows) {
      init[l.id] =
        mode === 'translation'
          ? (props.translation?.lines[l.id] ?? '')
          : (props.pronunciation?.lines[l.id]?.hangul ?? '');
    }
    return init;
  });
  const [dirty, setDirty] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const filled = rows.filter((l) => (values[l.id] ?? '').trim() !== '').length;
  const baseLabel =
    mode === 'translation'
      ? props.translation
        ? props.translation.origin === 'user'
          ? '내 번역'
          : 'AI 번역'
        : null
      : props.pronunciation
        ? props.pronunciation.origin === 'user'
          ? '내 발음'
          : 'AI 발음'
        : null;

  const setOne = (id: string, v: string) => {
    setValues((prev) => ({ ...prev, [id]: v }));
    setDirty(true);
  };

  const applyPaste = () => {
    const isLrc = LRC_TAG.test(pasteText);
    const preview = isLrc ? previewLrcImport(lyrics, pasteText) : previewTxtImport(lyrics, pasteText);
    const notes = preview.issues.map((i) => ISSUE_TEXT[i.code] + (i.detail ? ` (${i.detail})` : ''));
    if (preview.proposed) {
      setValues((prev) => ({ ...prev, ...preview.proposed }));
      setDirty(true);
      setPasting(false);
      setPasteText('');
      const n = Object.keys(preview.proposed).length;
      setMsg({
        text: [`${n}행을 칸에 채웠습니다. 확인한 뒤 저장을 누르세요.`, ...notes].join(' '),
        danger: preview.requiresManualMapping,
      });
    } else {
      setMsg({ text: notes.join(' ') || '채울 수 있는 행이 없습니다.', danger: true });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const mapping: Record<string, string> = {};
      for (const l of rows) mapping[l.id] = values[l.id] ?? '';
      const r =
        mode === 'translation'
          ? await services.session.saveUserTranslation(mapping)
          : await services.session.saveUserPronunciation(mapping);
      if (r.ok) props.onDone();
      else setMsg({ text: r.error ?? '저장하지 못했습니다', danger: true });
    } finally {
      setSaving(false);
    }
  };

  const input = [styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }];

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]}>
          {mode === 'translation' ? '번역 편집' : '발음(한글 독음) 편집'}
        </Text>
        <Note theme={theme}>
          {baseLabel ? `${baseLabel}으로 채워 시작했습니다. ` : ''}
          저장하면 이 내용이 {mode === 'translation' ? '"내 번역"' : '"내 발음"'}이 되어 AI 결과보다 먼저 보입니다. 빈
          칸은 비워 둔 채 표시되고 AI로 채우지 않습니다. 이전 버전은 지워지지 않습니다. ({filled}/{rows.length}행 입력)
        </Note>
        {msg ? (
          <Note theme={theme} tone={msg.danger ? 'danger' : 'dim'}>
            {msg.text}
          </Note>
        ) : null}
        {mode === 'translation' ? (
          pasting ? (
            <View>
              <TextInput
                value={pasteText}
                onChangeText={setPasteText}
                multiline
                placeholder="번역 전체를 붙여 넣으세요(한 행에 한 줄, 또는 LRC)"
                placeholderTextColor={theme.textFaint}
                style={[input, styles.paste]}
                autoCorrect={false}
              />
              <View style={styles.rowGap}>
                <Button theme={theme} kind="primary" label="칸에 채우기" onPress={applyPaste} disabled={!pasteText} />
                <Button theme={theme} label="닫기" onPress={() => setPasting(false)} />
              </View>
            </View>
          ) : (
            <Button theme={theme} label="붙여넣기로 채우기(TXT·LRC)" onPress={() => setPasting(true)} />
          )
        ) : null}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(l) => l.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Note theme={theme}>{mode === 'pronunciation' ? '일본어 행이 없습니다.' : '편집할 가사 행이 없습니다.'}</Note>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={{ color: theme.textDim, fontSize: 15, marginBottom: 4 }}>{item.text}</Text>
            <TextInput
              value={values[item.id] ?? ''}
              onChangeText={(v) => setOne(item.id, v)}
              placeholder={mode === 'translation' ? '번역' : '한글 발음'}
              placeholderTextColor={theme.textFaint}
              accessibilityLabel={`${item.text} ${mode === 'translation' ? '번역' : '발음'}`}
              style={input}
              multiline
            />
          </View>
        )}
      />

      <View style={[styles.footer, { borderColor: theme.border }]}>
        <Button theme={theme} label="취소" onPress={props.onDone} disabled={saving} />
        <Button
          theme={theme}
          kind="primary"
          label={saving ? '저장 중…' : '저장'}
          onPress={() => void save()}
          disabled={saving || !dirty || filled === 0}
          style={styles.flex}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 20, fontWeight: '700' },
  list: { padding: 16, paddingBottom: 40 },
  row: { marginBottom: 14 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 40,
    fontSize: 16,
  },
  paste: { height: 140, textAlignVertical: 'top', marginTop: 6 },
  rowGap: { flexDirection: 'row', gap: 8, marginTop: 8 },
  footer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
