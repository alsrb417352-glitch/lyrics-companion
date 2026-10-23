import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { autoSyncLocale, type AutoSyncRunner, type ListenReadiness, type LyricsVersion } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { itemMessage, mmss, NOT_READY_TEXT, stopText, tooQuiet, useAutoSyncState } from './autoSyncText';
import { Button, Note } from './common';
import { Icon } from './icons';
import type { Theme } from './theme';

/**
 * 소리로 싱크 맞추기 — 지금 곡(REQ-SY-06, docs/plan.md D-44).
 * iPhone 스피커로 곡을 처음부터 한 번 재생하며 마이크로 듣고, 기기 안 음성 인식으로 줄 시작 시간을 맞춰 저장한다.
 * 판단(언제 맞추고 저장할지·탭 기록 보호)은 core AutoSyncRunner가 하고, 이 화면은 안내·시작·멈춤·결과 표시만 한다.
 */
export function AutoSyncScreen(props: {
  services: AppServices;
  runner: AutoSyncRunner;
  theme: Theme;
  /** 화면을 연 때의 곡(곡이 끝나 다음 곡으로 넘어가도 결과를 보여 주려고 따로 둔다) */
  title: string;
  lyrics: LyricsVersion;
  durationMs: number | null;
  /** 탭으로 직접 기록한 싱크가 있음(바꾸기 전에 확인) */
  hasTapTiming: boolean;
  onDone: () => void;
}) {
  const { services, runner, theme, lyrics } = props;
  const st = useAutoSyncState(runner);
  const [ready, setReady] = useState<ListenReadiness | null>(null);
  const [confirmTap, setConfirmTap] = useState(false);
  const [started, setStarted] = useState(false);
  const locale = autoSyncLocale(lyrics);

  // 시작 전 준비 상태 확인(권한을 묻거나 내려받지 않음)
  useEffect(() => {
    let alive = true;
    if (!locale || !services.songListener) return;
    services.songListener.check(locale).then(
      (r) => {
        if (alive) setReady(r);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [locale, services.songListener]);

  const start = () => {
    setStarted(true);
    runner.reset();
    void runner.startSingle(props.hasTapTiming ? { replaceTap: true } : {});
  };

  const mine = st.mode === 'single';
  const running = mine && st.running;
  const result = started && mine && !st.running ? st.items[0] : undefined;
  const stopMsg = started && mine && !st.running ? stopText(st.stoppedBy, st.notReady, st.error) : null;
  const blocking = ready && !ready.ok && !['mic-undetermined', 'model-missing'].includes(ready.reason) ? ready : null;
  const otherRunning = st.running && st.mode === 'batch';

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.pad}>
        <View style={styles.head}>
          <Icon name="mic" size={26} color={theme.accent} />
          <Text style={[styles.h1, { color: theme.text }]}>소리로 싱크 맞추기</Text>
        </View>
        <Text style={{ color: theme.textDim, fontSize: 15 }} numberOfLines={2}>
          {props.title}
        </Text>

        {!started || (!running && !result && !stopMsg) ? (
          <>
            <Note theme={theme}>
              iPhone 스피커로 이 곡을 처음부터 한 번 재생하면서 마이크로 듣고, 각 줄이 불리는 시간을 찾아 맞춥니다. 곡
              길이({mmss(props.durationMs)})만큼 걸립니다.
            </Note>
            <Note theme={theme}>
              • 이어폰·블루투스는 빼 주세요(마이크가 소리를 들어야 합니다). • 조용한 곳에서 소리를 중간 이상으로. • 앱을
              켜 둔 채로 기다려 주세요(화면은 꺼지지 않게 해 둡니다).
            </Note>
            <Note theme={theme}>
              들은 소리는 저장하지 않고 기기 밖으로 보내지 않습니다(기기 안 음성 인식, AI 번역과 무관). 노래는 말보다
              알아듣기 어려워 일부 줄은 앞뒤 줄 사이를 글자 수로 채웁니다. 틀린 곳은 &quot;싱크 직접 기록&quot;으로
              고치거나 &quot;내 싱크 끄기&quot;로 되돌릴 수 있습니다.
            </Note>
            {!locale ? (
              <Note theme={theme} tone="danger">
                이 가사의 언어를 알 수 없어 소리로 맞출 수 없습니다.
              </Note>
            ) : null}
            {blocking && !blocking.ok ? (
              <Note theme={theme} tone="danger">
                {NOT_READY_TEXT[blocking.reason]}
              </Note>
            ) : null}
            {ready && !ready.ok && (ready.reason === 'mic-undetermined' || ready.reason === 'model-missing') ? (
              <Note theme={theme}>{NOT_READY_TEXT[ready.reason]}</Note>
            ) : null}
            {otherRunning ? (
              <Note theme={theme}>
                플레이리스트({st.label ?? ''}) 소리로 맞추기가 진행 중입니다. 끝나면 시작할 수 있습니다.
              </Note>
            ) : null}
            {props.hasTapTiming && !confirmTap ? (
              <>
                <Note theme={theme} tone="danger">
                  이 곡에는 직접 기록한 싱크가 있습니다. 소리로 맞춘 싱크로 바꿀까요? 기록은 지우지 않고 새 버전으로
                  추가됩니다.
                </Note>
                <Button
                  theme={theme}
                  label="바꿔도 돼요"
                  onPress={() => setConfirmTap(true)}
                  disabled={!locale || otherRunning}
                />
              </>
            ) : (
              <Button
                theme={theme}
                kind="primary"
                icon="mic"
                label="처음부터 들으며 맞추기"
                onPress={start}
                disabled={!locale || otherRunning || (blocking !== null && blocking.reason !== 'headphones')}
                style={{ marginTop: 8 }}
              />
            )}
          </>
        ) : null}

        {running ? (
          <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
            <Text style={[styles.title, { color: theme.text }]}>
              {st.phase === 'preparing'
                ? '준비 중(마이크·언어 모델)…'
                : st.phase === 'aligning'
                  ? '가사와 맞추는 중…'
                  : `듣는 중 · ${mmss(st.current?.positionMs)} / ${mmss(props.durationMs)}`}
            </Text>
            {st.phase === 'listening' ? <Note theme={theme}>알아들은 말 {st.current?.heardWords ?? 0}개</Note> : null}
            {st.phase === 'listening' && tooQuiet(st.levelDb) ? (
              <Note theme={theme} tone="danger">
                소리가 거의 들리지 않습니다. iPhone 스피커로 재생 중인지, 소리가 너무 작지 않은지 확인해 주세요.
              </Note>
            ) : null}
            <Note theme={theme}>곡이 끝나면 자동으로 맞춰 저장합니다.</Note>
            <View style={styles.row}>
              <Button
                theme={theme}
                label="여기까지 저장"
                onPress={() => runner.finishNow()}
                disabled={st.phase !== 'listening'}
                style={styles.grow}
              />
              <Button
                theme={theme}
                kind="danger"
                icon="close"
                label="취소"
                onPress={() => runner.cancel()}
                style={styles.grow}
              />
            </View>
          </View>
        ) : null}

        {result || stopMsg ? (
          <View style={[styles.box, { borderColor: theme.border, backgroundColor: theme.surface }]}>
            <View style={styles.head}>
              <Icon
                name={result?.status === 'saved' ? 'check' : 'mic'}
                size={20}
                color={result?.status === 'saved' ? theme.accent : theme.textDim}
              />
              <Text style={[styles.title, { color: theme.text }]}>
                {result?.status === 'saved' ? '소리로 맞춘 싱크를 저장했습니다' : '저장하지 않았습니다'}
              </Text>
            </View>
            {result ? <Note theme={theme}>{itemMessage(result)}</Note> : null}
            {stopMsg ? (
              <Note theme={theme} tone="danger">
                {stopMsg}
              </Note>
            ) : null}
            {result?.status === 'saved' ? (
              <Note theme={theme}>
                전체적으로 조금 늦거나 빠르면 지금 재생 화면의 &quot;가사 늦게/빨리&quot;(이 곡) 또는 설정의 &quot;전체
                싱크 보정&quot;으로 맞출 수 있습니다.
              </Note>
            ) : null}
            <View style={styles.row}>
              {result?.status !== 'saved' ? (
                <Button theme={theme} label="다시 해 보기" onPress={start} style={styles.grow} />
              ) : null}
              <Button theme={theme} kind="primary" label="가사로 돌아가기" onPress={props.onDone} style={styles.grow} />
            </View>
          </View>
        ) : null}

        {!running && !result && !stopMsg ? (
          <Button theme={theme} label="닫기" onPress={props.onDone} style={{ marginTop: 12 }} />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flex: 1 },
  pad: { padding: 20, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  h1: { fontSize: 22, fontWeight: '800' },
  title: { fontSize: 16, fontWeight: '700' },
  box: { marginTop: 10, padding: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 6 },
  row: { flexDirection: 'row', gap: 8, marginTop: 6 },
});
