import type { Clock, IdGenerator, ServiceTrackRef } from '../ports.js';
import type { LyricsVersion, Song } from '../model.js';
import { translatableLines } from '../lyrics/lyrics-version.js';
import { serviceKeyOf } from '../matching/track-identity.js';
import { previewTxtImport, validateUserMapping } from '../import/user-translation-import.js';
import type { Logger } from '../security/logger.js';
import type { LyricsStore } from '../storage/lyrics-store.js';
import { sanitizeLine, sanitizeMultiline } from '../util/text.js';

/**
 * 플레이리스트 번역 묶음 파일(REQ-ED-05, docs/plan.md D-34).
 *
 * 곡마다 "번역 편집 → 붙여넣기 → 저장"을 반복하지 않도록, 플레이리스트 단위로 한 파일을 주고받는다.
 *  1. 내보내기: 플레이리스트에서 가사 원문이 저장돼 있고 아직 "내 번역"이 없는 곡만 골라, 곡마다
 *     머리글(가사 판본 ID 포함) + [원문] + 빈 [번역] 칸이 있는 TXT 한 파일을 만든다.
 *  2. 사용자가 [번역] 아래에 번역을 채운다(직접 또는 바깥 AI — 이 앱은 AI를 부르지 않는다).
 *  3. 가져오기: 머리글의 판본 ID로 곡을 정확히 찾고(제목으로 추측하지 않음, 불변조건 6), 곡마다
 *     기존 "번역 직접 입력"과 같은 규칙(previewTxtImport: 빈 행 제외 행 수가 같을 때만)으로 맞춘다.
 *     미리보기에서 사용자가 확인한 뒤에만 저장한다.
 *
 * 규칙
 * - 파일은 불신 데이터: 크기·곡 수 제한, 판본 ID 형식 검사, 머리글의 제목은 표시에 쓰지 않음(저장소 값 사용).
 *   번역 칸 내용은 텍스트로만 저장하고 지시문으로 해석하지 않는다(불변조건 9).
 * - 이미 "내 번역"이 있는 곡은 건너뛴다(사용자 결정 2026-10-06). 저장 직전에 다시 확인한다.
 * - 저장은 곡마다 새 "내 번역" 버전 추가(원자적). 기존 AI 번역보다 먼저 보이고(불변조건 2), 이전 버전은 남는다.
 * - 행 수가 다르거나 원문을 그대로 둔 곡은 저장하지 않는다(자동으로 끼워 맞추지 않음, REQ-ED-02).
 * - 현재 활성 판본이 아닌 판본을 가리키면(내보낸 뒤 가사를 바꿈) 저장하지 않는다 — 저장해도 화면에 안 보이므로.
 */

export const BUNDLE_HEADER = '# 가사 보조 · 번역 묶음 v1';
export const BUNDLE_LIMITS = { maxChars: 4 * 1024 * 1024, maxSongs: 1000 } as const;

const ORIGINAL_MARK = '[원문]';
const TRANSLATION_MARK = '[번역]';
/** 머리글 끝의 판본 ID 표시. 예: `### 3. 제목 — 가수  {lv:lv_123}` */
const HEADER_ID = /\{lv:([A-Za-z0-9_-]{1,100})\}\s*$/;
const FENCE = /^\s*```/;

// ------------------------------------------------------------------ 내보내기

export interface BundleExportCounts {
  /** 파일에 넣은 곡 */
  included: number;
  /** 가사 원문이 아직 저장되지 않은 곡(먼저 "가사 원문 일괄 받기") */
  noLyrics: number;
  /** 이미 "내 번역"이 있는 곡 */
  hasUserTranslation: number;
  /** 연주곡·번역할 행이 없는 곡 */
  nothingToTranslate: number;
  /** 한국어 가사 */
  korean: number;
  /** 같은 플레이리스트 안 중복 */
  duplicate: number;
}

export interface BundleExport {
  /** 곡이 하나도 없으면 빈 문자열 */
  text: string;
  counts: BundleExportCounts;
}

export interface BundleEntry {
  lyrics: LyricsVersion;
  title: string;
  artist: string;
}

/** 한 줄 머리글용 텍스트(줄바꿈·판본 ID 표시 흉내 제거) */
function headerText(s: string): string {
  return sanitizeLine(s).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 순수 함수: 곡 목록 → 묶음 TXT */
export function formatTranslationBundle(label: string, entries: readonly BundleEntry[]): string {
  if (entries.length === 0) return '';
  const out: string[] = [
    BUNDLE_HEADER,
    `# 플레이리스트: ${headerText(label) || '이름 없음'} (${entries.length}곡)`,
    '# 쓰는 법: 각 곡의 [번역] 아래에 원문과 같은 줄 수로 한국어 번역을 적으세요(한 줄 = 한 줄, 빈 줄은 무시).',
    '# "###" 머리글 줄과 [원문]·[번역] 표시는 지우거나 고치지 마세요. 번역을 비워 둔 곡은 가져올 때 건너뜁니다.',
    '',
  ];
  entries.forEach((e, i) => {
    const name = [headerText(e.title), headerText(e.artist)].filter(Boolean).join(' — ') || '제목 없음';
    out.push(`### ${i + 1}. ${name}  {lv:${e.lyrics.id}}`);
    out.push(ORIGINAL_MARK);
    for (const l of translatableLines(e.lyrics)) out.push(sanitizeLine(l.text));
    out.push(TRANSLATION_MARK);
    out.push('');
    out.push('');
  });
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * 플레이리스트 곡 → 묶음 파일. 저장소만 읽고(곡을 만들거나 바꾸지 않음) 네트워크·AI를 쓰지 않는다.
 * 곡 식별은 지금 재생·일괄 받기와 같은 serviceKey 연결만 쓴다(연결이 없으면 가사가 없는 것으로 본다).
 */
