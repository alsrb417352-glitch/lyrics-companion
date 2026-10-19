import { useMemo, useState } from 'react';
import {
  hasJapaneseScript,
  originLabel,
  previewLrcImport,
  previewTxtImport,
  type ImportIssue,
  type LyricsVersion,
  type PronunciationVersion,
  type TranslationVersion,
} from '@lyrics-companion/core';
import type { AppServices } from '../services';
import { Button, Note, type Msg } from './common';

export type EditMode = 'translation' | 'pronunciation';

const ISSUE_TEXT: Record<ImportIssue['code'], string> = {
  TOO_LARGE: '붙여 넣은 내용이 너무 깁니다.',
  ENCODING_SUSPECT: '깨진 글자가 있습니다. UTF-8 텍스트인지 확인하세요.',
  EMPTY: '붙여 넣은 내용이 비어 있습니다.',
  LINE_COUNT_MISMATCH: '행 수가 원문과 달라 자동으로 맞추지 않았습니다. 아래 칸에 직접 넣어 주세요.',
  INVALID_LRC: 'LRC 형식이 올바르지 않습니다.',
  UNMATCHED_TIMESTAMP: '시간이 원문과 맞지 않는 행은 넣지 않았습니다.',
  ORIGINAL_NOT_SYNCED: '원문에 시간 정보가 없어 LRC 시간으로 맞출 수 없습니다. 시간 없이 행 순서대로 붙여 넣어 주세요.',
  LINE_TOO_LONG: '너무 긴 행이 있습니다(1000자 초과).',
};

const LRC_TAG = /^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m;

/**
 * 사용자 번역·발음 편집(REQ-ED-01·02·03) — iPhone 앱 EditScreen과 같은 규칙.
 * - 현재 보이는 번역(내 번역 또는 AI 번역)으로 칸을 채워 시작한다(D-22). 저장하면 화면 내용 그대로 "내 번역"이 된다.
 * - 빈 칸은 번역 없이 표시된다. AI로 채우지 않는다(불변조건 3). 저장할 때마다 새 버전, AI 호출 없음.
 * - 붙여넣기(TXT/LRC)는 행 수·시간이 정확히 맞을 때만 칸을 채우고, 저장은 사용자가 확인한 뒤에만 한다.
 */
export function EditPanel(props: {
  services: AppServices;
  mode: EditMode;
  lyrics: LyricsVersion;
  translation: TranslationVersion | null;
  pronunciation: PronunciationVersion | null;
  onDone: () => void;
}) {
  const { services, mode, lyrics } = props;
  const rows = useMemo(
    () => lyrics.lines.filter((l) => l.text.trim() !== '' && (mode === 'translation' || hasJapaneseScript(l.text))),
    [lyrics, mode],
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const l of rows) {
      init[l.id] =
        mode === 'translation'
          ? (props.translation?.lines[l.id] ?? '')
          : (props.pronunciation?.lines[l.id]?.hangul ?? '');
    }
    return init;
  });
  const [dirty, setDirty] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [saving, setSaving] = useState(false);

  const filled = rows.filter((l) => (values[l.id] ?? '').trim() !== '').length;
  const baseLabel =
    mode === 'translation'
      ? props.translation
        ? originLabel('translation', props.translation.origin)
        : null
      : props.pronunciation
        ? originLabel('pronunciation', props.pronunciation.origin)
        : null;

  const applyPaste = () => {
    const isLrc = LRC_TAG.test(pasteText);
    const preview = isLrc ? previewLrcImport(lyrics, pasteText) : previewTxtImport(lyrics, pasteText);
    const notes = preview.issues.map((i) => ISSUE_TEXT[i.code] + (i.detail ? ` (${i.detail})` : ''));
    if (preview.proposed) {
      setValues((prev) => ({ ...prev, ...preview.proposed }));
      setDirty(true);
      setPasting(false);
      setPasteText('');
      const n = Object.keys(preview.proposed).length;
      setMsg({
        text: [`${n}행을 칸에 채웠습니다. 확인한 뒤 저장을 누르세요.`, ...notes].join(' '),
        danger: preview.requiresManualMapping,
      });
    } else {
      setMsg({ text: notes.join(' ') || '채울 수 있는 행이 없습니다.', danger: true });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const mapping: Record<string, string> = {};
      for (const l of rows) mapping[l.id] = values[l.id] ?? '';
      const r =
        mode === 'translation'
          ? await services.session.saveUserTranslation(mapping)
          : await services.session.saveUserPronunciation(mapping);
      if (r.ok) props.onDone();
      else setMsg({ text: r.error ?? '저장하지 못했습니다', danger: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>{mode === 'translation' ? '번역 편집' : '발음(한글 독음) 편집'}</h2>
        <Note>
          {baseLabel ? `${baseLabel}으로 채워 시작했습니다. ` : ''}
          저장하면 이 내용이 {mode === 'translation' ? '"내 번역"' : '"내 발음"'}이 되어 AI 결과보다 먼저 보입니다. 빈
          칸은 비워 둔 채 표시되고 AI로 채우지 않습니다. 이전 버전은 지워지지 않습니다. ({filled}/{rows.length}행 입력)
        </Note>
        {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
        {mode === 'translation' ? (
          pasting ? (
            <div className="stack">
              <textarea
                className="input paste"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="번역 전체를 붙여 넣으세요(한 행에 한 줄, 또는 LRC)"
                aria-label="붙여 넣을 번역"
                autoFocus
              />
              <div className="row">
                <Button kind="primary" label="칸에 채우기" onClick={applyPaste} disabled={!pasteText} />
                <Button label="닫기" onClick={() => setPasting(false)} />
              </div>
            </div>
          ) : (
            <Button label="붙여넣기로 채우기(TXT·LRC)" onClick={() => setPasting(true)} />
          )
        ) : null}
      </div>
      <div className="screen-body edit-list">
        {rows.length === 0 ? (
          <Note>{mode === 'pronunciation' ? '일본어 행이 없습니다.' : '편집할 가사 행이 없습니다.'}</Note>
        ) : null}
        {rows.map((l) => (
          <label key={l.id} className="edit-row">
            <span className="edit-orig">{l.text}</span>
            <textarea
              className="input"
              rows={1}
              value={values[l.id] ?? ''}
              placeholder={mode === 'translation' ? '번역' : '한글 발음'}
              onChange={(e) => {
                const v = e.target.value;
                setValues((prev) => ({ ...prev, [l.id]: v }));
                setDirty(true);
              }}
            />
          </label>
        ))}
      </div>
      <div className="screen-foot row">
        <Button label="취소" onClick={props.onDone} disabled={saving} />
        <Button
          kind="primary"
          className="grow"
          label={saving ? '저장 중…' : '저장'}
          onClick={() => void save()}
          disabled={saving || !dirty || filled === 0}
        />
      </div>
    </div>
  );
}
