import { useEffect, useMemo, useState } from 'react';
import {
  lyricsToPlainText,
  plainTextFileName,
  type SessionState,
  type SkipReason,
  type TranslationOutcome,
} from '@lyrics-companion/core';
import { downloadTextFile } from '../adapters/files';
import type { AppServices } from '../services';
import { ArtworkTile, Button, Chip, IconButton, Note, useSessionState, type Msg } from './common';
import { EditPanel, type EditMode } from './EditPanel';
import { Icon, type IconName } from './icons';
import { LyricsList } from './LyricsList';
import { LyricsPicker } from './LyricsPicker';
import { PlaybackBar } from './PlaybackBar';
import { SyncRecord } from './SyncRecord';
import type { PlaybackApi } from './usePlayback';

/** 다음 행 전환 시각을 모를 때의 최대 재확인 간격 */
const MAX_TICK_MS = 250;
/** 곡별 보정 버튼 한 번에 움직이는 양 */
const OFFSET_STEP_MS = 100;

const SKIP_TEXT: Record<SkipReason, string> = {
  'no-lyrics': '가사가 없어 번역하지 않았습니다.',
  instrumental: '연주곡입니다.',
  'target-language': '이미 한국어 가사입니다.',
  'not-japanese': '일본어 가사가 아니라 발음을 만들지 않습니다.',
  'too-large': '가사가 너무 길어 번역 한도를 넘습니다.',
  'auto-disabled': '자동 번역이 꺼져 있습니다. 아래 버튼으로 이 곡만 번역할 수 있습니다.',
  'no-provider': '설정 탭에서 AI 제공자·주소 접근 허용·API 키(Windows 보안 저장소)를 등록하면 번역할 수 있습니다.',
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

function ToolTile(props: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="tool-tile" onClick={props.onClick}>
      <Icon name={props.icon} size={20} />
      <span>{props.label}</span>
    </button>
  );
}

/** Apple Music 웹이 연결되지 않았을 때의 안내 */
function ConnectGuide(props: { services: AppServices; playback: PlaybackApi }) {
  const { status } = props.playback;
  const pb = props.services.playback;
  return (
    <div className="center-box">
      <ArtworkTile seed="connect" size={72} />
      <h2>Apple Music 웹과 연결</h2>
      {status.unconnectedTabs > 0 ? (
        <Note>열려 있는 Apple Music 탭과 아직 연결되지 않았습니다. 그 탭을 새로고침(F5)한 뒤 잠시 기다려 주세요.</Note>
      ) : (
        <Note>
          같은 브라우저에서 music.apple.com을 열고 로그인한 뒤 곡을 재생하면, 여기에 가사가 자동으로 맞춰 나옵니다. 곡
          제목·가수·길이는 가사를 찾는 데에만 쓰입니다(LRCLIB, Apple 곡 정보 조회).
        </Note>
      )}
      <div className="row center">
        <Button kind="primary" icon="external" label="Apple Music 웹 열기" onClick={() => void pb.openAppleMusic()} />
        <Button icon="refresh" label="다시 연결" onClick={() => void pb.reconnect()} />
      </div>
    </div>
  );
}