export async function buildTranslationBundle(
  store: LyricsStore,
  input: { label: string; tracks: readonly ServiceTrackRef[] },
): Promise<BundleExport> {
  const counts: BundleExportCounts = {
    included: 0,
    noLyrics: 0,
    hasUserTranslation: 0,
    nothingToTranslate: 0,
    korean: 0,
    duplicate: 0,
  };
  const entries: BundleEntry[] = [];
  const seen = new Set<string>();
  for (const ref of input.tracks) {
    const song = await store.findSongByServiceKey(ref.service, serviceKeyOf(ref));
    const lv = song?.activeLyricsVersionId ? await store.getLyricsVersion(song.activeLyricsVersionId) : null;
    if (!song || !lv) {
      counts.noLyrics++;
      continue;
    }
    if (seen.has(lv.id)) {
      counts.duplicate++;
      continue;
    }
    seen.add(lv.id);
    if (lv.kind === 'instrumental' || translatableLines(lv).length === 0) {
      counts.nothingToTranslate++;
      continue;
    }
    if (lv.language === 'ko') {
      counts.korean++;
      continue;
    }
    if ((await store.listTranslations(lv.id)).some((t) => t.origin === 'user')) {
      counts.hasUserTranslation++;
      continue;
    }
    entries.push({ lyrics: lv, title: song.title, artist: song.artist });
  }
  counts.included = entries.length;
  return { text: formatTranslationBundle(input.label, entries), counts };
}

// ------------------------------------------------------------------ 파싱

export interface BundleSection {
  lyricsVersionId: string;
  /** 머리글에 적힌 이름(저장소에 곡이 없을 때만 표시용으로 씀) */
  heading: string;
  /** [번역] 아래 줄(빈 줄 포함, 원래 순서) */
  translation: string[];
  /** [번역] 표시가 있었는지 */
  hasTranslationMark: boolean;
}

export type BundleParseResult = { ok: true; sections: BundleSection[] } | { ok: false; error: string };

