import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import type { KeepAliveReason } from '@lyrics-companion/core';
import type { BackgroundKeeper, BackgroundStatus } from '../adapters/background-keeper';
import { Note } from './common';
import type { Theme } from './theme';

const REASON_TEXT: Record<KeepAliveReason, string> = {
  disabled: '꺼져 있음',
  'auto-sync': '쉬는 중 — 소리로 싱크 맞추는 동안은 듣기 기능이 오디오를 씀',
  playing: '깨어 있음 — 재생 중인 곡을 따라가는 중',
  'recently-playing': '깨어 있음 — 재생이 멈췄지만 10분까지 기다림',
  idle: '쉬는 중 — 재생이 10분 넘게 멈춰 있어 놓음(앱을 열면 다시 따라감)',
  'never-played': '대기 — Music 앱에서 재생하면 깨어 있음',
};

/**
 * 설정 › 백그라운드(D-45, iPhone): 다른 앱을 쓰는 동안에도 가사 찾기·자동 번역.
 * 판단은 core KeepAlivePolicy, 반영은 BackgroundKeeper. 여기서는 켜기·끄기와 지금 상태만 보인다.
 */
export function BackgroundSection(props: { keeper: BackgroundKeeper; theme: Theme; autoTranslate: boolean }) {
  const { keeper, theme } = props;
  const [st, setSt] = useState<BackgroundStatus>(keeper.status);
  useEffect(() => {
    setSt(keeper.status);
    const unsub = keeper.subscribe(() => setSt(keeper.status));
    // 이유(재생 중 → 멈춤 등)는 측정마다 바뀌므로 화면에 보이는 동안 가끔 다시 읽는다
    const t = setInterval(() => setSt(keeper.status), 5_000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [keeper]);

  const explain =
    `켜 두면 Music 앱이 재생하는 동안 이 앱이 소리 없는 오디오로 깨어 있어, 화면을 닫거나 다른 앱을 써도 곡이 바뀔 때마다 ` +
    `가사를 찾아 저장하고 ${props.autoTranslate ? '번역까지' : '(위의 자동 번역을 켜면 번역까지)'} 받아 둡니다. ` +
    '나중에 앱을 열면 바로 보입니다. 재생이 10분 넘게 멈추면 배터리를 아끼려고 쉬고, 앱을 다시 열면 이어서 따라갑니다. ' +
    '앱 전환 화면에서 이 앱을 위로 밀어 완전히 닫으면 멈춥니다.';

  return (
    <View>
      <Text style={[styles.h2, { color: theme.text }]}>백그라운드</Text>
      <View style={styles.switchRow}>
        <Text style={{ color: theme.text, flex: 1 }}>다른 앱을 쓰는 동안에도 가사 찾기·자동 번역</Text>
        <Switch value={st.enabled} onValueChange={(v) => void keeper.setEnabled(v)} />
      </View>
      <Note theme={theme}>{explain}</Note>
      <Note theme={theme} tone={st.failed ? 'danger' : 'dim'}>
        지금: {st.failed ? '깨어 있게 하지 못함(전화 중 등) — 잠시 뒤 다시 시도' : REASON_TEXT[st.decision.reason]}
      </Note>
    </View>
  );
}

const styles = StyleSheet.create({
  h2: { fontSize: 18, fontWeight: '700', marginBottom: 4, marginTop: 24 },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 10 },
});
