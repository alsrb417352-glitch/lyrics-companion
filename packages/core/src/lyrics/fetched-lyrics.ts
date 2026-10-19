import { BACKUP_LIMITS } from '../backup/backup-file.js';
import type { LyricsVersion, PronunciationLine, Provenance } from '../model.js';
import type { IdGenerator } from '../ports.js';
import type { NewPronunciation, NewTranslation } from '../storage/lyrics-store.js';
import type { LyricsFetchResult } from './lyrics-provider.js';
import { buildLyricsVersion } from './lyrics-version.js';

/** 가사에 포함된 한국어 뜻·발음 나누기 규칙 버전(이력용, provenance.promptVersion에 기록) */
export const EMBEDDED_KOREAN_VERSION = 'embedded-ko/v1';

export interface FetchedLyrics {
  version: LyricsVersion;
  /** 가사에 원문과 함께 들어 있던 한국어 뜻(origin 'lyrics'). 없으면 null */
  translation: NewTranslation | null;
  /** 가사에 원문과 함께 들어 있던 한글 발음(origin 'lyrics'). 없으면 null */
  pronunciation: NewPronunciation | null;
}

/**
 * 가사 조회 결과 → 저장할 판본(+ 가사에 포함된 한국어 뜻·발음, D-43).
 * 판본과 뜻·발음은 store.saveLyricsVersion(..., { embedded })로 한 트랜잭션에 저장한다.
 * 한 줄이 백업 한도(1000자)를 넘는 뜻·발음은 넣지 않는다(백업을 다른 기기에서 가져올 수 있게).
 */
export function buildFetchedLyrics(input: {
  res: Extract<LyricsFetchResult, { status: 'found' }>;
  songId: string;
  ids: IdGenerator;
  createdAtEpochMs: number;
}): FetchedLyrics {
  const { res, ids, createdAtEpochMs } = input;
  const version = buildLyricsVersion({
    id: ids.next('lv'),
    songId: input.songId,
    source: 'lrclib',
    sourceRef: res.sourceRef,
    kind: res.kind,
    ...(res.kind === 'synced' ? { timed: res.timed } : {}),
    ...(res.kind === 'plain' ? { plain: res.plain } : {}),
    hasWordTimingSource: res.hasWordTiming,
    createdAtEpochMs,
  });
  const embedded = res.kind === 'instrumental' ? null : (res.embedded ?? null);
  if (!embedded) return { version, translation: null, pronunciation: null };

  const provenance: Provenance = { providerId: 'lrclib', model: res.sourceRef, promptVersion: EMBEDDED_KOREAN_VERSION };
  const pickLines = (byIndex: Record<number, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [i, text] of Object.entries(byIndex)) {
      const line = version.lines[Number(i)];
      const t = text.trim();
      if (!line || line.text.trim() === '' || t === '' || t.length > BACKUP_LIMITS.maxLineChars) continue;
      out[line.id] = t;
    }
    return out;
  };
  const meaning = pickLines(embedded.meaning);
  const pron = pickLines(embedded.pronunciation);
  const translation: NewTranslation | null =
    Object.keys(meaning).length === 0
      ? null
      : {
          id: ids.next('tr'),
          lyricsVersionId: version.id,
          origin: 'lyrics',
          lines: meaning,
          sourceTextHash: version.textHash,
          provenance,
          createdAtEpochMs,
        };
  const pronLines: Record<string, PronunciationLine> = {};
  for (const [id, hangul] of Object.entries(pron)) pronLines[id] = { kana: null, hangul };
  const pronunciation: NewPronunciation | null =
    Object.keys(pronLines).length === 0
      ? null
      : {
          id: ids.next('pr'),
          lyricsVersionId: version.id,
          origin: 'lyrics',
          lines: pronLines,
          sourceTextHash: version.textHash,
          provenance,
          createdAtEpochMs,
        };
  return { version, translation, pronunciation };
}
