import { useMemo, useState } from 'react';
import {
  describeUserLyricsError,
  describeUserLyricsWarning,
  parseUserLyrics,
  USER_LYRICS_LIMITS,
  type UserLyricsFormat,
} from '@lyrics-companion/core';
import { pickTextFile } from '../adapters/files';
import type { AppServices } from '../services';
import { Button, Chip, Note } from './common';

const PREVIEW_LINES = 6;

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 가사 직접 등록(D-40, iPhone 앱 ManualLyricsEntry와 같은 규칙): LRCLIB에서 찾지 못한 곡에
 * TXT/LRC 파일을 불러오거나 가사를 붙여 넣어 원문으로 저장한다.
 * - 입력은 불신 데이터: 해석·검증은 core(parseUserLyrics)가 한다. 미리보기를 보고 사용자가 "저장"을 눌러야 저장한다.
 * - [mm:ss.xx] 시간 표시가 있으면 싱크 가사, 없으면 시간 정보 없는 가사(시간을 만들어 내지 않음, 불변조건 5).
 * - 기존 판본·번역은 지우지 않는다(REQ-LY-04).
 */
export function ManualLyricsEntry(props: {
  services: AppServices;
  durationMs: number | null;
  hasCurrentLyrics: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { services } = props;
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
      const picked = await pickTextFile('.txt,.lrc,text/plain', USER_LYRICS_LIMITS.maxChars);
      if (picked.canceled) return;
      if ('error' in picked) {
        setMsg({ text: picked.error, danger: true });
        return;
      }
      setText(picked.text);
      setOrigin('file');
      setFileName(picked.name);
      setFormat('auto');
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

  const clear = () => {
    setText('');
    setFileName(null);
    setOrigin('typed');
    setFormat('auto');
    setMsg(null);
  };

  const previewRows =
    parsed?.ok === true
      ? parsed.kind === 'synced'
        ? parsed.timed.filter((t) => t.text !== '').map((t) => `${mmss(t.startMs)}  ${t.text}`)
        : parsed.plain.filter((l) => l !== '')
      : [];

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="row">
          <h2 className="grow">가사 직접 등록</h2>
          <Button label="뒤로" onClick={props.onBack} />
        </div>
        <Note>
          가사 파일(.txt·.lrc)을 불러오거나 아래 칸에 붙여 넣으세요. 줄 앞에 [00:12.34] 같은 시간이 있으면 자동 싱크로,
          없으면 시간 정보 없는 가사로 저장합니다. 이 PC에만 저장됩니다.
        </Note>
        {props.hasCurrentLyrics ? (
          <Note>지금 가사는 지우지 않고 보관합니다. 새 가사에는 아직 번역이 없습니다(자동 번역 설정을 따릅니다).</Note>
        ) : null}
      </div>
      <div className="screen-body stack">
        <div className="row">
          <Button icon="upload" label={busy ? '…' : '파일 불러오기'} onClick={() => void pickFile()} disabled={busy} />
          {text !== '' ? <Button label="지우기" onClick={clear} /> : null}
        </div>
        {fileName ? <Note>불러온 파일: {fileName}</Note> : null}
        <textarea
          className="input lyrics-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'가사를 붙여 넣으세요\n예) [00:12.34]첫 줄\n    또는 시간 없이 한 줄에 한 행'}
          aria-label="가사 입력"
          spellCheck={false}
        />

        {parsed && !parsed.ok ? (
          <>
            <Note tone="danger">{describeUserLyricsError(parsed.error)}</Note>
            {parsed.error.code === 'INVALID_LRC' && parsed.error.canUseAsPlain ? (
              <Button label="시간 정보 없이 저장하기" onClick={() => setFormat('plain')} />
            ) : null}
          </>
        ) : null}

        {parsed?.ok ? (
          <div className="card">
            <strong>
              {parsed.kind === 'synced' ? '싱크 가사' : '시간 정보 없는 가사'} · {parsed.lineCount}줄
            </strong>
            {parsed.warnings.map((w) => (
              <Note key={w} tone={w === 'beyond-duration' || w === 'replacement-chars' ? 'danger' : 'dim'}>
                {describeUserLyricsWarning(w)}
              </Note>
            ))}
            {format === 'plain' ? <Chip label="시간 표시 쓰기" on={false} onClick={() => setFormat('auto')} /> : null}
            {previewRows.slice(0, PREVIEW_LINES).map((line, i) => (
              <span key={i} className="li-faint">
                {line}
              </span>
            ))}
            {previewRows.length > PREVIEW_LINES ? (
              <span className="li-faint">… 외 {previewRows.length - PREVIEW_LINES}줄</span>
            ) : null}
            <Button
              kind="primary"
              label={busy ? '저장 중…' : '이 곡 가사로 저장'}
              onClick={() => void save()}
              disabled={busy}
            />
          </div>
        ) : null}

        {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
      </div>
    </div>
  );
}
