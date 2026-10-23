/**
 * 소리로 싱크 맞추기 — 정렬·채우기 규칙(REQ-SY-06, docs/plan.md D-44). 합성 곡·합성 "들은 말"만 사용.
 */
import { describe, expect, it } from 'vitest';
import {
  alignHeardToLyrics,
  alignUnits,
  AUTO_SYNC_RULES,
  autoSyncHints,
  autoSyncLocale,
  matchUnits,
  type AutoSyncResult,
} from '../../src/sync/auto-sync.js';
import { buildTimingFromTaps } from '../../src/sync/user-timing.js';
import { buildLyricsVersion } from '../../src/lyrics/lyrics-version.js';
import type { LyricsVersion } from '../../src/model.js';
import {
  EN_SONG,
  hearSong,
  JA_OTHER_SONG,
  JA_SONG,
  singTimeline,
  type SongTimeline,
} from '../support/auto-sync-sim.js';

function plain(lines: string[], id = 'lv_auto'): LyricsVersion {
  return buildLyricsVersion({
    id,
    songId: 'song_auto',
    source: 'user',
    sourceRef: 'user:typed',
    kind: 'plain',
    plain: lines,
    createdAtEpochMs: 0,
  });
}

function run(song: SongTimeline, heard = hearSong(song), coverEnd = song.durationMs): AutoSyncResult {
  return alignHeardToLyrics({
    lyrics: plain(song.lines),
    heard,
    coverage: { startMs: 0, endMs: coverEnd },
    durationMs: song.durationMs,
  });
}

function errors(r: AutoSyncResult, song: SongTimeline): number[] {
  if (!r.ok) return [];
  return r.taps.map((t, k) => Math.abs(t - (song.truth[k] as number)));
}

const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))] ?? 0;
};

describe('비교 단위', () => {
  it('[REQ-SY-06] 가타카나→히라가나·전각/반각·문장 부호 제거, 영어는 단어(소문자·아포스트로피 제거)', () => {
    expect(matchUnits('ポケット、ﾎﾟｹｯﾄ！').units.join('')).toBe('ぽけっとぽけっと');
    expect(matchUnits('ラーメン').units).toEqual(['ら', 'め', 'ん']); // 장음 기호는 비교하지 않음
    expect(matchUnits("We DON'T  stop—now").units).toEqual(['we', 'dont', 'stop', 'now']);
    expect(matchUnits('君と I love 夏').units).toEqual(['君', 'と', 'i', 'love', '夏']);
    expect(matchUnits('사랑해 ♪ (間奏)').units).toEqual(['사', '랑', '해', '間', '奏']);
  });

  it('[REQ-SY-06] 정렬: 순서를 지키며 같은 단위만 짝짓고, 앞뒤 잡음은 건너뛴다', () => {
    const pairs = alignUnits(['あ', 'い', 'う', 'え', 'お'], ['x', 'あ', 'い', 'z', 'え', 'お', 'y']);
    expect(pairs).toEqual([
      [0, 1],
      [1, 2],
      [3, 4],
      [4, 5],
    ]);
    expect(alignUnits([], ['a'])).toEqual([]);
    // 표가 너무 크면 계산하지 않는다
    const big = Array.from({ length: 5_000 }, () => 'a');
    expect(alignUnits(big, big.slice(0, Math.ceil(AUTO_SYNC_RULES.maxCells / 5_000) + 10))).toBeNull();
  });
});

