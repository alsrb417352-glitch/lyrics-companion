import { useState } from 'react';
import {
  applyTranslationBundle,
  BUNDLE_LIMITS,
  buildTranslationBundle,
  countPronunciationReady,
  parseTranslationBundle,
  previewTranslationBundle,
  summarizeBundle,
  translationBundleFileName,
  type BundleExportCounts,
  type BundleItem,
  type BundlePreview,
  type ServiceTrackRef,
} from '@lyrics-companion/core';
import { downloadTextFile, pickTextFile } from '../adapters/files';
import type { AppServices } from '../services';
import { Button, Note, type Msg } from './common';
import { Icon } from './icons';

function itemLabel(it: BundleItem): string {
  switch (it.status) {
    case 'ready':
      return `저장 · ${it.translatedLines}줄${it.replacesAi ? ' (AI 번역 대신 표시)' : ''}${it.matchedBy === 'original-text' ? ' · 원문으로 찾음' : ''}`;
    case 'empty':
      return '번역이 비어 있음 — 건너뜀';
    case 'has-user-translation':
      return '이미 내 번역이 있음 — 건너뜀';
    case 'line-count-mismatch':
      return `줄 수가 다름(원문 ${it.originalLines} / 번역 ${it.translatedLines}) — 건너뜀`;
    case 'same-as-original':
      return '번역 칸이 원문과 같음 — 건너뜀';
    case 'invalid':
      return '깨진 글자나 너무 긴 줄이 있음 — 건너뜀';
    case 'unknown-lyrics':
      return '이 PC에 이 원문 가사가 없음 — 건너뜀';
    case 'ambiguous-lyrics':
      return '원문이 똑같은 곡이 여러 개라 고르지 않음 — 그 곡을 재생해 "번역 직접 입력"으로 넣어 주세요';
    case 'lyrics-changed':
      return '내보낸 뒤 가사가 바뀜 — 다시 내보내 주세요';
    case 'duplicate':
      return '파일에 같은 곡이 또 있음 — 건너뜀';
  }
}

/** [발음] 칸 상태(D-35). 발음 대상이 아니거나 비어 있으면 표시하지 않는다. */
function pronunciationLabel(it: BundleItem): string | null {
  switch (it.pronunciationStatus) {
    case 'none':
      return null;
    case 'ready':
      return '발음 저장';
    case 'has-user-pronunciation':
      return '이미 내 발음이 있음 — 발음 건너뜀';
    case 'line-count-mismatch':
      return `발음 줄 수가 다름(원문 ${it.originalLines} / 발음 ${it.pronouncedLines}) — 발음 건너뜀`;
    case 'invalid':
      return '발음 칸에 일본어 글자나 너무 긴 줄이 있음 — 발음 건너뜀';
  }
}

function willSave(it: BundleItem): boolean {
  return it.status === 'ready' || it.pronunciationStatus === 'ready';
}

function skippedNote(c: BundleExportCounts): string {
  const parts: string[] = [];
  if (c.hasUserTranslation) parts.push(`이미 내 번역 있음 ${c.hasUserTranslation}곡`);
  if (c.noLyrics) parts.push(`가사 원문 없음 ${c.noLyrics}곡`);
  if (c.nothingToTranslate) parts.push(`연주곡 등 ${c.nothingToTranslate}곡`);
  if (c.korean) parts.push(`한국어 가사 ${c.korean}곡`);
  if (c.duplicate) parts.push(`중복 ${c.duplicate}곡`);
  return parts.length ? `빠진 곡: ${parts.join(' · ')}.` : '';
}

/**
 * 번역 묶음 내보내기·가져오기(REQ-ED-05, D-34·D-35 — iPhone 앱과 같은 파일 형식).
 * iPhone에서 내보낸 묶음 파일도 판본 ID가 같으면(백업으로 옮긴 곡) PC에서 가져올 수 있다.
 * 판단은 core translation-bundle이 하고, 이 화면은 파일 입출력·확인만 한다. AI를 부르지 않는다.
 */
