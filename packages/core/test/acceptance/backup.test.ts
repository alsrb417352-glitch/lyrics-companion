/**
 * 백업 내보내기·가져오기(AT-15, AT-16)와 사용자 발음 편집 수용 테스트.
 * 무료 Apple ID 사이드로드는 7일마다 재서명해야 하고, 앱을 지웠다 다시 깔면 기기 DB가 사라질 수 있다.
 * 백업 파일로 다른 설치본(새 DB)에 옮겨도 같은 번역이 AI 호출 없이 다시 보여야 한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, fixture, TRACKS, type Harness } from '../support/harness.js';
import { previewTxtImport } from '../../src/import/user-translation-import.js';
import { buildUserPronunciation } from '../../src/import/user-pronunciation.js';
import { BACKUP_LIMITS, parseBackup, type UserDataExport } from '../../src/backup/backup-file.js';
import { LATEST_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import type { IdGenerator } from '../../src/ports.js';

/** 설치본마다 다른 ID(앱의 UUID처럼 서로 겹치지 않게) */
class PrefixedIds implements IdGenerator {
  private n = 0;
  constructor(private readonly tag: string) {}
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.tag}${this.n}`;
  }
}

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

/** 기기 A: 일본어 곡을 AI로 번역 → 사용자 번역 저장 → 싱크 보정 → 백업 파일 텍스트 */
async function deviceAWithUserTranslation(): Promise<{
  a: Harness;
  backup: string;
  userLines: Record<string, string>;
}> {
  const a = await harness({ autoTranslate: true, ids: new PrefixedIds('a') });
  await a.session.onTrackChanged(TRACKS.jaStudio);
  await a.session.idle();
  const lv = a.session.current.lyrics!;
  const preview = previewTxtImport(lv, fixture('import/user-ja-full.txt'));
  expect((await a.session.saveUserTranslation(preview.proposed!)).ok).toBe(true);
  await a.session.setOffset(-1500);
  const userLines = { ...a.session.current.translation!.lines };
  const backup = JSON.stringify(await a.store.exportUserData(LATEST_SCHEMA_VERSION, a.clock.nowEpochMs()));
  return { a, backup, userLines };
}

describe('AT-15 백업 내보내기·가져오기', () => {
  it('[AT-15][REQ-ST-04][REQ-ST-01][REQ-TR-05] 새 설치본에 가져오면 같은 사용자 번역·보정값이 AI·가사 요청 없이 보인다', async () => {
    const { backup, userLines } = await deviceAWithUserTranslation();
    const b = await harness({ ids: new PrefixedIds('b') });

    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary).toMatchObject({ songs: 1, userTranslations: 1, aiTranslations: 1, aiPronunciations: 1 });
    const report = await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    expect(report).toMatchObject({
      songsAdded: 1,
      lyricsAdded: 1,
      translationsAdded: 2,
      linksAdded: 1,
      offsetsAdded: 1,
    });

    await b.store.setTranslationSettings({ autoTranslate: true });
    await b.session.onTrackChanged(TRACKS.jaStudio);
    await b.session.idle();
    expect(b.provider.calls).toHaveLength(0);
    expect(lrclibCalls(b)).toBe(0);
    expect(b.session.current.translation?.origin).toBe('user');
    expect(b.session.current.translation?.lines).toEqual(userLines);
    expect(b.session.current.pronunciation?.origin).toBe('ai');
    expect(b.session.current.offsetMs).toBe(-1500);
  });

  it('[AT-15][REQ-ST-04][REQ-TR-06] 재설치 후 먼저 재생해 AI 번역이 생겼어도, 백업의 사용자 번역이 표시된다(어느 쪽도 삭제 안 함)', async () => {
    const { backup, userLines } = await deviceAWithUserTranslation();
    const b = await harness({ autoTranslate: true, ids: new PrefixedIds('b') });
    await b.session.onTrackChanged(TRACKS.jaStudio);
    await b.session.idle();
    expect(b.provider.calls).toHaveLength(1);
    const bSongId = b.session.current.song!.id;

    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    if (!parsed.ok) throw new Error(parsed.error);
    const report = await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    expect(report.linksRelinked).toBe(1);
    await b.session.reloadCurrent();
    await b.session.idle();

    expect(b.provider.calls).toHaveLength(1); // 가져오기·다시 열기로 AI를 부르지 않음
    expect(b.session.current.translation?.origin).toBe('user');
    expect(b.session.current.translation?.lines).toEqual(userLines);
    // 재설치 후 생긴 곡과 AI 번역도 그대로 남아 있다
    const bLyrics = await b.store.listLyricsVersions(bSongId);
    expect(bLyrics).toHaveLength(1);
    expect(await b.store.listTranslations(bLyrics[0]!.id)).toHaveLength(1);
  });

  it('[AT-15][REQ-ST-04][REQ-TR-06] 기기의 사용자 번역은 백업의 AI 번역으로 가려지지 않는다', async () => {
    // 백업 쪽: AI 번역만
    const a = await harness({ autoTranslate: true, ids: new PrefixedIds('a') });
    await a.session.onTrackChanged(TRACKS.jaStudio);
    await a.session.idle();
    const backup = JSON.stringify(await a.store.exportUserData(LATEST_SCHEMA_VERSION, a.clock.nowEpochMs()));
    // 기기 쪽: 사용자 번역(일부 행만)
    const b = await harness({ autoTranslate: false, ids: new PrefixedIds('b') });
    await b.session.onTrackChanged(TRACKS.jaStudio);
    await b.session.idle();
    const firstId = b.session.current.lyrics!.lines[0]!.id;
    await b.session.saveUserTranslation({ [firstId]: '내가 쓴 첫 줄' });

    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    if (!parsed.ok) throw new Error(parsed.error);
    const report = await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    expect(report.linksKept).toBe(1);
    await b.session.reloadCurrent();
    await b.session.idle();
    expect(b.session.current.translation?.origin).toBe('user');
    expect(b.session.current.translation?.lines).toEqual({ [firstId]: '내가 쓴 첫 줄' });
    expect(b.provider.calls).toHaveLength(0);
  });

  it('[AT-15][REQ-ST-04] 같은 백업을 두 번 가져와도 중복되지 않는다', async () => {
    const { backup } = await deviceAWithUserTranslation();
    const b = await harness({ ids: new PrefixedIds('b') });
    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    if (!parsed.ok) throw new Error(parsed.error);
    await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    const again = await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    expect(again).toMatchObject({
      songsAdded: 0,
      songsExisting: 1,
      lyricsAdded: 0,
      translationsAdded: 0,
      pronunciationsAdded: 0,
      linksAdded: 0,
      linksRelinked: 0,
      conflicts: 0,
    });
    const lv = (await b.store.listSongs())[0]!.activeLyricsVersionId!;
    expect(await b.store.listTranslations(lv)).toHaveLength(2);
  });

  it('[AT-15][REQ-ST-04][REQ-SEC-05][REQ-SEC-01] 자동 번역 동의·제공자 설정·키는 백업에 없고 가져와도 켜지지 않는다', async () => {
    const { a, backup } = await deviceAWithUserTranslation();
    await a.store.setProviderConfig({
      providerId: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'm',
      structuredOutput: true,
    });
    const backup2 = JSON.stringify(await a.store.exportUserData(LATEST_SCHEMA_VERSION, a.clock.nowEpochMs()));
    for (const text of [backup, backup2]) {
      expect(text).not.toContain('autoTranslate');
      expect(text).not.toContain('api.example.test');
      expect(text).not.toContain('provider.config');
    }
    // 누군가 파일에 동의·키를 끼워 넣어도 읽지 않는다
    const doctored = JSON.parse(backup2) as Record<string, unknown>;
    doctored['settings'] = {
      display: { showTranslation: true, showPronunciation: true },
      translation: { autoTranslate: true },
    };
    doctored['apiKey'] = ['sk', 'injected', 'Q7'.repeat(10)].join('-');
    const b = await harness({ ids: new PrefixedIds('b') });
    const parsed = parseBackup(JSON.stringify(doctored), LATEST_SCHEMA_VERSION);
    if (!parsed.ok) throw new Error(parsed.error);
    await b.store.importUserData(parsed.data, b.clock.nowEpochMs());
    expect((await b.store.getTranslationSettings()).autoTranslate).toBe(false);
    expect(await b.store.getProviderConfig()).toBeNull();
    const reexport = JSON.stringify(await b.store.exportUserData(LATEST_SCHEMA_VERSION, 0));
    expect(reexport).not.toContain('injected');
  });
});

describe('AT-16 손상·변조된 백업 거부', () => {
  async function backupObject(): Promise<UserDataExport> {
    const { backup } = await deviceAWithUserTranslation();
    return JSON.parse(backup) as UserDataExport;
  }

  it('[AT-16][REQ-ST-04][REQ-SEC-07][REQ-SY-01] 원문·타임스탬프가 바뀐 백업은 해시 검사로 거부한다', async () => {
    const base = await backupObject();
    const textChanged = structuredClone(base);
    textChanged.lyricsVersions[0]!.lines[0]!.text = '다른 원문';
    const timeChanged = structuredClone(base);
    timeChanged.lyricsVersions[0]!.lines[1]!.startMs! += 700;
    for (const bad of [textChanged, timeChanged]) {
      const r = parseBackup(JSON.stringify(bad), LATEST_SCHEMA_VERSION);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('해시');
    }
  });

  it('[AT-16][REQ-ST-04][REQ-SEC-07] 형식·참조·크기·버전 오류를 거부한다', async () => {
    const base = await backupObject();
    const cases: Array<[string, string]> = [
      ['not json', '{'],
      ['wrong format', JSON.stringify({ ...base, format: 'something-else' })],
      ['future schema', JSON.stringify({ ...base, schemaVersion: LATEST_SCHEMA_VERSION + 1 })],
      [
        'dangling translation',
        JSON.stringify({ ...base, translations: [{ ...base.translations[0]!, lyricsVersionId: 'lv_missing' }] }),
      ],
      [
        'unknown line id',
        JSON.stringify({
          ...base,
          translations: [{ ...base.translations[0]!, lines: { l9999: '없는 행' } }],
        }),
      ],
      ['dangling link', JSON.stringify({ ...base, serviceTracks: [{ ...base.serviceTracks[0]!, songId: 'nope' }] })],
      ['offset range', JSON.stringify({ ...base, syncOffsets: [{ songId: base.songs[0]!.id, offsetMs: 999_999 }] })],
      ['too large', ' '.repeat(BACKUP_LIMITS.maxChars + 1)],
    ];
    for (const [name, text] of cases) {
      const r = parseBackup(text, LATEST_SCHEMA_VERSION);
      expect(r.ok, name).toBe(false);
    }
  });

  it('[AT-16][REQ-ST-04][REQ-TR-09] 가져오기 도중 저장이 실패하면 아무것도 반영되지 않는다(원자적)', async () => {
    const base = await backupObject();
    const parsed = parseBackup(JSON.stringify(base), LATEST_SCHEMA_VERSION);
    if (!parsed.ok) throw new Error(parsed.error);
    const b = await harness({ ids: new PrefixedIds('b') });
    const realRun = b.driver.run.bind(b.driver);
    b.driver.run = async (sql, params) => {
      if (sql.includes('INSERT INTO pronunciations')) throw new Error('디스크 가득 참(가짜)');
      return realRun(sql, params);
    };
    await expect(b.store.importUserData(parsed.data, 0)).rejects.toThrow('디스크');
    b.driver.run = realRun;
    expect(await b.store.listSongs()).toHaveLength(0);
    expect(await b.store.listServiceTracks()).toHaveLength(0);
  });
});

describe('사용자 발음 편집', () => {
  it('[REQ-ED-03][REQ-TR-03][REQ-TR-07] 바꾼 행만 kana를 비우고, 새 사용자 버전으로 저장하며 AI를 부르지 않는다', async () => {
    const h = await harness({ autoTranslate: true });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    expect(h.provider.calls).toHaveLength(1);
    const lv = h.session.current.lyrics!;
    const ai = h.session.current.pronunciation!;
    expect(ai.origin).toBe('ai');
    const jaIds = Object.keys(ai.lines);
    expect(jaIds.length).toBeGreaterThan(1);
    const [first, second] = jaIds as [string, string];

    const edited: Record<string, string> = {};
    for (const id of jaIds) edited[id] = ai.lines[id]!.hangul;
    edited[first] = '내가 고친 발음';
    edited[second] = ''; // 비우면 그 행은 발음 없음
    const saved = await h.session.saveUserPronunciation(edited);
    expect(saved.ok).toBe(true);
    await h.session.idle();

    const cur = h.session.current.pronunciation!;
    expect(cur.origin).toBe('user');
    expect(cur.lines[first]).toEqual({ kana: null, hangul: '내가 고친 발음' });
    expect(cur.lines[second]).toBeUndefined();
    const third = jaIds[2];
    if (third) expect(cur.lines[third]).toEqual(ai.lines[third]);
    expect(h.provider.calls).toHaveLength(1);
    expect((await h.store.listPronunciations(lv.id)).map((p) => p.origin)).toEqual(['ai', 'user']);

    // 재실행 후에도 사용자 발음 유지, 발음 생성 버튼(명시 요청)이 아니면 AI 호출 없음
    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(TRACKS.jaStudio);
    await h2.session.idle();
    expect(h2.session.current.pronunciation?.origin).toBe('user');
    expect(h2.provider.calls).toHaveLength(0);
  });

  it('[REQ-ED-03] 일본어 문자가 없는 행·알 수 없는 행 ID·빈 입력 처리', async () => {
    const h = await harness({ autoTranslate: false });
    await h.session.onTrackChanged(TRACKS.jaStudio);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    expect(buildUserPronunciation(lv, { nope: '가' }, null).ok).toBe(false);
    expect(buildUserPronunciation(lv, {}, null).ok).toBe(false);
    const latin = lv.lines.find((l) => l.text.trim() !== '' && !/[぀-ヿ一-鿿]/u.test(l.text));
    if (latin) {
      const r = buildUserPronunciation(lv, { [latin.id]: '라틴' }, null);
      expect(r.ok).toBe(false); // 일본어 행이 아니면 저장 대상이 아님
    }
    const jaLine = lv.lines.find((l) => /[぀-ヿ]/u.test(l.text))!;
    const r = buildUserPronunciation(lv, { [jaLine.id]: '  요아케\t노 호무 ' }, null);
    expect(r.ok && r.lines[jaLine.id]).toEqual({ kana: null, hangul: '요아케 노 호무' });
  });
});
