/**
 * AT-24 가사 우선순위·가사에 포함된 한국어 뜻·발음(D-43) 수용 테스트.
 * 합성 픽스처(fixtures/lrclib/get-ja-embedded-ko.json — 실제 곡 아님)·가짜 LRCLIB·가짜 AI만 쓴다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, tempDbPath, TRACKS, type Harness } from '../support/harness.js';
import { NodeSqliteDriver } from '../support/node-sqlite-driver.js';
import { LrclibClient } from '../../src/lyrics/lrclib-client.js';
import { LrclibLyricsProvider } from '../../src/lyrics/lyrics-provider.js';
import { PlaylistLyricsBatch } from '../../src/batch/playlist-lyrics-batch.js';
import { parseBackup } from '../../src/backup/backup-file.js';
import { getSchemaVersion, LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../../src/storage/migrations.js';
import { LyricsStore } from '../../src/storage/lyrics-store.js';
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

const ORIGINALS = [
  '星降る夜のベンチで',
  'きみの名前を呼んだ',
  '風がそっと笑ってた',
  'ふたりだけの合図',
  'また明日ねと手を振る',
  '遠い街の灯りまで',
  'Hello ひとりじゃない',
];

async function playEmbedded(h: Harness) {
  await h.session.onTrackChanged(TRACKS.jaEmbedded);
  await h.session.idle();
  return h.session.current;
}

describe('AT-24 가사에 포함된 한국어 뜻·발음', () => {
  it('[AT-24][REQ-LY-08][REQ-TR-05] 원문/발음/뜻이 번갈아 적힌 가사: 원문 줄만 가사로, 뜻·발음은 "가사에 포함된" 번역·발음으로 표시하고 AI는 부르지 않는다(자동 번역 켜짐)', async () => {
    const h = await harness({ autoTranslate: true });
    const s = await playEmbedded(h);
    expect(s.phase).toBe('ready');
    const texts = s.lyrics!.lines.map((l) => l.text);
    expect(texts.filter((t) => t !== '')).toEqual(ORIGINALS);
    // 원문 시간은 그대로(빈 줄 = 간주 표시도 유지), 한국어 줄 시간은 쓰지 않음
    expect(s.lyrics!.lines.map((l) => l.startMs)).toEqual([
      10_000, 15_200, 20_400, 25_600, 30_800, 34_000, 39_300, 44_500, 195_000,
    ]);
    expect(s.lyrics!.language).toBe('ja');
    expect(s.translation?.origin).toBe('lyrics');
    expect(s.pronunciation?.origin).toBe('lyrics');
    expect(s.translationStatus).toBe('available');
    const rows = h.session.screen(null)!.rows.filter((r) => r.original !== '');
    expect(rows[0]).toMatchObject({
      original: '星降る夜のベンチで',
      pronunciation: '호시후루 요루노 벤치데',
      translation: '별이 쏟아지는 밤의 벤치에서',
    });
    expect(rows[6]).toMatchObject({ pronunciation: 'Hello 히토리쟈 나이', translation: 'Hello 혼자가 아니야' });
    expect(h.session.screen(null)!.translationSource).toBe('lyrics');
    expect(h.provider.calls).toHaveLength(0);

    // 재실행 후 다시 재생: 네트워크·AI 0회, 같은 표시
    const h2 = await h.restart();
    open.push(h2);
    const before = h2.http.calls.length;
    const s2 = await playEmbedded(h2);
    expect(s2.translation?.origin).toBe('lyrics');
    expect(h2.http.calls.length).toBe(before);
    expect(h2.provider.calls).toHaveLength(0);
  });

  it('[AT-24][REQ-LY-08][REQ-TR-04] 표시 순서: 내 번역 → AI 번역(직접 요청) → 가사에 포함된 번역. 가사에 포함된 번역은 지우지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    const s = await playEmbedded(h);
    const lvId = s.lyrics!.id;

    // AI 번역은 사용자가 직접 요청할 때만(새 AI 버전) — 가사에 포함된 번역보다 앞
    await h.session.retranslate();
    await h.session.idle();
    expect(h.provider.calls).toHaveLength(1);
    expect(h.session.current.translation?.origin).toBe('ai');

    // 내 번역은 언제나 가장 앞
    const mapping = Object.fromEntries(
      s.lyrics!.lines.filter((l) => l.text !== '').map((l) => [l.id, `내 번역: ${l.text}`]),
    );
    expect(await h.session.saveUserTranslation(mapping)).toEqual({ ok: true });
    expect(h.session.current.translation?.origin).toBe('user');

    const all = await h.store.listTranslations(lvId);
    expect(all.map((t) => t.origin).sort()).toEqual(['ai', 'lyrics', 'user']);
    expect(selectTranslation(all.filter((t) => t.origin === 'lyrics'))?.lines[s.lyrics!.lines[0]!.id]).toBe(
      '별이 쏟아지는 밤의 벤치에서',
    );
  });

  it('[AT-24][REQ-LY-05][REQ-LY-08] 플레이리스트 일괄 받기도 한국어 뜻·발음을 같이 저장하고, 나중에 재생하면 LRCLIB·AI 호출 0회', async () => {
    const h = await harness({ autoTranslate: true });
    const lrclib = new LrclibClient({
      http: h.http,
      clock: h.clock,
      clientId: 'LyricsCompanion-test/0.1.0 (test)',
      minIntervalMs: 0,
    });
    const batch = new PlaylistLyricsBatch({
      store: h.store,
      lyrics: new LrclibLyricsProvider(lrclib),
      clock: h.clock,
      ids: h.ids,
      logger: h.logger,
    });
    const end = await batch.start({ label: '합성', tracks: [TRACKS.jaEmbedded] });
    expect(end?.items.map((i) => i.status)).toEqual(['saved']);
    const calls = h.http.calls.length;
    const s = await playEmbedded(h);
    expect(s.translation?.origin).toBe('lyrics');
    expect(s.pronunciation?.origin).toBe('lyrics');
    expect(h.http.calls.length).toBe(calls);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('[AT-24][AT-15][REQ-ST-04] 백업 → 새 설치본 가져오기 후에도 가사에 포함된 번역·발음이 그대로(AI·가사 요청 0회)', async () => {
    const a = await harness({ autoTranslate: true });
    await playEmbedded(a);
    const backup = JSON.stringify(await a.store.exportUserData(LATEST_SCHEMA_VERSION, a.clock.nowEpochMs()));
    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary).toMatchObject({ lyricsTranslations: 1, lyricsPronunciations: 1, aiTranslations: 0 });

    const b = await harness({ autoTranslate: true });
    await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    const s = await playEmbedded(b);
    expect(s.translation?.origin).toBe('lyrics');
    expect(b.http.calls).toHaveLength(0);
    expect(b.provider.calls).toHaveLength(0);
  });

  it('[AT-24][AT-14][REQ-ST-03] v3 → v4 마이그레이션: 기존 번역·발음이 저장 순서(seq)까지 그대로, 새 저장은 뒤 순서로 이어진다', async () => {
    const path = tempDbPath('migration-v4');
    const d = new NodeSqliteDriver(path);
    await migrate(d, MIGRATIONS, 3);
    await d.run(`INSERT INTO songs(id,title,artist,album,duration_ms,version_tags,isrc,active_lyrics_version_id,created_at)
      VALUES ('s1','t','a',NULL,1000,'[]',NULL,'lv1',1)`);
    await d.run(`INSERT INTO lyrics_versions(id,song_id,source,source_ref,kind,language,lines_json,text_hash,content_hash,has_word_timing_source,created_at)
      VALUES ('lv1','s1','lrclib',NULL,'plain','ja','[{"id":"l0001","text":"あ","startMs":null}]','h','c',0,1)`);
    for (const [id, origin, seq] of [
      ['t1', 'ai', 5],
      ['t2', 'user', 9],
    ] as const) {
      await d.run(
        `INSERT INTO translations(seq,id,lyrics_version_id,origin,lines_json,source_text_hash,created_at) VALUES (?,?,?,?,?,?,1)`,
        [seq, id, 'lv1', origin, '{"l0001":"번역"}', 'h'],
      );
    }
    await d.run(
      `INSERT INTO pronunciations(seq,id,lyrics_version_id,origin,lines_json,source_text_hash,created_at) VALUES (3,'p1','lv1','user','{"l0001":{"kana":null,"hangul":"아"}}','h',1)`,
    );
    await d.close();

    const d2 = new NodeSqliteDriver(path);
    const store = await LyricsStore.open(d2);
    expect(await getSchemaVersion(d2)).toBe(4);
    expect((await store.listTranslations('lv1')).map((t) => [t.id, t.origin, t.seq])).toEqual([
      ['t1', 'ai', 5],
      ['t2', 'user', 9],
    ]);
    expect((await store.listPronunciations('lv1')).map((p) => [p.id, p.seq])).toEqual([['p1', 3]]);
    await store.saveUserTranslation({
      id: 't3',
      lyricsVersionId: 'lv1',
      origin: 'user',
      lines: { l0001: '새 번역' },
      sourceTextHash: 'h',
      provenance: null,
      createdAtEpochMs: 2,
    });
    const t3 = (await store.listTranslations('lv1')).find((t) => t.id === 't3');
    expect(t3!.seq).toBeGreaterThan(9);
    await store.close();
  });

  it('[AT-24][REQ-LY-08] 가사에 포함된 번역·발음은 같은 판본의 lyrics 출처로만, 판본과 한 번에 저장된다', async () => {
    const h = await harness({ withProvider: false });
    const s = await playEmbedded(h);
    const songId = s.song!.id;
    const v = { ...s.lyrics!, id: 'lv_other' };
    const bad = {
      id: 'tr_bad',
      lyricsVersionId: s.lyrics!.id, // 다른 판본
      origin: 'lyrics' as const,
      lines: {},
      sourceTextHash: v.textHash,
      provenance: null,
      createdAtEpochMs: 1,
    };
    await expect(
      h.store.saveLyricsVersion(v, { activate: true, embedded: { translation: bad, pronunciation: null } }),
    ).rejects.toThrow();
    // 아무것도 저장되지 않음(판본도, 활성 판본 변경도)
    expect((await h.store.listLyricsVersions(songId)).map((x) => x.id)).not.toContain('lv_other');
    expect((await h.store.getSong(songId))?.activeLyricsVersionId).toBe(s.lyrics!.id);
  });
});
