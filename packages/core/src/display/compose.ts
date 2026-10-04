import type { DisplaySettings, LyricsVersion, PronunciationVersion, TranslationVersion } from '../model.js';
import type { SyncResult } from '../sync/sync-engine.js';
import { hasJapaneseScript } from '../util/text.js';

/**
 * 화면에 그릴 가사 행 구성(순수 함수, I/O 없음).
 * 원문은 항상 표시하고, 번역·발음은 설정에 따라 같은 행 묶음 안에 붙인다.
 * 표시 설정 변경은 이 함수만 다시 호출하면 되며 네트워크·AI 호출을 일으키지 않는다.
 */

export type RowState = 'past' | 'active' | 'upcoming' | 'static';

export interface LyricRowView {
  lineId: string;
  original: string;
  pronunciation: string | null;
  translation: string | null;
  state: RowState;
  /** 접근성 라벨: 화면 읽기 프로그램이 읽을 문장 */
  accessibilityLabel: string;
}

export interface LyricsScreenView {
  mode: 'synced' | 'static' | 'instrumental' | 'position-unknown';
  rows: LyricRowView[];
  activeIndex: number | null;
  translationSource: 'user' | 'ai' | null;
  pronunciationSource: 'user' | 'ai' | null;
  /** 단어 단위 싱크는 표시하지 않는다(원본에 있어도 행 단위) */
  wordLevelSync: false;
}

export function composeLyricsView(input: {
  lyrics: LyricsVersion;
  translation: TranslationVersion | null;
  pronunciation: PronunciationVersion | null;
  settings: DisplaySettings;
  sync: SyncResult;
}): LyricsScreenView {
  const { lyrics, translation, pronunciation, settings, sync } = input;
  const showPron = settings.showPronunciation && (lyrics.language === 'ja' || lyrics.language === 'mixed');
  const activeIndex = sync.mode === 'synced' ? sync.activeIndex : null;
  const mode: LyricsScreenView['mode'] =
    lyrics.kind === 'instrumental'
      ? 'instrumental'
      : sync.mode === 'synced'
        ? 'synced'
        : sync.mode === 'unknown'
          ? 'position-unknown'
          : 'static';

  const rows = lyrics.lines.map((line, i): LyricRowView => {
    const tr = settings.showTranslation ? (translation?.lines[line.id] ?? null) : null;
    const pr = showPron && hasJapaneseScript(line.text) ? (pronunciation?.lines[line.id]?.hangul ?? null) : null;
    const state: RowState =
      mode !== 'synced'
        ? 'static'
        : activeIndex === null
          ? 'upcoming'
          : i < activeIndex
            ? 'past'
            : i === activeIndex
              ? 'active'
              : 'upcoming';
    const parts = [line.text, pr ? `발음 ${pr}` : null, tr ? `번역 ${tr}` : null].filter((x): x is string => !!x);
    return {
      lineId: line.id,
      original: line.text,
      pronunciation: pr,
      translation: tr,
      state,
      accessibilityLabel: parts.join('. '),
    };
  });

  return {
    mode,
    rows,
    activeIndex,
    translationSource: settings.showTranslation ? (translation?.origin ?? null) : null,
    pronunciationSource: showPron ? (pronunciation?.origin ?? null) : null,
    wordLevelSync: false,
  };
}
