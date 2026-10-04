/**
 * 번역 저장·재사용·동시성 수용 테스트 (AT-01 ~ AT-07).
 * 실제 SQLite 파일 + 가짜 LRCLIB/AI 제공자 + 가짜 시계로 실행한다. 유료 호출 없음.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTranslationProvider } from '../support/fakes.js';
import { createHarness, fixture, TRACKS, type Harness } from '../support/harness.js';
import { waitFor } from '../support/wait.js';
import { deferred } from '../support/fakes.js';
import { previewTxtImport } from '../../src/import/user-translation-import.js';
import { selectTranslation } from '../../src/translation/selection.js';

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

function lrclibCalls(h: Harness): number {
  return h.http.calls.filter((c) => c.url.includes('lrclib.net')).length;
}

describe('번역 저장본 재사용', () => {
  it('[AT-01][REQ-TR-05][REQ-ST-01][REQ-TR-04] 최초 번역 저장 후 다시 재생하면 AI 추가 호출 0회', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    expect(h.provider.calls).toHaveLength(1);
    expect(h.session.current.translation?.origin).toBe('ai');
    expect(h.session.current.pronunciation?.origin).toBe('ai');
    const firstTranslationId = h.session.current.translation?.id;

    // 다른 곡을 들었다가 다시 재생
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const callsBefore = h.provider.calls.length;
    const lrclibBefore = lrclibCalls(h);
    for (let i = 0; i < 3; i++) {
      await h.session.onTrackChanged(TRACKS.jaStudio);
      await h.session.idle();
    }
    expect(h.provider.calls.length).toBe(callsBefore);
    expect(lrclibCalls(h)).toBe(lrclibBefore); // 가사도 저장본 사용
    expect(h.session.current.translation?.id).toBe(firstTranslationId);
  });

  it('[AT-01][REQ-TR-05] 모델·프롬프트·제공자가 바뀌어도 기존 번역을 재생성하지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const other = new FakeTranslationProvider('other-ai', 'model-2');
    h.registry.provider = other;
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const outcome = await h.session.requestTranslation(); // 사용자 버튼도 저장본 반환
    expect(outcome?.kind).toBe('existing');
    expect(other.calls).toHaveLength(0);
    expect(h.session.current.translation?.provenance?.providerId).toBe('fake-ai');
  });

  it('[AT-02][REQ-ST-01][REQ-ST-02] 앱 종료 후 재실행해도 저장된 번역을 사용한다(네트워크 요청 0회)', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const before = h.session.current.translation;
    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.provider.calls).toHaveLength(0);
    expect(h2.http.calls).toHaveLength(0);
    expect(h2.session.current.translation?.id).toBe(before?.id);
    expect(h2.session.current.translation?.lines).toEqual(before?.lines);
  });

  it('[AT-03][REQ-TR-06][REQ-ED-01][REQ-TR-04] 사용자 번역이 있으면 자동 번역·사용자 요청 모두 AI 호출 0회', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics;
    expect(lv).not.toBeNull();
    const preview = previewTxtImport(lv!, fixture('import/user-ja-full.txt'));
    expect(preview.requiresManualMapping).toBe(false);
    const saved = await h.session.saveUserTranslation(preview.proposed!);
    expect(saved.ok).toBe(true);

    await h.store.setTranslationSettings({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    expect((await h.session.requestTranslation())?.kind).toBe('existing');
    expect(h.provider.calls).toHaveLength(0);
    expect(h.session.current.translation?.origin).toBe('user');
  });

  it('[AT-03][REQ-TR-06] 부분 사용자 번역도 AI로 보완하지 않는다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    const firstId = lv.lines[0]!.id;
    expect((await h.session.saveUserTranslation({ [firstId]: '종이 등불이 강 위를 떠다녀' })).ok).toBe(true);

    await h.store.setTranslationSettings({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    await h.session.requestTranslation();
    expect(h.provider.calls).toHaveLength(0);
    const screen = h.session.screen(null)!;
    expect(screen.rows[0]?.translation).toBe('종이 등불이 강 위를 떠다녀');
    expect(screen.rows.slice(1).every((r) => r.translation === null)).toBe(true);
  });

  it('[AT-04][REQ-UI-03][REQ-UI-02] 번역·발음 표시를 켜고 꺼도 네트워크·AI 요청이 없고 설정은 재실행 후 유지된다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const http = h.http.calls.length;
    const ai = h.provider.calls.length;

    const combos = [
      { showTranslation: false, showPronunciation: false },
      { showTranslation: true, showPronunciation: false },
      { showTranslation: false, showPronunciation: true },
      { showTranslation: true, showPronunciation: true },
      { showTranslation: false, showPronunciation: true },
    ];
    for (const c of combos) {
      await h.session.setDisplay(c);
      const screen = h.session.screen(null)!;
      const row = screen.rows[0]!;
      expect(row.original).toBe('夜明けの駅で君を待つ'); // 원문은 항상 표시
      expect(row.translation !== null).toBe(c.showTranslation);
      expect(row.pronunciation !== null).toBe(c.showPronunciation);
    }
    await h.session.idle();
    expect(h.http.calls.length).toBe(http);
    expect(h.provider.calls.length).toBe(ai);

    const h2 = await h.restart();
    open.push(h2);
    expect(h2.session.current.display).toEqual({ showTranslation: false, showPronunciation: true });
  });

  it('[AT-05][REQ-TR-09] 같은 곡의 동시 번역 요청은 하나의 작업으로 처리된다', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lvId = h.session.current.lyrics!.id;
    const d = h.provider.deferNext();
    const all = Promise.all([
      h.translation.ensureTranslation(lvId, { trigger: 'user' }),
      h.translation.ensureTranslation(lvId, { trigger: 'user' }),
      h.session.requestTranslation()!,
      h.translation.ensureTranslation(lvId, { trigger: 'user' }),
    ]);
    await waitFor(() => h.provider.calls.length >= 1, 'provider call');
    d.resolve({ rawText: FakeTranslationProvider.autoAnswer(h.provider.calls[0]!) });
    const outcomes = await all;
    expect(h.provider.calls).toHaveLength(1);
    const jobIds = new Set(outcomes.map((o) => (o.kind === 'created' ? o.jobId : o.kind)));
    expect(jobIds.size).toBe(1);
    expect((await h.store.listTranslations(lvId)).length).toBe(1);
    expect((await h.store.listJobs({ lyricsVersionId: lvId })).length).toBe(1);
  });

  it('[AT-06][REQ-TR-09][REQ-TR-06] AI 응답보다 사용자 저장이 먼저 끝나면 사용자 저장본이 유지된다', async () => {
    const h = await harness({ autoTranslate: true });
    const d = h.provider.deferNext();
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await waitFor(() => h.provider.calls.length === 1, 'auto translation started');
    const lv = h.session.current.lyrics!;
    const preview = previewTxtImport(lv, fixture('import/user-ja-full.txt'));
    await h.session.saveUserTranslation(preview.proposed!);
    const userLines = { ...h.session.current.translation!.lines };

    d.resolve({ rawText: FakeTranslationProvider.autoAnswer(h.provider.calls[0]!) }); // 늦게 도착한 AI 응답
    await h.session.idle();

    expect(h.session.current.translation?.origin).toBe('user');
    expect(h.session.current.translation?.lines).toEqual(userLines);
    const all = await h.store.listTranslations(lv.id);
    expect(all.map((t) => t.origin).sort()).toEqual(['ai', 'user']); // AI 결과는 별도 버전으로만 보관
    expect(selectTranslation(all)?.origin).toBe('user');
    expect(all.find((t) => t.origin === 'user')?.lines).toEqual(userLines);
  });

  it('[AT-07][REQ-TR-09] 곡 변경 후 도착한 이전 곡 응답이 현재 화면을 덮어쓰지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    const d = h.provider.deferNext();
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await waitFor(() => h.provider.calls.length === 1, 'ja translation started');
    const jaLv = h.session.current.lyrics!;

    await h.session.onTrackChanged(TRACKS.enStudio);
    await waitFor(() => h.session.current.translation !== null, 'en translation shown');
    d.resolve({ rawText: FakeTranslationProvider.autoAnswer(h.provider.calls[0]!) });
    await h.session.idle();

    const cur = h.session.current;
    expect(cur.song?.title).toBe('Paper Lanterns');
    expect(cur.translation?.lyricsVersionId).toBe(cur.lyrics?.id);
    expect(Object.values(cur.translation!.lines).some((t) => t.includes('夜明け'))).toBe(false);
    const screen = h.session.screen(null)!;
    expect(screen.rows.every((r) => !/[぀-ヿ]/.test(r.translation ?? ''))).toBe(true);
    // 이전 곡 번역은 해당 곡 저장본으로는 남는다(다음 재생 때 재사용)
    expect((await h.store.listTranslations(jaLv.id)).length).toBe(1);
  });

  it('[AT-07][REQ-TR-09] 빠르게 곡을 바꾸면 이전 곡의 늦은 상태 갱신이 한순간도 현재 곡 화면에 섞이지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.onTrackChanged(TRACKS.enStudio);
    await h.session.idle();
    // 두 곡 모두 저장된 상태에서, 첫 곡(ja)의 저장소 읽기만 지연시킨다.
    const gate = deferred<void>();
    let gated = false;
    h.driver.beforeQuery = (sql) => {
      if (!gated && sql.includes('FROM sync_offsets')) {
        gated = true;
        return gate.promise;
      }
      return undefined;
    };
    const seen: Array<{ track?: string; song?: string; lyricsSong?: string }> = [];
    const unsubscribe = h.session.subscribe((st) =>
      seen.push({ track: st.track?.title, song: st.song?.title, lyricsSong: st.lyrics?.songId }),
    );
    const stale = h.session.onTrackChanged(TRACKS.jaStudio);
    await waitFor(() => gated, 'ja load gated');
    const current = h.session.onTrackChanged(TRACKS.enStudio);
    gate.resolve();
    await Promise.all([stale, current]);
    await h.session.idle();
    unsubscribe();
    h.driver.beforeQuery = null;

    const enSongId = h.session.current.song?.id;
    const afterSwitch = seen.slice(seen.findIndex((x) => x.track === 'Paper Lanterns'));
    expect(afterSwitch.length).toBeGreaterThan(1);
    for (const st of afterSwitch) {
      expect(st.song === undefined || st.song === 'Paper Lanterns').toBe(true);
      expect(st.lyricsSong === undefined || st.lyricsSong === enSongId).toBe(true);
    }
    expect(h.session.current.translation?.lyricsVersionId).toBe(h.session.current.lyrics?.id);
  });
});