/** 장식(마크다운 굵게·머리글 기호)을 뗀 표시 줄 */
function markOf(line: string): string {
  return line.replace(/^[\s#*_>]+|[\s*_]+$/g, '');
}

export function parseTranslationBundle(input: string): BundleParseResult {
  if (input.length > BUNDLE_LIMITS.maxChars) return { ok: false, error: '파일이 너무 큽니다' };
  const lines = sanitizeMultiline(input).split('\n');
  const sections: BundleSection[] = [];
  let cur: BundleSection | null = null;
  let mode: 'original' | 'translation' = 'original';
  for (const raw of lines) {
    if (FENCE.test(raw)) continue; // 바깥 AI가 감싼 코드 블록 표시
    const id = HEADER_ID.exec(raw);
    if (id) {
      if (sections.length >= BUNDLE_LIMITS.maxSongs) return { ok: false, error: '곡이 너무 많습니다' };
      cur = {
        lyricsVersionId: id[1] ?? '',
        heading: raw
          .slice(0, id.index)
          .replace(/^[\s#*]+/, '')
          .replace(/^\d+\.\s*/, '')
          .trim()
          .slice(0, 120),
        translation: [],
        hasTranslationMark: false,
      };
      sections.push(cur);
      mode = 'original';
      continue;
    }
    if (!cur) continue; // 첫 머리글 앞(설명 줄)은 무시
    const mark = markOf(raw);
    if (mark === ORIGINAL_MARK) {
      mode = 'original';
      continue;
    }
    if (mark === TRANSLATION_MARK) {
      mode = 'translation';
      cur.hasTranslationMark = true;
      continue;
    }
    if (mode === 'translation') cur.translation.push(raw);
  }
  if (sections.length === 0) {
    return { ok: false, error: '번역 묶음 파일이 아닙니다(곡 머리글 "{lv:…}"을 찾지 못했습니다)' };
  }
  return { ok: true, sections };
}

// ------------------------------------------------------------------ 미리보기

export type BundleItemStatus =
  /** 저장할 수 있음 */
  | 'ready'
  /** [번역]이 비어 있음(아직 번역하지 않은 곡) */
  | 'empty'
  /** 이미 "내 번역"이 있어 건너뜀 */
  | 'has-user-translation'
  /** 빈 줄을 뺀 줄 수가 원문과 다름 */
  | 'line-count-mismatch'
  /** 번역 칸이 원문과 똑같음(번역하지 않고 복사한 것으로 봄) */
  | 'same-as-original'
  /** 깨진 글자·너무 긴 줄 등 */
  | 'invalid'
  /** 이 기기에 없는 가사 판본(다른 기기에서 만든 파일 등) */
  | 'unknown-lyrics'
  /** 내보낸 뒤 그 곡의 가사를 다른 판본으로 바꿈 */
  | 'lyrics-changed'
  /** 같은 곡이 파일에 두 번 있음(두 번째부터 건너뜀) */
  | 'duplicate';

export interface BundleItem {
  index: number;
  lyricsVersionId: string;
  songId: string | null;
  title: string;
  artist: string;
  status: BundleItemStatus;
  /** 원문 행 수(빈 행 제외) */
  originalLines: number;
  /** 번역 행 수(빈 행 제외) */
  translatedLines: number;
  /** 저장된 AI 번역이 있어 이 번역으로 바뀌어 보이는지 */
  replacesAi: boolean;
  /** ready일 때 저장할 매핑(행 ID → 번역) */
  lines: Record<string, string> | null;
}

export type BundleCounts = Record<BundleItemStatus, number>;

export interface BundlePreview {
  items: BundleItem[];
  counts: BundleCounts;
}

export function emptyBundleCounts(): BundleCounts {
  return {
    ready: 0,
    empty: 0,
    'has-user-translation': 0,
    'line-count-mismatch': 0,
    'same-as-original': 0,
    invalid: 0,
    'unknown-lyrics': 0,
    'lyrics-changed': 0,
    duplicate: 0,
  };
}

/** 저장소만 읽는다(쓰기·네트워크·AI 없음). */
export async function previewTranslationBundle(
  store: LyricsStore,
  sections: readonly BundleSection[],
): Promise<BundlePreview> {
  const items: BundleItem[] = [];
  const counts = emptyBundleCounts();
  const seen = new Set<string>();
  for (const [index, s] of sections.entries()) {
    const item = await previewOne(store, s, index, seen);
    items.push(item);
    counts[item.status]++;
  }
  return { items, counts };
}

async function previewOne(store: LyricsStore, s: BundleSection, index: number, seen: Set<string>): Promise<BundleItem> {
  const nonEmpty = s.translation.map((l) => l.trim()).filter((l) => l !== '');
  const base: BundleItem = {
    index,
    lyricsVersionId: s.lyricsVersionId,
    songId: null,
    title: s.heading,
    artist: '',
    status: 'ready',
    originalLines: 0,
    translatedLines: nonEmpty.length,
    replacesAi: false,
    lines: null,
  };
  const lv = await store.getLyricsVersion(s.lyricsVersionId);
  if (!lv) return { ...base, status: 'unknown-lyrics' };
  const song: Song | null = await store.getSong(lv.songId);
  const targets = translatableLines(lv);
  const item: BundleItem = {
    ...base,
    songId: lv.songId,
    title: song?.title ?? s.heading,
    artist: song?.artist ?? '',
    originalLines: targets.length,
  };
  if (seen.has(lv.id)) return { ...item, status: 'duplicate' };
  seen.add(lv.id);
  if (!song || song.activeLyricsVersionId !== lv.id) return { ...item, status: 'lyrics-changed' };
  const versions = await store.listTranslations(lv.id);
  if (versions.some((t) => t.origin === 'user')) return { ...item, status: 'has-user-translation' };
  if (nonEmpty.length === 0) return { ...item, status: 'empty' };

  const preview = previewTxtImport(lv, s.translation.join('\n'));
  if (preview.issues.some((i) => i.code === 'LINE_COUNT_MISMATCH')) {
    return { ...item, status: 'line-count-mismatch' };
  }
  if (!preview.proposed || preview.requiresManualMapping) return { ...item, status: 'invalid' };
  const proposed = preview.proposed;
  const same = targets.every((t) => (proposed[t.id] ?? '').trim() === t.text.replace(/\s+/g, ' ').trim());
  if (same) return { ...item, status: 'same-as-original' };
  return { ...item, lines: proposed, replacesAi: versions.some((t) => t.origin === 'ai') };
}

// ------------------------------------------------------------------ 적용

export interface BundleApplyDeps {
  store: LyricsStore;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

export interface BundleApplyReport {
  saved: number;
  /** 저장 직전에 다시 확인해 건너뛴 곡(그 사이 내 번역이 생김·가사가 바뀜) */
  skippedNow: number;
  failed: number;
  /** 저장한 곡 ID(지금 재생 중인 곡이면 화면을 다시 읽는 데 쓴다) */
  savedSongIds: string[];
}

/**
 * 미리보기에서 'ready'였던 곡만 저장한다(사용자가 확인한 뒤 호출).
 * 곡마다 저장 직전에 다시 확인한다: 그 사이 "내 번역"이 생겼거나 가사 판본이 바뀌었으면 건너뛴다.
 * 곡마다 원자적으로 저장하고, 한 곡이 실패해도 이미 저장한 곡은 그대로 둔다. AI를 부르지 않는다.
 */
export async function applyTranslationBundle(
  deps: BundleApplyDeps,
  preview: BundlePreview,
): Promise<BundleApplyReport> {
  const { store, clock, ids, logger } = deps;
  const report: BundleApplyReport = { saved: 0, skippedNow: 0, failed: 0, savedSongIds: [] };
  for (const item of preview.items) {
    if (item.status !== 'ready' || !item.lines) continue;
    try {
      const lv = await store.getLyricsVersion(item.lyricsVersionId);
      const song = lv ? await store.getSong(lv.songId) : null;
      if (!lv || !song || song.activeLyricsVersionId !== lv.id) {
        report.skippedNow++;
        continue;
      }
      if ((await store.listTranslations(lv.id)).some((t) => t.origin === 'user')) {
        report.skippedNow++;
        continue;
      }
      const checked = validateUserMapping(lv, item.lines);
      if (!checked.ok) {
        report.failed++;
        continue;
      }
      await store.saveUserTranslation({
        id: ids.next('tr'),
        lyricsVersionId: lv.id,
        origin: 'user',
        lines: checked.lines,
        sourceTextHash: lv.textHash,
        provenance: null,
        createdAtEpochMs: clock.nowEpochMs(),
      });
      report.saved++;
      report.savedSongIds.push(song.id);
    } catch (e) {
      report.failed++;
      logger.error('bundle.save_failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    }
  }
  // 가사·번역·제목은 로그에 남기지 않는다(개수만).
  logger.info('bundle.applied', { saved: report.saved, skippedNow: report.skippedNow, failed: report.failed });
  return report;
}

/** 미리보기 요약 문장(화면·접근성용). 0인 항목은 뺀다. */
export function summarizeBundle(p: Pick<BundlePreview, 'counts' | 'items'>): string {
  const c = p.counts;
  const parts: string[] = [];
  if (c.ready) parts.push(`적용 가능 ${c.ready}`);
  if (c['has-user-translation']) parts.push(`이미 내 번역 ${c['has-user-translation']}`);
  if (c.empty) parts.push(`번역 비어 있음 ${c.empty}`);
  const fix = c['line-count-mismatch'] + c['same-as-original'] + c.invalid;
  if (fix) parts.push(`고칠 곳 있음 ${fix}`);
  const gone = c['unknown-lyrics'] + c['lyrics-changed'];
  if (gone) parts.push(`곡을 찾지 못함 ${gone}`);
  if (c.duplicate) parts.push(`중복 ${c.duplicate}`);
  return `${p.items.length}곡${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}
