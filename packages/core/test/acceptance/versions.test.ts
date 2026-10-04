/**
 * 판본·버전 관리: 원문 변경 시 보존(REQ-LY-04), 명시적 재번역(REQ-TR-08), 사용자 발음 수정(REQ-ED-03).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TRACKS, type Harness } from '../support/harness.js';
import { buildLyricsVersion } from '../../src/lyrics/lyrics-version.js';
import { selectPronunciation, selectTranslation } from '../../src/translation/selection.js';

const open: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  open.push(h);
  return h;
}
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

describe('판본과 버전', () => {
  it('[REQ-LY-04][REQ-ST-01] 원문이 달라진 새 판본을 저장해도 기존 판본과 번역은 보존되고, 활성 판본은 명시적으로만 바뀐다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const old = h.session.current.lyrics!;
    const song = h.session.current.song!;
    const changed = buildLyricsVersion({
      id: 'lv_changed',
      songId: song.id,
      source: 'lrclib',
      sourceRef: 'lrclib:1002',
      kind: 'synced',
      timed: old.lines.map((l, i) => ({ startMs: l.startMs ?? 0, text: i === 0 ? `${l.text} (fixed typo)` : l.text })),
      createdAtEpochMs: h.clock.nowEpochMs(),
    });
    expect(changed.textHash).not.toBe(old.textHash);
    await h.store.saveLyricsVersion(changed, { activate: false });

    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    expect(h.session.current.lyrics?.id).toBe(old.id); // 자동으로 바뀌지 않음
    expect(h.session.current.translation?.lyricsVersionId).toBe(old.id);
    expect((await h.store.listLyricsVersions(song.id)).map((v) => v.id)).toEqual([old.id, 'lv_changed']);
    expect(await h.store.listTranslations('lv_changed')).toHaveLength(0); // 기존 번역을 잘못 붙이지 않음
    expect(h.provider.calls).toHaveLength(1);
  });

  it('[REQ-TR-08][REQ-TR-06] 재번역은 명시 요청으로만 실행되고 새 버전으로 저장되며 사용자 번역은 그대로 우선한다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    const firstAi = h.session.current.translation!;

    const re = await h.session.retranslate();
    expect(re?.kind).toBe('created');
    const afterRe = await h.store.listTranslations(lv.id);
    expect(afterRe.filter((t) => t.origin === 'ai')).toHaveLength(2);
    expect(afterRe.find((t) => t.id === firstAi.id)?.lines).toEqual(firstAi.lines); // 이전 버전 보존
    expect(h.session.current.translation?.id).not.toBe(firstAi.id); // 최신 AI 버전 표시

    await h.session.saveUserTranslation({ [lv.lines[0]!.id]: '내 번역' });
    await h.session.retranslate();
    const final = await h.store.listTranslations(lv.id);
    expect(final.filter((t) => t.origin === 'ai')).toHaveLength(3);
    expect(selectTranslation(final)?.origin).toBe('user');
    expect(h.session.current.translation?.lines).toEqual({ [lv.lines[0]!.id]: '내 번역' });
  });

  it('[REQ-ED-03][REQ-TR-03] 사용자가 수정한 한글 독음이 AI 발음보다 우선한다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    expect(h.session.current.pronunciation?.lines['l0001']?.hangul).toBe('요아케노에키데키미오마츠');
    await h.store.saveUserPronunciation({
      id: 'pr_user',
      lyricsVersionId: lv.id,
      origin: 'user',
      lines: { l0001: { kana: null, hangul: '요아케노 에키데 키미오 마츠' } },
      sourceTextHash: lv.textHash,
      provenance: null,
      createdAtEpochMs: h.clock.nowEpochMs(),
    });
    expect(selectPronunciation(await h.store.listPronunciations(lv.id))?.id).toBe('pr_user');
    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.session.screen(null)?.rows[0]?.pronunciation).toBe('요아케노 에키데 키미오 마츠');
    expect(h2.provider.calls).toHaveLength(0);
  });
});
