import { useState } from 'react';
import { parseLrc, type LrclibRecord } from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note } from './common';

function mmssSec(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function firstLine(r: LrclibRecord): string {
  if (r.instrumental) return '연주곡';
  if (r.syncedLyrics) {
    const p = parseLrc(r.syncedLyrics);
    if (p.ok) return p.lines.find((l) => l.text.trim())?.text ?? '';
  }
  return (r.plainLyrics ?? '').split('\n').find((l) => l.trim()) ?? '';
}

/**
 * 가사 고르기: 자동 조회가 확정하지 못한 후보 + LRCLIB 직접 검색(iPhone 앱 LyricsPicker와 같은 규칙).
 * 사용자가 고른 레코드만 현재 곡에 적용한다(같은 녹음인지 사용자가 확인, 불변조건 6).
 * 길이가 2초 넘게 다르면 다른 녹음일 수 있어 경고한다.
 */
export function LyricsPicker(props: {
  services: AppServices;
  initialQuery: string;
  durationMs: number | null;
  candidates: LrclibRecord[];
  onDone: () => void;
}) {
  const { services } = props;
  const [term, setTerm] = useState(props.initialQuery);
  const [rows, setRows] = useState<LrclibRecord[]>(props.candidates);
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
      setRows(r.records);
      if (r.records.length === 0) setMsg('찾지 못했습니다. 제목만, 또는 일본어 원제로 검색해 보세요.');
    } else if (r.status === 'rate_limited') setMsg('가사 서버 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.');
    else setMsg(r.kind === 'offline' ? '오프라인입니다.' : '가사 검색에 실패했습니다.');
  };

  const choose = async (r: LrclibRecord) => {
    const res = await services.session.chooseLyricsRecord(r);
    if (res.ok) props.onDone();
    else setMsg(res.error ?? '적용하지 못했습니다');
  };

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
      </div>
      <div className="screen-body list">
        {rows.map((item) => {
          const diffSec = props.durationMs == null ? null : Math.round(item.duration - props.durationMs / 1000);
          const far = diffSec !== null && Math.abs(diffSec) > 2;
          return (
            <button type="button" key={item.id} className="list-item" onClick={() => void choose(item)}>
              <span className="li-title">{item.trackName}</span>
              <span className="li-sub">
                {item.artistName}
                {item.albumName ? ` · ${item.albumName}` : ''} · {mmssSec(item.duration)}
                {item.syncedLyrics ? ' · 싱크 가사' : item.instrumental ? '' : ' · 시간 정보 없음'}
              </span>
              {far ? (
                <span className="li-warn">
                  재생 중인 곡과 길이가 {diffSec! > 0 ? '+' : ''}
                  {diffSec}초 달라요 — 다른 버전일 수 있어 싱크가 어긋날 수 있습니다
                </span>
              ) : null}
              <span className="li-faint">{firstLine(item)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
