import type { LyricsVersion } from '../model.js';

/**
 * 원문 가사 TXT 내보내기(사용자 요청 2026-10-05, docs/plan.md D-29).
 * - 한 행 = 한 줄, 빈 행(연 구분)도 그대로 둔다. 시간 정보·번역·발음은 넣지 않는다.
 * - 바깥에서 번역한 결과를 "번역 직접 입력"에 붙여 넣으면 빈 행을 뺀 줄 순서대로 맞춰진다
 *   (core previewTxtImport와 같은 규칙: 빈 행 제외 행 수가 같을 때만 제안).
 * - 제목·가수는 파일 이름에만 쓴다(본문 첫 줄에 넣으면 붙여넣기 행 수가 어긋난다).
 */

export function lyricsToPlainText(lyrics: LyricsVersion): string {
  if (lyrics.kind === 'instrumental') return '';
  // 앞뒤 빈 행은 의미가 없으므로 뺀다. 연속 빈 행은 하나로 줄인다.
  const out: string[] = [];
  for (const l of lyrics.lines) {
    const t = l.text.trim() === '' ? '' : l.text;
    if (t === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(t);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** 파일 이름에 쓸 수 없는 문자를 바꾸고 길이를 제한한다. */
function safeNamePart(s: string, max: number): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return [...cleaned].slice(0, max).join('').trim();
}

/** 예: "マリーゴールド - あいみょん (원문).txt" */
export function plainTextFileName(meta: { title: string; artist: string }): string {
  const title = safeNamePart(meta.title, 60) || '가사';
  const artist = safeNamePart(meta.artist, 40);
  return `${artist ? `${title} - ${artist}` : title} (원문).txt`;
}
