import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import type { SessionState, SkipReason, TranslationOutcome } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Chip, Note } from './common';
import { LyricsList } from './LyricsList';
import { LyricsPicker } from './LyricsPicker';
import type { Theme } from './theme';
import type { PlaybackApi } from './usePlayback';
import { useSessionState } from './useSessionState';

const TICK_MS = 250;

const SKIP_TEXT: Record<SkipReason, string> = {
  'no-lyrics': '가사가 없어 번역하지 않았습니다.',
  instrumental: '연주곡입니다.',
  'target-language': '이미 한국어 가사입니다.',
  'not-japanese': '일본어 가사가 아니라 발음을 만들지 않습니다.',
  'too-large': '가사가 너무 길어 번역 한도를 넘습니다.',
  'auto-disabled': '자동 번역이 꺼져 있습니다. 아래 버튼으로 이 곡만 번역할 수 있습니다.',
  'no-provider': '설정 탭에서 AI 제공자와 API 키를 등록하면 번역할 수 있습니다.',
  budget: '오늘 번역 요청 한도에 도달했습니다.',
  'unknown-outcome-pending':
    '이전 번역 요청의 결과를 확인하지 못했습니다(제공자가 이미 처리·과금했을 수 있음). 자동으로 다시 보내지 않습니다.',
};

function outcomeText(o: TranslationOutcome | null): string | null {
  if (!o) return null;
  if (o.kind === 'skipped') return SKIP_TEXT[o.reason];
  if (o.kind === 'failed') {
    const billed = o.failure.billedRisk === 'possible' ? ' (요금이 청구됐을 수 있음)' : '';
    return `번역 실패: ${o.failure.message}${billed}`;
  }
  if (o.kind === 'created' && o.partialFailure) return `일부만 완료: ${o.partialFailure.message}`;
  return null;
}

function formatOffset(ms: number): string {
  const s = (ms / 1000).toFixed(1);
  return ms > 0 ? `+${s}초` : `${s}초`;
}