describe('소리로 맞추기', () => {
  it('[REQ-SY-06][REQ-SY-01] 잘 알아들으면 모든 줄을 소리로 찾고 오차는 0.2초 안', () => {
    const song = singTimeline(JA_SONG);
    const r = run(song);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalLines).toBe(song.truth.length);
    expect(r.taps).toHaveLength(song.truth.length);
    expect(r.heardLines).toBe(song.truth.length);
    expect(Math.max(...errors(r, song))).toBeLessThanOrEqual(200);
    // 저장 규칙(앞에서부터 연속·비감소)을 만족한다
    expect(buildTimingFromTaps(plain(song.lines), r.taps).ok).toBe(true);
  });

  it('[REQ-SY-06] 절반을 못 알아듣고 글자가 바뀌고 시각이 흔들려도: 들은 줄 오차 0.8초 안, 채운 줄 3초 안', () => {
    const song = singTimeline(JA_SONG);
    for (const seed of [1, 2, 3, 4, 5]) {
      const heard = hearSong(song, {
        seed,
        drop: 0.45,
        sub: 0.15,
        jitterMs: 120,
        noise: [
          { atMs: 5_000, text: 'ああ' },
          { atMs: 60_000, text: 'おお' },
        ],
      });
      const r = run(song, heard);
      expect(r.ok, `seed ${seed}`).toBe(true);
      if (!r.ok) continue;
      expect(r.heardLines / r.totalLines).toBeGreaterThan(0.5);
      const e = errors(r, song);
      expect(p(e, 0.5), `seed ${seed} 중앙 오차`).toBeLessThanOrEqual(500);
      expect(p(e, 0.9), `seed ${seed} 90% 오차`).toBeLessThanOrEqual(1_500);
      expect(Math.max(...e), `seed ${seed} 최대 오차`).toBeLessThanOrEqual(3_000);
      expect(buildTimingFromTaps(plain(song.lines), r.taps).ok).toBe(true);
    }
  });

  it('[REQ-SY-06] 한 연을 통째로 못 알아들어도 간주 뒤 다시 들린 곳부터 채우고, 전주 동안에는 강조하지 않는다', () => {
    // 간주 길이가 서로 달라(2연 뒤 25초, 3연 뒤 4초) 고르게 나누면 틀린다
    const song = singTimeline(JA_SONG, { introMs: 20_000, stanzaGapMs: [6_000, 25_000, 4_000, 6_000] });
    // 3연(대상 줄 8~11)은 거의 못 알아듣고, 첫 줄 근처에서 흐릿한 소리 몇 개만 들림
    const deaf = new Set([8, 9, 10, 11]);
    const t8 = song.truth[8] as number;
    const heard = hearSong(song, {
      seed: 9,
      drop: 0.2,
      deafLines: deaf,
      noise: [
        { atMs: t8 + 100, text: 'ら' },
        { atMs: t8 + 900, text: 'る' },
        { atMs: t8 + 1_700, text: 'む' },
      ],
    });
    const r = run(song, heard);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of deaf) {
      expect(Math.abs((r.taps[k] as number) - (song.truth[k] as number)), `줄 ${k}`).toBeLessThanOrEqual(3_000);
    }
    expect(r.filledLines).toBeGreaterThanOrEqual(deaf.size);
    // 첫 줄은 전주(20초) 동안 미리 강조되지 않는다
    expect(r.taps[0] as number).toBeGreaterThan(18_000);
  });

  it('[REQ-SY-06] 1절 후렴만 알아듣고 같은 가사의 2절 후렴은 못 알아들어도, 들은 소리를 뒤쪽 후렴에 붙이지 않는다', () => {
    const song = singTimeline(JA_SONG);
    // 2연(1절 후렴, 대상 줄 4~7)만 또렷하고 3·4연(2절·2절 후렴, 8~15)은 전혀 못 알아들음
    const heard = hearSong(song, { seed: 6, drop: 0.1, deafLines: new Set([8, 9, 10, 11, 12, 13, 14, 15]) });
    const r = run(song, heard);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of [4, 5, 6, 7]) {
      expect(Math.abs((r.taps[k] as number) - (song.truth[k] as number)), `줄 ${k}`).toBeLessThanOrEqual(1_000);
    }
  });

  it('[REQ-SY-06][REQ-SY-01] 중간에 멈춰 뒷부분을 듣지 않았으면 그 뒤 줄에는 시간을 만들지 않는다(앞에서부터 연속)', () => {
    const song = singTimeline(JA_SONG);
    const until = song.truth[9] as number;
    const r = run(song, hearSong(song, { seed: 3, drop: 0.2, untilMs: until }), until + 1_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.taps.length).toBeLessThan(song.truth.length);
    expect(r.taps.length).toBeGreaterThanOrEqual(9);
    expect(r.untimedLines).toBe(song.truth.length - r.taps.length);
    expect(Math.max(...r.taps)).toBeLessThanOrEqual(until + 1_000);
    expect(buildTimingFromTaps(plain(song.lines), r.taps).ok).toBe(true);
  });

  it('[REQ-SY-06] 순서가 어긋난 엉뚱한 짝(다른 줄 글이 이른 시각에 들림)은 버리고 시각은 줄지 않는다', () => {
    const song = singTimeline(JA_SONG);
    const heard = hearSong(song, { seed: 4, drop: 0.3 });
    // 13번째 줄 글이 3번째 줄 자리에서 들림(잡음·반향)
    heard.push({ text: JA_SONG[13] as string, startMs: (song.truth[2] as number) + 100, endMs: song.truth[2]! + 900 });
    const r = run(song, heard);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let k = 1; k < r.taps.length; k++) expect(r.taps[k]!).toBeGreaterThanOrEqual(r.taps[k - 1]!);
    expect(Math.abs(r.taps[12]! - song.truth[12]!)).toBeLessThanOrEqual(1_500);
    expect(Math.abs(r.taps[2]! - song.truth[2]!)).toBeLessThanOrEqual(1_500);
  });

  it('[REQ-SY-06] 영어 곡은 단어 단위로 맞춘다', () => {
    const song = singTimeline(EN_SONG, { unitMs: 380 });
    const r = run(song, hearSong(song, { seed: 2, drop: 0.35, sub: 0.1, jitterMs: 100 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(p(errors(r, song), 0.5)).toBeLessThanOrEqual(600);
    expect(Math.max(...errors(r, song))).toBeLessThanOrEqual(3_000);
  });

  it('[REQ-SY-06] 줄마다 빠르기가 다르고 끝음을 끌어도, 인식 시각이 흔들려도 중앙 오차 0.5초 안·최대 3초 안', () => {
    const long = [...JA_SONG, '', ...JA_SONG.slice(0, 9), '', ...JA_SONG.slice(5, 9)];
    for (const tempoSeed of [1, 2, 3]) {
      const song = singTimeline(long, { tempoSeed, stanzaGapMs: [8_000, 20_000, 5_000, 15_000, 3_000, 12_000] });
      const r = run(song, hearSong(song, { seed: tempoSeed * 7, drop: 0.5, sub: 0.15, jitterMs: 200 }));
      expect(r.ok, `tempo ${tempoSeed}`).toBe(true);
      if (!r.ok) continue;
      const e = errors(r, song);
      expect(p(e, 0.5)).toBeLessThanOrEqual(500);
      expect(Math.max(...e)).toBeLessThanOrEqual(3_000);
    }
  });

  it('[REQ-SY-06] 엉뚱한 소리(다른 곡)·거의 못 들음·연주곡은 저장할 결과를 만들지 않는다', () => {
    const song = singTimeline(JA_SONG);
    const other = singTimeline(EN_SONG, { unitMs: 380 });
    const wrong = run(song, hearSong(other, { seed: 1 }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe('too-few-matches');
    // 같은 일본어지만 다른 곡: 흔한 글자(の·に·て…)가 우연히 많이 맞아도 순서가 맞지 않으므로 저장하지 않는다
    const otherJa = singTimeline(JA_OTHER_SONG, { unitMs: 250, introMs: 8_000 });
    for (const drop of [0, 0.3, 0.6])
      for (let seed = 1; seed <= 10; seed++) {
        const r = run(song, hearSong(otherJa, { seed, drop, sub: 0.15, jitterMs: 150 }), otherJa.durationMs);
        expect(r.ok, `drop ${drop} seed ${seed}`).toBe(false);
      }
    const nothing = run(song, [{ text: 'あ', startMs: 1_000, endMs: 1_200 }]);
    expect(nothing.ok === false && nothing.reason).toBe('nothing-heard');
    const inst = alignHeardToLyrics({
      lyrics: buildLyricsVersion({
        id: 'i',
        songId: 's',
        source: 'lrclib',
        sourceRef: null,
        kind: 'instrumental',
        createdAtEpochMs: 0,
      }),
      heard: hearSong(song),
      coverage: { startMs: 0, endMs: song.durationMs },
      durationMs: null,
    });
    expect(inst.ok === false && inst.reason).toBe('instrumental');
    // 몇 줄만 우연히 맞으면(기준점이 너무 적음) 저장하지 않는다
    const few = run(song, hearSong(song, { seed: 5, deafLines: new Set(Array.from({ length: 19 }, (_, i) => i + 3)) }));
    expect(few.ok).toBe(false);
  });

  it('[REQ-SY-06] 인식 언어·힌트: 가나가 있으면 일본어, 영어·한국어, 연주곡은 없음. 힌트는 중복·빈 줄 제외·개수 제한', () => {
    expect(autoSyncLocale(plain(JA_SONG))).toBe('ja-JP');
    expect(autoSyncLocale(plain(EN_SONG))).toBe('en-US');
    expect(autoSyncLocale(plain(['사랑해 오늘도', '내일도']))).toBe('ko-KR');
    const hints = autoSyncHints(plain(JA_SONG));
    expect(hints).not.toContain('');
    expect(new Set(hints).size).toBe(hints.length);
    expect(hints.length).toBeLessThan(JA_SONG.length);
    const many = autoSyncHints(plain(Array.from({ length: 300 }, (_, i) => `line ${i}`)));
    expect(many).toHaveLength(100);
  });
});
