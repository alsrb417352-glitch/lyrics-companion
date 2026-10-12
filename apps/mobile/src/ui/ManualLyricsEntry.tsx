import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  describeUserLyricsError,
  describeUserLyricsWarning,
  parseUserLyrics,
  USER_LYRICS_LIMITS,
  type UserLyricsFormat,
} from '@lyrics-companion/core';
import { pickTextFile } from '../adapters/text-export';
import type { AppServices } from '../services';
import { Button, Chip, Note } from './common';
import type { Theme } from './theme';

const PREVIEW_LINES = 6;

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 가사 직접 등록(D-40): LRCLIB에서 찾지 못한 곡에 TXT/LRC 파일을 불러오거나 가사를 붙여 넣어 원문으로 저장한다.
 * - 입력은 불신 데이터: 해석·검증은 core(parseUserLyrics)가 한다. 미리보기를 보고 사용자가 "저장"을 눌러야 저장한다.
 * - [mm:ss.xx] 시간 표시가 있으면 싱크 가사, 없으면 시간 정보 없는 가사(시간을 만들어 내지 않음, 불변조건 5).
 * - 기존 판본·번역은 지우지 않는다(REQ-LY-04).
 */
export function ManualLyricsEntry(props: {
  services: AppServices;
  theme: Theme;
  durationMs: number | null;
  /** 지금 표시 중인 가사가 있는지(바꾸기 안내용) */
  hasCurrentLyrics: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { services, theme } = props;
  const [text, setText] = useState('');
  const [origin, setOrigin] = useState<'typed' | 'file'>('typed');
  const [fileName, setFileName] = useState<string | null>(null);
  const [format, setFormat] = useState<UserLyricsFormat>('auto');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);

  const parsed = useMemo(
    () => (text.trim() === '' ? null : parseUserLyrics(text, { format, durationMs: props.durationMs })),
    [text, format, props.durationMs],
  );

  const pickFile = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const picked = await pickTextFile(USER_LYRICS_LIMITS.maxChars, { allowAnyType: true });
      if (picked.canceled) return;
      if ('error' in picked) {
        setMsg({ text: picked.error, danger: true });
        return;
      }
      setText(picked.text);
      setOrigin('file');
      setFileName(picked.name);
      setFormat('auto');
    } catch {
      setMsg({ text: '파일을 읽지 못했습니다. UTF-8 텍스트(.txt·.lrc) 파일인지 확인해 주세요.', danger: true });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!parsed?.ok || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await services.session.saveUserLyrics(parsed, origin);
      if (!r.ok) setMsg({ text: r.error, danger: true });
      else props.onSaved();
    } catch {
      setMsg({ text: '저장하지 못했습니다.', danger: true });
    } finally {
      setBusy(false);
    }
  };

  const previewRows =
    parsed?.ok === true
      ? parsed.kind === 'synced'
        ? parsed.timed.filter((t) => t.text !== '').map((t) => `${mmss(t.startMs)}  ${t.text}`)
        : parsed.plain.filter((l) => l !== '')
      : [];

  return (
    <ScrollView style={[styles.flex, { backgroundColor: theme.bg }]} contentContainerStyle={styles.pad}>
      <View style={styles.headRow}>
        <Text style={[styles.title, { color: theme.text }]}>가사 직접 등록</Text>
        <Button theme={theme} label="뒤로" onPress={props.onBack} />
      </View>
      <Note theme={theme}>
        가사 파일(.txt·.lrc)을 불러오거나 아래 칸에 붙여 넣으세요. 줄 앞에 [00:12.34] 같은 시간이 있으면 자동 싱크로,
        없으면 시간 정보 없는 가사로 저장합니다. 이 기기에만 저장됩니다.
      </Note>
      {props.hasCurrentLyrics ? (
        <Note theme={theme}>
          지금 가사는 지우지 않고 보관합니다. 새 가사에는 아직 번역이 없습니다(자동 번역 설정을 따릅니다).
        </Note>
      ) : null}

      <View style={styles.row}>
        <Button
          theme={theme}
          icon="download"
          label={busy ? '…' : '파일 불러오기'}
          onPress={() => void pickFile()}
          disabled={busy}
        />
        {text !== '' ? (
          <Button
            theme={theme}
            label="지우기"
            onPress={() => {
              setText('');
              setFileName(null);
              setOrigin('typed');
              setFormat('auto');
              setMsg(null);
            }}
          />
        ) : null}
      </View>
      {fileName ? <Note theme={theme}>불러온 파일: {fileName}</Note> : null}

      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder={'가사를 붙여 넣으세요\n예) [00:12.34]첫 줄\n    또는 시간 없이 한 줄에 한 행'}
        placeholderTextColor={theme.textFaint}
        autoCorrect={false}
        autoCapitalize="none"
        textAlignVertical="top"
        accessibilityLabel="가사 입력"
        style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
      />

      {parsed && !parsed.ok ? (
        <>
          <Note theme={theme} tone="danger">
            {describeUserLyricsError(parsed.error)}
          </Note>
          {parsed.error.code === 'INVALID_LRC' && parsed.error.canUseAsPlain ? (
            <Button theme={theme} label="시간 정보 없이 저장하기" onPress={() => setFormat('plain')} />
          ) : null}
        </>
      ) : null}

      {parsed?.ok ? (
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }}>
            {parsed.kind === 'synced' ? '싱크 가사' : '시간 정보 없는 가사'} · {parsed.lineCount}줄
          </Text>
          {parsed.warnings.map((w) => (
            <Note key={w} theme={theme} tone={w === 'beyond-duration' || w === 'replacement-chars' ? 'danger' : 'dim'}>
              {describeUserLyricsWarning(w)}
            </Note>
          ))}
          {format === 'plain' ? (
            <View style={styles.row}>
              <Chip theme={theme} label="시간 표시 쓰기" on={false} onPress={() => setFormat('auto')} />
            </View>
          ) : null}
          {previewRows.slice(0, PREVIEW_LINES).map((line, i) => (
            <Text key={i} style={{ color: theme.textDim, fontSize: 14 }} numberOfLines={1}>
              {line}
            </Text>
          ))}
          {previewRows.length > PREVIEW_LINES ? (
            <Text style={{ color: theme.textFaint, fontSize: 13 }}>… 외 {previewRows.length - PREVIEW_LINES}줄</Text>
          ) : null}
          <Button
            theme={theme}
            kind="primary"
            label={busy ? '저장 중…' : '이 곡 가사로 저장'}
            onPress={() => void save()}
            disabled={busy}
            style={{ marginTop: 10 }}
          />
        </View>
      ) : null}

      {msg ? (
        <Note theme={theme} tone={msg.danger ? 'danger' : 'dim'}>
          {msg.text}
        </Note>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: 16, gap: 10 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: {
    minHeight: 220,
    maxHeight: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
  },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 4 },
});