export function NowPlayingScreen(props: { services: AppServices; playback: PlaybackApi; theme: Theme }) {
  const { services, playback: pb, theme } = props;
  const { session } = services;
  // 가사를 보는 동안 화면이 꺼지지 않게 한다(이 탭을 떠나면 해제).
  useKeepAwake();
  const s: SessionState = useSessionState(session);
  const [tick, setTick] = useState('');
  const [picking, setPicking] = useState(false);

  // 화면 갱신 주기: 활성 행·모드가 바뀔 때만 다시 그린다.
  useEffect(() => {
    const id = setInterval(() => {
      const v = session.screen(pb.latest());
      const key = v ? `${v.mode}|${v.activeIndex ?? '-'}` : 'none';
      setTick((prev) => (prev === key ? prev : key));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [session, pb.latest]);

  // tick·세션 상태가 바뀔 때만 화면 구성을 다시 계산한다.
  const view = useMemo(() => session.screen(pb.latest()), [s, tick, pb.latest, session]);

  const isPlaying = pb.snapshot?.status === 'playing';
  const control = services.playback?.control;
  const isJa = s.lyrics?.language === 'ja' || s.lyrics?.language === 'mixed';
  const msg = outcomeText(s.lastOutcome);
  /** 현재 추정 위치(ms). 모르면 null — 탐색 버튼은 위치를 알 때만 동작한다. */
  const currentPos = (): number | null => {
    const snap = pb.latest();
    if (!snap || snap.positionMs === null) return null;
    if (snap.status !== 'playing') return snap.positionMs;
    return snap.positionMs + (services.clock.monotonicMs() - snap.capturedAtMonotonicMs);
  };
  const unknownPending = s.lastOutcome?.kind === 'skipped' && s.lastOutcome.reason === 'unknown-outcome-pending';

  // ---------- 권한·연동 상태
  // 곡이 바뀌면 가사 고르기 화면을 닫는다
  useEffect(() => setPicking(false), [s.generation]);

  if (services.playback && pb.access !== 'granted') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[styles.h1, { color: theme.text }]}>Music 앱 연동</Text>
        {pb.access === 'not-determined' ? (
          <>
            <Note theme={theme}>
              Music 앱에서 재생 중인 곡을 읽으려면 Apple Music·보관함 접근을 허용해야 합니다. 곡 제목·가수·길이는 가사를
              찾는 데에만 쓰입니다(LRCLIB, Apple 곡 정보 조회).
            </Note>
            <Button theme={theme} kind="primary" label="접근 허용" onPress={() => void pb.requestAccess()} />
          </>
        ) : pb.access === 'loading' ? (
          <Note theme={theme}>확인 중…</Note>
        ) : (
          <Note theme={theme} tone="danger">
            접근이 허용되지 않았습니다. 설정 앱 › 개인정보 보호 및 보안 › 미디어 및 Apple Music에서 이 앱을 켜 주세요.
          </Note>
        )}
      </View>
    );
  }

  if (picking && s.song) {
    return (
      <LyricsPicker
        services={services}
        theme={theme}
        initialQuery={s.song.title}
        durationMs={s.song.durationMs}
        candidates={s.lyricsCandidates}
        onDone={() => setPicking(false)}
      />
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      {/* 헤더 */}
      <View style={[styles.header, { borderColor: theme.border }]}>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
          {s.track?.title ?? 'Music 앱에서 곡을 재생하세요'}
        </Text>
        {s.track ? (
          <Text style={{ color: theme.textDim, fontSize: 15 }} numberOfLines={1}>
            {s.track.artist}
            {s.track.album ? ` · ${s.track.album}` : ''}
          </Text>
        ) : null}
        <Text style={{ color: theme.textFaint, fontSize: 12, marginTop: 4 }}>
          {view?.mode === 'position-unknown'
            ? 'Music 앱 연동 · 재생 위치를 알 수 없어 진행을 표시하지 않습니다'
            : view?.mode === 'static'
              ? 'Music 앱 연동 · 이 가사에는 시간 정보가 없어 자동 싱크를 할 수 없습니다'
              : 'Music 앱 연동 · 자동 싱크'}
        </Text>
      </View>

      {/* 본문 */}
      {!services.playback ? (
        <View style={styles.center}>
          <Note theme={theme}>이 앱은 iPhone의 Music 앱(Apple Music)과 함께 동작합니다.</Note>
        </View>
      ) : s.phase === 'idle' || s.phase === 'resolving' || s.phase === 'loading-lyrics' ? (
        <View style={styles.center}>
          <Note theme={theme}>{s.phase === 'idle' ? '재생 중인 곡이 없습니다.' : '가사를 불러오는 중…'}</Note>
        </View>
      ) : s.phase === 'needs-confirmation' ? (
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={[styles.h2, { color: theme.text }]}>저장된 곡 중 같은 녹음이 있나요?</Text>
          <Note theme={theme}>라이브·리믹스 등 다른 버전과 섞이지 않도록 확인합니다.</Note>
          {s.candidates.map((c) => (
            <View key={c.song.id} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={{ color: theme.text, fontSize: 16, fontWeight: '600' }}>{c.song.title}</Text>
              <Text style={{ color: theme.textDim }}>
                {c.song.artist}
                {c.song.album ? ` · ${c.song.album}` : ''}
              </Text>
              <Button
                theme={theme}
                label="이 곡이 맞아요"
                onPress={() => void session.confirmCandidate(c.song.id)}
                style={{ marginTop: 8 }}
              />
            </View>
          ))}
          <Button theme={theme} label="모두 아니에요 — 새 곡으로" onPress={() => void session.rejectCandidates()} />
        </ScrollView>
      ) : s.phase === 'no-lyrics' ? (
        <View style={styles.center}>
          <Note theme={theme}>
            {s.lyricsCandidates.length > 0
              ? `비슷한 가사를 ${s.lyricsCandidates.length}개 찾았지만 같은 곡인지 확실하지 않습니다(가수 표기가 다름). 맞는 가사를 골라 주세요.`
              : s.notices.includes('offline')
                ? '오프라인이라 가사를 가져오지 못했습니다. 연결되면 곡을 다시 재생해 주세요.'
                : s.notices.includes('rate-limited')
                  ? '가사 서버 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.'
                  : s.notices.includes('incompatible-version')
                    ? '이 녹음 버전과 맞는 가사를 찾지 못했습니다(다른 버전 가사는 자동으로 쓰지 않습니다).'
                    : 'LRCLIB에서 가사를 찾지 못했습니다. 직접 검색해 볼 수 있습니다.'}
          </Note>
          <Button
            theme={theme}
            kind="primary"
            label={s.lyricsCandidates.length > 0 ? '후보 보고 고르기' : '가사 직접 찾기'}
            onPress={() => setPicking(true)}
            style={{ marginTop: 8 }}
          />
        </View>
      ) : view ? (
        <LyricsList
          theme={theme}
          view={view}
          {...(s.lyrics?.kind === 'synced' && control
            ? {
                // 줄을 탭하면 Music 앱을 그 위치로 이동(원문 타임스탬프 + 보정값 기준)
                onPressLine: (i: number) => {
                  const start = s.lyrics?.lines[i]?.startMs;
                  if (start != null) void control.seekTo(Math.max(0, start - s.offsetMs)).then(pb.refresh);
                },
              }
            : {})}
        />
      ) : null}

      {/* 하단 도구 */}
      <View style={[styles.footer, { borderColor: theme.border, backgroundColor: theme.bg }]}>
        {s.phase === 'ready' ? (
          <View style={styles.rowWrap}>
            {isJa ? (
              <Chip
                theme={theme}
                label="발음"
                on={s.display.showPronunciation}
                onPress={() => void session.setDisplay({ showPronunciation: !s.display.showPronunciation })}
              />
            ) : null}
            <Chip
              theme={theme}
              label="번역"
              on={s.display.showTranslation}
              onPress={() => void session.setDisplay({ showTranslation: !s.display.showTranslation })}
            />
            {s.lyrics?.kind === 'synced' ? (
              <>
                <Chip
                  theme={theme}
                  label="−0.5초"
                  on={false}
                  onPress={() => void session.setOffset(s.offsetMs - 500)}
                />
                <Text style={{ color: theme.textDim, marginRight: 8 }}>{formatOffset(s.offsetMs)}</Text>
                <Chip
                  theme={theme}
                  label="+0.5초"
                  on={false}
                  onPress={() => void session.setOffset(s.offsetMs + 500)}
                />
              </>
            ) : null}
          </View>
        ) : null}

        {s.phase === 'ready' ? (
          <View style={{ marginTop: 6 }}>
            {s.translationStatus === 'pending' ? <Note theme={theme}>번역 중…</Note> : null}
            {s.translationStatus === 'available' && s.translation ? (
              <Note theme={theme}>{s.translation.origin === 'user' ? '내가 저장한 번역' : '저장된 AI 번역'}</Note>
            ) : null}
            {msg && s.translationStatus !== 'available' && s.translationStatus !== 'pending' ? (
              <Note theme={theme} tone={s.lastOutcome?.kind === 'failed' ? 'danger' : 'dim'}>
                {msg}
              </Note>
            ) : null}
            <View style={styles.rowWrap}>
              {!s.translation && s.translationStatus !== 'pending' && s.lyrics?.kind !== 'instrumental' ? (
                <Button
                  theme={theme}
                  label={unknownPending ? '확인했어요 — 다시 요청' : '이 곡 번역 요청'}
                  onPress={() =>
                    void session.requestTranslation(unknownPending ? { acknowledgeUnknownOutcome: true } : {})
                  }
                  style={{ marginRight: 8 }}
                />
              ) : null}
              {isJa && s.translation && !s.pronunciation && s.translationStatus !== 'pending' ? (
                <Button
                  theme={theme}
                  label="발음 생성"
                  onPress={() => void session.requestPronunciation()}
                  style={{ marginRight: 8 }}
                />
              ) : null}
              <Button theme={theme} label="가사 바꾸기" onPress={() => setPicking(true)} />
            </View>
          </View>
        ) : null}

        <View style={[styles.controls]}>
          {control ? (
            <>
              <Button
                theme={theme}
                label="⏮"
                accessibilityLabel="이전 곡"
                onPress={() => void control.skipPrevious()}
              />
              <Button
                theme={theme}
                label="−10초"
                onPress={() => {
                  const pos = currentPos();
                  if (pos != null) void control.seekTo(Math.max(0, pos - 10_000)).then(pb.refresh);
                }}
              />
              <Button
                theme={theme}
                kind="primary"
                label={isPlaying ? '일시정지' : '재생'}
                onPress={() => void (isPlaying ? control.pause() : control.play()).then(pb.refresh)}
              />
              <Button
                theme={theme}
                label="+10초"
                onPress={() => {
                  const pos = currentPos();
                  if (pos != null) void control.seekTo(pos + 10_000).then(pb.refresh);
                }}
              />
              <Button theme={theme} label="⏭" accessibilityLabel="다음 곡" onPress={() => void control.skipNext()} />
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: 24 },
  pad: { padding: 20 },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 20, fontWeight: '700' },
  h1: { fontSize: 24, fontWeight: '800', marginBottom: 8 },
  h2: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  card: { padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginVertical: 6 },
  footer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth },
  rowWrap: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  controls: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, gap: 6 },
});
