import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { PROVIDER_PRESETS, validateProviderConfig } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Chip, Note } from './common';
import type { Theme } from './theme';

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * 설정: AI 제공자·API 키(REQ-TR-01, REQ-SEC-01/03), 자동 번역 동의(REQ-TR-13, REQ-SEC-05).
 * API 키는 iOS Keychain에만 저장하고 화면에는 끝 4자리만 보인다. 입력칸은 저장 후 비운다.
 */
export function SettingsScreen(props: { services: AppServices; theme: Theme }) {
  const { services, theme } = props;
  const { store, keys } = services;
  const [providerId, setProviderId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [structured, setStructured] = useState(true);
  const [keyInput, setKeyInput] = useState('');
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [usage, setUsage] = useState<{ requests: number; sourceChars: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);

  const reload = useCallback(async () => {
    const cfg = await store.getProviderConfig();
    if (cfg) {
      setProviderId(cfg.providerId);
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setStructured(cfg.structuredOutput);
      setKeyHint(await keys.hint(cfg.providerId));
    }
    setAuto((await store.getTranslationSettings()).autoTranslate);
    setUsage(await store.getUsage(utcDay(services.clock.nowEpochMs())));
  }, [store, keys, services.clock]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveConfig = async () => {
    const r = validateProviderConfig({ providerId, baseUrl, model, structuredOutput: structured });
    if (!r.ok) {
      setMsg({ text: r.error, danger: true });
      return;
    }
    await store.setProviderConfig(r.config);
    setKeyHint(await keys.hint(r.config.providerId));
    setMsg({ text: '제공자 설정을 저장했습니다. 저장된 번역은 그대로 유지됩니다.' });
  };

  const saveKey = async () => {
    const r = validateProviderConfig({ providerId, baseUrl, model, structuredOutput: structured });
    if (!r.ok) {
      setMsg({ text: '먼저 제공자 설정을 올바르게 입력해 주세요.', danger: true });
      return;
    }
    try {
      await keys.set(r.config.providerId, keyInput);
      setKeyInput('');
      setKeyHint(await keys.hint(r.config.providerId));
      setMsg({ text: 'API 키를 기기 보안 저장소(Keychain)에 저장했습니다.' });
    } catch (e) {
      setKeyInput('');
      setMsg({ text: e instanceof Error ? e.message : '키를 저장하지 못했습니다', danger: true });
    }
  };

  const deleteKey = async () => {
    if (!providerId) return;
    await keys.delete(providerId);
    setKeyHint(null);
    setMsg({ text: 'API 키를 삭제했습니다.' });
  };

  const toggleAuto = async (on: boolean) => {
    await store.setTranslationSettings({ autoTranslate: on });
    setAuto(on);
  };

  const input = [styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }];

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.pad}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.h2, { color: theme.text }]}>AI 번역 제공자</Text>
      <Note theme={theme}>
        OpenAI 호환 방식(Chat Completions)을 지원하는 제공자를 등록합니다. 모델 이름은 제공자 문서를 확인해 입력하세요.
      </Note>
      <View style={styles.rowWrap}>
        {PROVIDER_PRESETS.map((p) => (
          <Chip
            key={p.providerId}
            theme={theme}
            label={p.label}
            on={providerId === p.providerId}
            onPress={() => {
              setProviderId(p.providerId);
              setBaseUrl(p.baseUrl);
            }}
          />
        ))}
      </View>
      <Text style={[styles.label, { color: theme.textDim }]}>제공자 ID</Text>
      <TextInput
        value={providerId}
        onChangeText={setProviderId}
        autoCapitalize="none"
        autoCorrect={false}
        style={input}
      />
      <Text style={[styles.label, { color: theme.textDim }]}>API 주소(https)</Text>
      <TextInput
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={input}
      />
      <Text style={[styles.label, { color: theme.textDim }]}>모델 이름</Text>
      <TextInput value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} style={input} />
      <View style={styles.switchRow}>
        <Text style={{ color: theme.text, flex: 1 }}>구조화 출력(json_schema) 사용</Text>
        <Switch value={structured} onValueChange={setStructured} />
      </View>
      <Button theme={theme} kind="primary" label="제공자 설정 저장" onPress={() => void saveConfig()} />

      <Text style={[styles.h2, { color: theme.text, marginTop: 24 }]}>API 키</Text>
      <Note theme={theme}>
        키는 이 기기의 보안 저장소에만 저장되고, 설정 파일·로그·내보내기에 들어가지 않습니다. 현재:{' '}
        {keyHint ?? '등록 안 됨'}
      </Note>
      <TextInput
        value={keyInput}
        onChangeText={setKeyInput}
        placeholder="키 붙여넣기"
        placeholderTextColor={theme.textFaint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="none"
        style={input}
      />
      <View style={styles.rowGap}>
        <Button theme={theme} kind="primary" label="키 저장" onPress={() => void saveKey()} disabled={!keyInput} />
        <Button theme={theme} kind="danger" label="키 삭제" onPress={() => void deleteKey()} disabled={!keyHint} />
      </View>

      <Text style={[styles.h2, { color: theme.text, marginTop: 24 }]}>자동 번역</Text>
      <View style={styles.switchRow}>
        <Text style={{ color: theme.text, flex: 1 }}>번역이 없는 곡을 재생하면 자동으로 번역</Text>
        <Switch value={auto} onValueChange={(v) => void toggleAuto(v)} />
      </View>
      <Note theme={theme}>
        켜면 저장된 번역이 없는 곡의 가사 원문 전체가 위에 등록한 AI 제공자에게 전송되고, 제공자 요금이 청구됩니다. 하루
        최대 30회까지만 요청합니다. 한 번 번역한 곡은 기기에 저장되어 다시 요청하지 않습니다. 꺼 두어도 곡 화면의
        버튼으로 한 곡씩 요청할 수 있습니다.
      </Note>
      {usage ? (
        <Note theme={theme}>
          오늘(UTC) 요청: {usage.requests}회 · 보낸 원문 {usage.sourceChars.toLocaleString()}자
        </Note>
      ) : null}

      <Text style={[styles.h2, { color: theme.text, marginTop: 24 }]}>정보</Text>
      <Note theme={theme}>
        가사·번역·발음·싱크 보정값은 이 기기 안(앱 문서 영역의 SQLite)에만 저장됩니다. 가사 출처: LRCLIB. 곡 검색: Apple
        iTunes Search.
      </Note>
      {msg ? (
        <Note theme={theme} tone={msg.danger ? 'danger' : 'dim'}>
          {msg.text}
        </Note>
      ) : null}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 20 },
  h2: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  label: { fontSize: 13, marginTop: 10, marginBottom: 4 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, height: 44, fontSize: 16 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 6 },
  rowGap: { flexDirection: 'row', gap: 8, marginTop: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 10 },
});
