import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BackupSummary, ImportReport, UserDataExport } from '@lyrics-companion/core';
import { exportBackup, pickBackup } from '../adapters/backup-files';
import type { AppServices } from '../services';
import { Button, Note } from './common';
import type { Theme } from './theme';

type Pending = { name: string; data: UserDataExport; summary: BackupSummary };

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function reportText(r: ImportReport): string {
  const parts = [
    `곡 ${r.songsAdded}개 추가`,
    r.songsExisting ? `이미 있던 곡 ${r.songsExisting}개` : null,
    `번역 ${r.translationsAdded}개 · 발음 ${r.pronunciationsAdded}개 추가`,
    r.linksRelinked ? `백업 번역으로 연결 ${r.linksRelinked}곡` : null,
    r.linksKept ? `기기 번역 유지 ${r.linksKept}곡` : null,
    r.conflicts ? `내용이 달라 건너뜀 ${r.conflicts}개` : null,
  ].filter((x): x is string => !!x);
  return parts.join(' · ');
}

/**
 * 백업 내보내기·가져오기(REQ-ST-04, REQ-SEC-08).
 * 무료 Apple ID 설치는 7일마다 다시 설치해야 하므로, 앱을 지우기 전에 백업해 두면 번역을 잃지 않는다.
 * 가져오기는 미리보기 → 확인 후에만 저장하고, 기존 데이터를 지우거나 덮어쓰지 않는다.
 */
export function BackupSection(props: { services: AppServices; theme: Theme }) {
  const { services, theme } = props;
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 200) : '실패했습니다', danger: true });
    } finally {
      setBusy(false);
    }
  };

  const onExport = () =>
    run(async () => {
      const r = await exportBackup(services.store, services.clock);
      setMsg({ text: `백업 파일을 만들었습니다: ${r.fileName} (공유 시트에서 "파일에 저장"을 골랐는지 확인하세요)` });
    });

  const onPick = () =>
    run(async () => {
      setPending(null);
      const picked = await pickBackup();
      if (picked.canceled) return;
      if (!picked.parsed.ok) {
        setMsg({ text: `가져올 수 없는 파일입니다: ${picked.parsed.error}`, danger: true });
        return;
      }
      setPending({ name: picked.name, data: picked.parsed.data, summary: picked.parsed.summary });
    });

  const onConfirm = (p: Pending) =>
    run(async () => {
      const report = await services.store.importUserData(p.data, services.clock.nowEpochMs());
      setPending(null);
      // 지금 재생 중인 곡도 저장소 기준으로 다시 연다(저장된 번역이 있으면 AI를 부르지 않음).
      await services.session.reloadCurrent();
      setMsg({ text: `가져오기 완료 — ${reportText(report)}` });
    });

  return (
    <View>
      <Text style={[styles.h2, { color: theme.text }]}>백업</Text>
      <Note theme={theme}>
        무료 Apple ID로 설치한 앱은 7일마다 다시 설치해야 합니다. 앱을 지우거나 다른 iPhone으로 옮기기 전에 백업 파일을
        만들어 두세요. 백업에는 가사·번역·발음·싱크 보정값이 들어가고, API 키·AI 제공자 설정·자동 번역 동의는 들어가지
        않습니다.
      </Note>
      <View style={styles.rowGap}>
        <Button theme={theme} kind="primary" label="백업 파일 만들기" onPress={() => void onExport()} disabled={busy} />
        <Button theme={theme} label="백업 가져오기" onPress={() => void onPick()} disabled={busy} />
      </View>

      {pending ? (
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={{ color: theme.text, fontWeight: '700', fontSize: 16 }}>{pending.name}</Text>
          <Note theme={theme}>
            {fmtDate(pending.summary.exportedAtEpochMs)}에 만든 백업 · 곡 {pending.summary.songs}개 · 내 번역{' '}
            {pending.summary.userTranslations}개 · AI 번역 {pending.summary.aiTranslations}개 · 내 발음{' '}
            {pending.summary.userPronunciations}개 · AI 발음 {pending.summary.aiPronunciations}개
          </Note>
          <Note theme={theme}>
            기기에 있는 데이터는 지우거나 바꾸지 않고 없는 것만 추가합니다. 같은 곡이 양쪽에 있으면 내 번역이 있는 쪽을
            보여 줍니다.
          </Note>
          <View style={styles.rowGap}>
            <Button
              theme={theme}
              kind="primary"
              label="가져오기"
              onPress={() => void onConfirm(pending)}
              disabled={busy}
            />
            <Button theme={theme} label="취소" onPress={() => setPending(null)} disabled={busy} />
          </View>
        </View>
      ) : null}

      {msg ? (
        <Note theme={theme} tone={msg.danger ? 'danger' : 'dim'}>
          {msg.text}
        </Note>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  h2: { fontSize: 18, fontWeight: '700', marginBottom: 4, marginTop: 24 },
  rowGap: { flexDirection: 'row', gap: 8, marginTop: 8 },
  card: { padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginTop: 10 },
});