export function NowPlaying(props: { services: AppServices; playback: PlaybackApi }) {
  const { services, playback: pb } = props;
  const { session } = services;
  const control = services.playback.control;
  const s: SessionState = useSessionState(session);
  const [tick, setTick] = useState('');
  const [picking, setPicking] = useState<false | 'search' | 'manual'>(false);
  const [editing, setEditing] = useState<EditMode | null>(null);
  const [recording, setRecording] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toolMsg, setToolMsg] = useState<Msg>(null);

  // 화면 갱신: 다음 행이 시작되는 바로 그 순간에 맞춰 다시 확인한다(D-25). 활성 행·모드가 바뀔 때만 다시 그린다.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = () => {
      if (!alive) return;
      const r = session.syncFor(pb.latest());
      const key = r.mode === 'synced' ? `synced|${r.activeIndex ?? '-'}` : `${r.mode}|${r.reason}`;
      setTick((prev) => (prev === key ? prev : key));
      let delay = MAX_TICK_MS;
      if (r.mode === 'synced' && r.nextChangeInMs !== null) delay = Math.min(delay, r.nextChangeInMs + 5);
      timer = setTimeout(loop, Math.max(5, delay));
    };
    loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [session, pb.latest, s]);

  const view = useMemo(() => session.screen(pb.latest()), [s, tick, pb.latest, session]);

  // 곡이 바뀌면 가사 고르기·편집 화면을 닫는다(다른 곡 가사에 저장되지 않게)
  useEffect(() => {
    setPicking(false);
    setEditing(null);
    setRecording(false);
    setToolMsg(null);
  }, [s.generation]);

  const timing = useMemo(() => session.timingView(), [s, session]);
  const timedKind = timing?.kind ?? null;
  const isPlaying = pb.snapshot?.status === 'playing';
  const isJa = s.lyrics?.language === 'ja' || s.lyrics?.language === 'mixed';
  const msg = outcomeText(s.lastOutcome);
  const unknownPending = s.lastOutcome?.kind === 'skipped' && s.lastOutcome.reason === 'unknown-outcome-pending';
  const canRecord = !!s.lyrics && s.lyrics.kind !== 'instrumental';
  const connected = pb.status.tabs > 0;
  const preview =
    connected && !!pb.snapshot?.track && pb.snapshot.positionMs === null && pb.snapshot.status === 'playing';

  const currentPos = (): number | null => {
    const snap = pb.latest();
    if (!snap || snap.positionMs === null) return null;
    if (snap.status !== 'playing') return snap.positionMs;
    return snap.positionMs + (services.clock.monotonicMs() - snap.capturedAtMonotonicMs) * snap.rate;
  };

  const exportText = () => {
    if (!s.lyrics) return;
    const text = lyricsToPlainText(s.lyrics);
    if (text === '') {
      setToolMsg({ text: '내보낼 가사가 없습니다', danger: true });
      return;
    }
    const fileName = plainTextFileName({
      title: s.track?.title ?? s.song?.title ?? '',
      artist: s.track?.artist ?? s.song?.artist ?? '',
    });
    downloadTextFile(fileName, text);
    setToolMsg({
      text: `원문 ${text.split('\n').filter((l) => l !== '').length}줄을 다운로드 폴더에 저장했습니다(${fileName}).`,
    });
  };

  if (editing && s.lyrics && s.phase === 'ready') {
    return (
      <EditPanel
        services={services}
        mode={editing}
        lyrics={s.lyrics}
        translation={s.translation}
        pronunciation={s.pronunciation}
        onDone={() => setEditing(null)}
      />
    );
  }
  if (recording && s.lyrics && s.phase === 'ready') {
    return <SyncRecord services={services} playback={pb} lyrics={s.lyrics} onDone={() => setRecording(false)} />;
  }
  if (picking && s.song) {
    return (
      <LyricsPicker
        services={services}
        initialQuery={s.song.title}
        song={s.song}
        durationMs={s.song.durationMs}
        candidates={s.lyricsCandidates}
        hasCurrentLyrics={s.lyrics !== null}
        startManual={picking === 'manual'}
        onDone={() => setPicking(false)}
      />
    );
  }

  if (!connected && !s.track) return <ConnectGuide services={services} playback={pb} />;

  return (
    <div className="now">
      <header className="now-head">
        <ArtworkTile seed={s.track ? `${s.track.album ?? s.track.title}|${s.track.artist}` : 'idle'} size={52} />
        <div className="now-meta">
          <div className="now-title" title={s.track?.title}>
            {s.track?.title ?? 'Apple Music 웹에서 곡을 재생하세요'}
          </div>
          {s.track ? (
            <div className="now-sub" title={`${s.track.artist}${s.track.album ? ` · ${s.track.album}` : ''}`}>
              {s.track.artist}
              {s.track.album ? ` · ${s.track.album}` : ''}
            </div>
          ) : null}
          {s.phase === 'ready' && view ? (
            <span className="pill">
              {preview
                ? '재생 위치 모름'
                : view.mode === 'position-unknown'
                  ? connected
                    ? '재생 위치 모름'
                    : '연결 끊김'
                  : view.mode === 'static'
                    ? '시간 정보 없는 가사'
                    : timing?.source === 'user'
                      ? '내가 기록한 싱크'
                      : timing?.source === 'auto'
                        ? '소리로 맞춘 싱크' // iPhone에서 맞춰 백업으로 옮긴 경우(D-44)
                        : '자동 싱크'}
            </span>
          ) : null}
        </div>
        {s.phase === 'ready' ? (
          <IconButton
            icon={moreOpen ? 'close' : 'more'}
            label={moreOpen ? '도구 닫기' : '도구 열기: 가사 바꾸기, 번역 입력, 원문 내보내기, 싱크 기록'}
            kind="soft"
            onClick={() => setMoreOpen(!moreOpen)}
            aria-expanded={moreOpen}
          />
        ) : null}
      </header>

      {!connected ? (
        <div className="banner">
          Apple Music 탭과 연결이 끊겼습니다.{' '}
          <button type="button" className="link" onClick={() => void services.playback.reconnect()}>
            다시 연결
          </button>
        </div>
      ) : preview ? (
        <div className="banner">
          웹 플레이어에서 곡의 재생 위치를 읽지 못해 가사를 맞추지 않습니다. 로그인하지 않은 미리듣기(30초)일 때 이렇게
          됩니다 — Apple Music 웹에 로그인(구독)했는지 확인해 주세요.
        </div>
      ) : null}

      {s.phase === 'idle' || s.phase === 'resolving' || s.phase === 'loading-lyrics' ? (
        <div className="center-box">
          <Note>{s.phase === 'idle' ? '재생 중인 곡이 없습니다.' : '가사를 불러오는 중…'}</Note>
        </div>
      ) : s.phase === 'needs-confirmation' ? (
        <div className="scroll pad">
          <h2>저장된 곡 중 같은 녹음이 있나요?</h2>
          <Note>라이브·리믹스 등 다른 버전과 섞이지 않도록 확인합니다.</Note>
          {s.candidates.map((c) => (
            <div key={c.song.id} className="card">
              <strong>{c.song.title}</strong>
              <div className="dim">
                {c.song.artist}
                {c.song.album ? ` · ${c.song.album}` : ''}
              </div>
              <Button label="이 곡이 맞아요" onClick={() => void session.confirmCandidate(c.song.id)} />
            </div>
          ))}
          <Button label="모두 아니에요 — 새 곡으로" onClick={() => void session.rejectCandidates()} />
        </div>
      ) : s.phase === 'no-lyrics' ? (
        <div className="center-box">
          <Note>
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
            kind="primary"
            icon="search"
            label={s.lyricsCandidates.length > 0 ? '후보 보고 고르기' : '가사 직접 찾기'}
            onClick={() => setPicking('search')}
          />
          <Button icon="edit" label="가사 직접 등록 (파일·붙여넣기)" onClick={() => setPicking('manual')} />
        </div>
      ) : view ? (
        <LyricsList
          view={view}
          {...(timedKind === 'synced' && connected
            ? {
                // 줄을 누르면 웹 플레이어를 그 위치로 이동(원문 타임스탬프 또는 내 기록 + 보정값 기준, D-20)
                onPressLine: (i: number) => {
                  const start = session.lineStartMs(i);
                  if (start != null)
                    void control
                      .seekTo(Math.max(0, start - s.offsetMs - s.globalOffsetMs))
                      .then(pb.resync)
                      .catch(() => undefined);
                },
              }
            : {})}
        />
      ) : null}

      <footer className="now-foot">
        {s.phase === 'ready' ? (
          <div className="row wrap">
            {isJa ? (
              <Chip
                label="발음"
                on={s.display.showPronunciation}
                onClick={() => void session.setDisplay({ showPronunciation: !s.display.showPronunciation })}
              />
            ) : null}
            <Chip
              label="번역"
              on={s.display.showTranslation}
              onClick={() => void session.setDisplay({ showTranslation: !s.display.showTranslation })}
            />
            {timedKind === 'synced' ? (
              <div className="offset">
                <IconButton
                  icon="minus"
                  label="가사 늦게(0.1초)"
                  size={28}
                  iconSize={16}
                  onClick={() => void session.setOffset(s.offsetMs - OFFSET_STEP_MS)}
                />
                <span aria-label={`이 곡 싱크 보정 ${formatOffset(s.offsetMs)}`}>싱크 {formatOffset(s.offsetMs)}</span>
                <IconButton
                  icon="plus"
                  label="가사 빨리(0.1초)"
                  size={28}
                  iconSize={16}
                  onClick={() => void session.setOffset(s.offsetMs + OFFSET_STEP_MS)}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {s.phase === 'ready' ? (
          <div className="stack-sm">
            {s.translationStatus === 'pending' ? <Note>번역 중…</Note> : null}
            {s.translationStatus === 'available' && s.translation ? (
              <Note>
                {s.translation.origin === 'user'
                  ? '내가 저장한 번역'
                  : s.translation.origin === 'ai'
                    ? '저장된 AI 번역'
                    : '가사에 포함된 번역(가사 출처에 함께 있던 한국어 뜻)'}
              </Note>
            ) : null}
            {msg && s.translationStatus !== 'available' && s.translationStatus !== 'pending' ? (
              <Note tone={s.lastOutcome?.kind === 'failed' ? 'danger' : 'dim'}>{msg}</Note>
            ) : null}
            <div className="row wrap">
              {!s.translation && s.translationStatus !== 'pending' && s.lyrics?.kind !== 'instrumental' ? (
                <Button
                  icon="cloud"
                  label={unknownPending ? '확인했어요 — 다시 요청' : '이 곡 번역 요청'}
                  onClick={() =>
                    void session.requestTranslation(unknownPending ? { acknowledgeUnknownOutcome: true } : {})
                  }
                />
              ) : null}
              {s.translation?.origin === 'lyrics' && s.translationStatus !== 'pending' ? (
                // 가사에 포함된 번역 대신 AI 번역을 원할 때(명시 요청만, 결과는 새 AI 버전 — D-43)
                <Button
                  icon="cloud"
                  label={unknownPending ? '확인했어요 — AI 번역 다시 요청' : 'AI 번역 받기'}
                  onClick={() => void session.retranslate(unknownPending ? { acknowledgeUnknownOutcome: true } : {})}
                />
              ) : null}
              {isJa && s.translation && !s.pronunciation && s.translationStatus !== 'pending' ? (
                <Button label="발음 생성" onClick={() => void session.requestPronunciation()} />
              ) : null}
              {view?.mode === 'static' && canRecord ? (
                <Button kind="primary" icon="tap" label="싱크 직접 기록" onClick={() => setRecording(true)} />
              ) : null}
            </div>
            {moreOpen ? (
              <div className="tool-grid">
                <ToolTile icon="swap" label="가사 바꾸기" onClick={() => setPicking('search')} />
                {s.lyrics && s.lyrics.kind !== 'instrumental' && s.translationStatus !== 'pending' ? (
                  <ToolTile
                    icon="edit"
                    label={s.translation?.origin === 'user' ? '내 번역 고치기' : '번역 직접 입력'}
                    onClick={() => setEditing('translation')}
                  />
                ) : null}
                {isJa && s.lyrics && s.translationStatus !== 'pending' ? (
                  <ToolTile icon="edit" label="발음 고치기" onClick={() => setEditing('pronunciation')} />
                ) : null}
                {s.lyrics && s.lyrics.kind !== 'instrumental' ? (
                  <ToolTile icon="share" label="원문 txt 내보내기" onClick={exportText} />
                ) : null}
                {canRecord ? (
                  <ToolTile
                    icon="tap"
                    label={timing?.source === 'user' || timing?.source === 'auto' ? '싱크 다시 기록' : '싱크 직접 기록'}
                    onClick={() => setRecording(true)}
                  />
                ) : null}
                {s.timing ? (
                  <ToolTile
                    icon="undo"
                    label={s.lyrics?.kind === 'synced' ? '원래 싱크로' : '내 싱크 끄기'}
                    onClick={() => void session.clearUserTiming()}
                  />
                ) : null}
              </div>
            ) : null}
            {toolMsg ? <Note tone={toolMsg.danger ? 'danger' : 'dim'}>{toolMsg.text}</Note> : null}
          </div>
        ) : null}

        {connected ? (
          <PlaybackBar
            control={control}
            isPlaying={isPlaying}
            durationMs={pb.snapshot?.track?.durationMs ?? s.track?.durationMs ?? null}
            position={currentPos}
            resync={pb.resync}
            onError={(m) => setToolMsg({ text: m, danger: true })}
          />
        ) : null}
      </footer>
    </div>
  );
}