export function BundlePanel(props: {
  services: AppServices;
  listName: string;
  tracks: readonly ServiceTrackRef[] | null;
  onSaved?: () => void;
}) {
  const { services, tracks } = props;
  const [busy, setBusy] = useState<null | 'export' | 'import' | 'apply'>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [preview, setPreview] = useState<BundlePreview | null>(null);

  const exportBundle = async () => {
    if (!tracks || busy) return;
    setBusy('export');
    setMsg(null);
    try {
      const out = await buildTranslationBundle(services.store, { label: props.listName, tracks });
      const skipped = skippedNote(out.counts);
      if (out.counts.included === 0) {
        setMsg({
          text: `번역할 곡이 없습니다. ${skipped}${out.counts.noLyrics ? ' 먼저 위의 "가사 원문 일괄 받기"를 해 주세요.' : ''}`,
        });
        return;
      }
      const fileName = translationBundleFileName(props.listName);
      downloadTextFile(fileName, out.text);
      setMsg({
        text: `${out.counts.included}곡을 한 파일로 다운로드 폴더에 저장했습니다(${fileName}). 각 곡의 [번역] 아래에 번역을 채운 뒤 "번역 묶음 가져오기"를 누르세요. ${skipped}`,
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : '내보내지 못했습니다', danger: true });
    } finally {
      setBusy(null);
    }
  };

  const loadText = async (text: string) => {
    const parsed = parseTranslationBundle(text);
    if (!parsed.ok) {
      setMsg({ text: parsed.error, danger: true });
      return;
    }
    setPreview(await previewTranslationBundle(services.store, parsed.sections));
    setPasting(false);
    setPasteText('');
  };

  const importFile = async () => {
    if (busy) return;
    setBusy('import');
    setMsg(null);
    try {
      const picked = await pickTextFile('.txt,text/plain', BUNDLE_LIMITS.maxChars);
      if (picked.canceled) return;
      if ('error' in picked) {
        setMsg({ text: picked.error, danger: true });
        return;
      }
      await loadText(picked.text);
    } catch {
      setMsg({ text: '파일을 읽지 못했습니다. UTF-8 텍스트(.txt) 파일인지 확인해 주세요.', danger: true });
    } finally {
      setBusy(null);
    }
  };

  const importPasted = async () => {
    if (busy || pasteText.trim() === '') return;
    setBusy('import');
    setMsg(null);
    try {
      await loadText(pasteText);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview || busy) return;
    setBusy('apply');
    try {
      const r = await applyTranslationBundle(
        { store: services.store, clock: services.clock, ids: services.ids, logger: services.logger },
        preview,
      );
      // 지금 재생 중인 곡에 저장했으면 화면을 저장소 기준으로 다시 연다(AI 호출 없음, 불변조건 1).
      const currentId = services.session.current.song?.id;
      if (currentId && r.savedSongIds.includes(currentId)) await services.session.reloadCurrent();
      const p = r.pronunciation;
      const extra = [
        r.skippedNow ? `그 사이 내 번역이 생기거나 가사가 바뀐 ${r.skippedNow}곡은 건너뜀.` : '',
        r.failed ? `${r.failed}곡은 번역을 저장하지 못했습니다.` : '',
        p.skippedNow ? `그 사이 내 발음이 생기거나 가사가 바뀐 ${p.skippedNow}곡은 발음 건너뜀.` : '',
        p.failed ? `${p.failed}곡은 발음을 저장하지 못했습니다.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const savedParts = [
        r.saved || p.saved === 0 ? `${r.saved}곡에 "내 번역"` : '',
        p.saved ? `${p.saved}곡에 "내 발음"` : '',
      ].filter(Boolean);
      setMsg({ text: `${savedParts.join(', ')}을 저장했습니다. ${extra}`, danger: r.failed + p.failed > 0 });
      setPreview(null);
      props.onSaved?.();
    } catch {
      setMsg({ text: '저장하지 못했습니다. 이미 저장한 곡은 그대로 남아 있습니다.', danger: true });
    } finally {
      setBusy(null);
    }
  };

  const ready = preview?.items.filter(willSave).length ?? 0;
  const pronReady = preview ? countPronunciationReady(preview) : 0;

  if (preview) {
    return (
      <section className="box">
        <div className="box-head">
          <Icon name="upload" size={18} />
          <strong>번역 가져오기 확인</strong>
        </div>
        <Note>{summarizeBundle(preview)}</Note>
        {preview.counts['unknown-lyrics'] > 0 ? (
          <Note tone="danger">
            이 PC에 가사 원문이 없는 곡이 {preview.counts['unknown-lyrics']}곡 있습니다. 다른 기기(iPhone)에서 만든
            파일이면 ① 설정 › 백업 가져오기로 iPhone 백업을 먼저 가져오거나(가장 정확), ② 그 곡들을 Apple Music 웹에서
            재생 목록으로 재생한 뒤 대기열 탭의 &quot;가사 원문 일괄 받기&quot;를 하고 이 파일을 다시 가져오세요. 원문이
            파일과 글자 그대로 같은 곡은 자동으로 찾아 연결합니다.
          </Note>
        ) : null}
        <Note>
          &quot;저장&quot;을 누르면 저장 표시된 곡마다 새 &quot;내 번역&quot;이 추가되어 AI 번역보다 먼저 보입니다
          {pronReady > 0 ? ` (발음 ${pronReady}곡 포함)` : ''}. 기존 번역·발음은 지워지지 않습니다.
        </Note>
        <div className="bundle-list">
          {preview.items.map((item) => (
            <div key={item.index} className="bundle-item">
              <Icon name={willSave(item) ? 'check' : 'close'} size={16} className={willSave(item) ? 'ok' : 'faint'} />
              <div className="grow">
                <div className="ellipsis strong">
                  {item.title || '제목 없음'}
                  {item.artist ? ` — ${item.artist}` : ''}
                </div>
                <div className={item.status === 'ready' ? 'dim' : 'faint'}>{itemLabel(item)}</div>
                {pronunciationLabel(item) ? (
                  <div className={item.pronunciationStatus === 'ready' ? 'dim' : 'faint'}>
                    {pronunciationLabel(item)}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <div className="row">
          <Button label="취소" onClick={() => setPreview(null)} disabled={busy === 'apply'} />
          <Button
            kind="primary"
            className="grow"
            label={busy === 'apply' ? '저장 중…' : ready > 0 ? `${ready}곡 저장` : '저장할 곡 없음'}
            onClick={() => void apply()}
            disabled={busy === 'apply' || ready === 0}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="box">
      <div className="box-head">
        <Icon name="edit" size={18} />
        <strong>번역 한꺼번에 넣기</strong>
      </div>
      <Note>
        ① 번역할 곡(가사 원문이 있고 내 번역이 없는 곡)을 한 파일로 내보내고 ② 각 곡의 [번역] 아래에 번역을 채운 뒤 ③
        가져오면 여러 곡에 &quot;내 번역&quot;이 한 번에 저장됩니다. 일본어 곡은 [발음] 칸에 한글 발음을 적으면 &quot;내
        발음&quot;도 함께 저장됩니다. 줄 수가 원문과 같은 곡만 저장합니다.
      </Note>
      {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
      <div className="row wrap">
        <Button
          icon="share"
          label={busy === 'export' ? '만드는 중…' : '번역할 곡 내보내기'}
          onClick={() => void exportBundle()}
          disabled={!tracks || tracks.length === 0 || busy !== null}
        />
        <Button
          kind="primary"
          icon="upload"
          label={busy === 'import' ? '읽는 중…' : '번역 묶음 가져오기(파일)'}
          onClick={() => void importFile()}
          disabled={busy !== null}
        />
      </div>
      {pasting ? (
        <div className="stack">
          <textarea
            className="input paste"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="번역을 채운 묶음 내용을 통째로 붙여 넣으세요"
            aria-label="번역 묶음 붙여넣기"
          />
          <div className="row">
            <Button label="닫기" onClick={() => setPasting(false)} />
            <Button
              kind="primary"
              className="grow"
              label="미리보기"
              onClick={() => void importPasted()}
              disabled={busy !== null || pasteText.trim() === ''}
            />
          </div>
        </div>
      ) : (
        <Button label="붙여넣기로 가져오기" onClick={() => setPasting(true)} disabled={busy !== null} />
      )}
    </section>
  );
}
