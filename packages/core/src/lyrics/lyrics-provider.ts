import type { CancelSignal } from '../ports.js';
import { isLyricsRecordCompatible } from '../matching/track-identity.js';
import { parseLrc, parsePlainLyrics, type TimedText } from './lrc.js';
import type { LrclibClient, LrclibRecord } from './lrclib-client.js';

/** 가사 제공자 포트. LRCLIB 외 다른 소스를 추가할 때 같은 인터페이스를 구현한다. */
export interface LyricsQuery {
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  /** Apple Music 스토어 ID(있으면 다른 표기 조회에 사용) */
  storeId?: string | null;
}

export type LyricsFetchResult =
  | {
      status: 'found';
      kind: 'synced';
      timed: TimedText[];
      sourceRef: string;
      hasWordTiming: boolean;
      notices: LyricsNotice[];
    }
  | {
      status: 'found';
      kind: 'plain';
      plain: string[];
      sourceRef: string;
      hasWordTiming: false;
      notices: LyricsNotice[];
    }
  | { status: 'found'; kind: 'instrumental'; sourceRef: string; hasWordTiming: false; notices: LyricsNotice[] }
  | {
      status: 'not_found';
      reason: 'no-record' | 'empty' | 'incompatible-version';
      /** 자동으로 확정하지 못한 가사 후보(사용자 확인 필요). 같은 녹음인지 불확실하므로 자동 적용하지 않는다. */
      candidates?: LrclibRecord[];
    }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'error'; kind: string; message: string };

/** invalid-synced: 싱크 가사가 잘못되어 일반 가사로 대체함 */
export type LyricsNotice = 'invalid-synced' | 'word-sync-ignored';

export interface LyricsProvider {
  readonly id: string;
  fetch(query: LyricsQuery, signal?: CancelSignal): Promise<LyricsFetchResult>;
}

/** LRCLIB 레코드를 가사 상태(싱크/일반/연주곡/없음/잘못됨)로 분류한다. */
export function classifyLrclibRecord(rec: LrclibRecord): LyricsFetchResult {
  const sourceRef = `lrclib:${rec.id}`;
  if (rec.instrumental) return { status: 'found', kind: 'instrumental', sourceRef, hasWordTiming: false, notices: [] };
  const notices: LyricsNotice[] = [];
  if (rec.syncedLyrics && rec.syncedLyrics.trim() !== '') {
    const parsed = parseLrc(rec.syncedLyrics);
    if (parsed.ok) {
      const hasWord = parsed.hadWordTimings || rec.hasWordSync;
      if (hasWord) notices.push('word-sync-ignored');
      return { status: 'found', kind: 'synced', timed: parsed.lines, sourceRef, hasWordTiming: hasWord, notices };
    }
    notices.push('invalid-synced');
  }
  if (rec.plainLyrics && rec.plainLyrics.trim() !== '') {
    return {
      status: 'found',
      kind: 'plain',
      plain: parsePlainLyrics(rec.plainLyrics),
      sourceRef,
      hasWordTiming: false,
      notices,
    };
  }
  if (notices.includes('invalid-synced')) {
    return { status: 'error', kind: 'invalid-lrc', message: '싱크 가사 형식 오류, 일반 가사 없음' };
  }
  return { status: 'not_found', reason: 'empty' };
}

export class LrclibLyricsProvider implements LyricsProvider {
  readonly id = 'lrclib';

  constructor(private readonly client: LrclibClient) {}

  async fetch(q: LyricsQuery): Promise<LyricsFetchResult> {
    const res = await this.client.get({
      trackName: q.title,
      artistName: q.artist,
      albumName: q.album,
      durationSec: q.durationMs == null ? null : q.durationMs / 1000,
    });
    switch (res.status) {
      case 'not_found':
        return { status: 'not_found', reason: 'no-record' };
      case 'rate_limited':
        return res;
      case 'error':
        return { status: 'error', kind: res.kind, message: res.message };
      case 'found': {
        const compatible = isLyricsRecordCompatible(
          { title: q.title, album: q.album, durationMs: q.durationMs },
          { trackName: res.record.trackName, albumName: res.record.albumName, durationSec: res.record.duration },
        );
        if (!compatible) return { status: 'not_found', reason: 'incompatible-version' };
        return classifyLrclibRecord(res.record);
      }
    }
  }
}
