import { useMemo, useState } from 'react';
import {
  rankLyricsRecords,
  summarizeLyricsCandidate,
  type LrclibRecord,
  type RankedLyricsRecord,
} from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note } from './common';
import { ManualLyricsEntry } from './ManualLyricsEntry';

function mmssSec(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 가사 고르기: 자동 조회가 확정하지 못한 후보 + LRCLIB 직접 검색(iPhone 앱 LyricsPicker와 같은 규칙).
 * 사용자가 고른 레코드만 현재 곡에 적용한다(같은 녹음인지 사용자가 확인, 불변조건 6).
 * 목록은 자동 조회와 같은 순위(곡 일치 → 싱크 → 원문 → 한국어 뜻 → 한글 발음, D-43)로 정렬하고
 * 레코드마다 무엇이 있는지와 곡이 다를 수 있다는 경고를 보여 준다.
 * 검색으로도 못 찾으면 "가사 직접 등록"(TXT/LRC 파일·붙여넣기, D-40)으로 넘어간다.
 */
export function LyricsPicker(props: {
  services: AppServices;
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
  const { services } = props;
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
          '찾지 못했습니다. 제목만, 또는 일본어 원제로 검색해 보세요. 그래도 없으면 "가사 직접 등록"으로 넣을 수 있습니다.',
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
        durationMs={props.durationMs}
        hasCurrentLyrics={props.hasCurrentLyrics}
        onBack={() => (props.startManual ? props.onDone() : setManual(false))}
        onSaved={props.onDone}
      />
    );
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>가사 고르기</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            className="input grow"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="곡 제목 또는 가수"
            aria-label="가사 검색어"
            autoFocus
          />
          <Button kind="primary" label={busy ? '…' : '검색'} type="submit" disabled={busy} />
          <Button label="닫기" onClick={props.onDone} />
        </form>
        {msg ? <Note>{msg}</Note> : null}
        <div className="row">
          <Button icon="edit" label="가사 직접 등록 (파일·붙여넣기)" onClick={() => setManual(true)} />
        </div>
      </div>
      <div className="screen-body list">
        {rows.map((item) => {
          const rec = item.record;
          const sum = summarizeLyricsCandidate(item, props.durationMs);
          return (
            <button type="button" key={rec.id} className="list-item" onClick={() => void choose(rec)}>
              <span className="li-title">{rec.trackName}</span>
              <span className="li-sub">
                {rec.artistName}
                {rec.albumName ? ` · ${rec.albumName}` : ''} · {mmssSec(rec.duration)}
              </span>
              <span className="li-sub">{sum.features}</span>
              {sum.warning ? <span className="li-warn">{sum.warning}</span> : null}
              <span className="li-faint">{sum.preview}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
