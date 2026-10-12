/**
 * PC(Windows Chrome/Edge) Apple Music 웹 플레이어 수용 테스트(AT-21).
 * 확장 프로그램의 페이지 스크립트가 넘기는 MusicKit 원시 값(합성)을 core 변환 → 세션 → 싱크까지 그대로 통과시킨다.
 * iPhone에서 저장한 데이터를 백업 파일로 PC에 옮기면 같은 곡(같은 스토어 ID)으로 바로 연결되어야 한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness.js';
import { mapMusicKitSnapshot, type MusicKitSnapshotRaw } from '../../src/playback/musickit-web.js';
import { mapIosTrack } from '../../src/playback/ios-system-player.js';
import { parseBackup } from '../../src/backup/backup-file.js';
import { LATEST_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import type { IdGenerator } from '../../src/ports.js';

class PrefixedIds implements IdGenerator {
  private n = 0;
  constructor(private readonly tag: string) {}
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.tag}${this.n}`;
  }
}

/** 합성 곡(fixtures/lrclib/get-ja-synced.json, 실제 곡 아님): 12.00 / 17.50 / 23.00 / (28.40 빈 행) / 30.00 … */
const RAW: MusicKitSnapshotRaw = {
  item: {
    id: '900000001',
    type: 'song',
    title: '夜明けのホーム',
    artist: 'Synthetic Band',
    album: 'Test Album',
    durationMs: 210_000,
    isrc: 'JPZZ02600001',
    playParamsId: '900000001',
    playParamsKind: 'song',
  },
  state: 2,
  mkTimeSec: 18,
  elementTimeSec: 18.2,
  elementRate: 1,
  previewOnly: false,
};

const open: Harness[] = [];
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  open.push(h);
  return h;
}

describe('AT-21 PC Apple Music 웹 플레이어', () => {
  it('[AT-21][REQ-PC-01][REQ-SY-01][REQ-SY-02] 웹 플레이어 스냅샷으로 현재 행을 맞추고, 미리듣기·불러오는 중이면 진행을 꾸며내지 않는다', async () => {
    const h = await harness({ autoTranslate: false });
    const snap = mapMusicKitSnapshot(RAW, h.clock.monotonicMs());
    await h.session.onTrackChanged(snap.track!);
    await h.session.idle();
    const lv = h.session.current.lyrics!;
    expect(h.session.current.phase).toBe('ready');

    // 18.2초 → 둘째 줄(17.50)
    let r = h.session.syncFor(snap);
    expect(r.mode).toBe('synced');
    if (r.mode === 'synced') expect(lv.lines[r.activeIndex!]!.text).toBe('まだ ねむい まちのなか');
    // 5초 뒤 → 셋째 줄(23.00)
    h.clock.advance(5_000);
    r = h.session.syncFor(snap);
    if (r.mode === 'synced') expect(lv.lines[r.activeIndex!]!.text).toBe('光の中へ走り出す');

    // 미리듣기: 위치 모름(강조 없음)
    const preview = mapMusicKitSnapshot({ ...RAW, previewOnly: true }, h.clock.monotonicMs());
    expect(h.session.syncFor(preview)).toEqual({ mode: 'unknown', reason: 'no-position' });
    expect(h.session.screen(preview)!.rows.some((row) => row.state === 'active')).toBe(false);

    // 불러오는 중(대기 8): 위치는 측정값 그대로, 시간이 지나도 앞으로 가지 않음
    const waiting = mapMusicKitSnapshot({ ...RAW, state: 8 }, h.clock.monotonicMs());
    const before = h.session.syncFor(waiting);
    h.clock.advance(10_000);
    const after = h.session.syncFor(waiting);
    expect(before).toMatchObject({ mode: 'synced', positionMs: 18_200 });
    expect(after).toMatchObject({ mode: 'synced', positionMs: 18_200, isPlaying: false });
  });

  it('[AT-21][REQ-PC-01][REQ-ST-04][REQ-TR-05] iPhone에서 저장한 내 번역을 백업으로 PC에 옮기면 웹 플레이어 재생 시 가사 조회·AI 호출 없이 바로 보인다', async () => {
    // iPhone: Music 앱에서 같은 스토어 ID의 곡을 재생 → 내 번역 저장 → 백업
    const phone = await harness({ ids: new PrefixedIds('i'), autoTranslate: false });
    const iosTrack = mapIosTrack({
      hasItem: true,
      title: '夜明けのホーム',
      artist: 'Synthetic Band',
      album: 'Test Album',
      durationSec: 210,
      storeId: '900000001',
    })!;
    await phone.session.onTrackChanged(iosTrack);
    await phone.session.idle();
    const lv = phone.session.current.lyrics!;
    const mapping: Record<string, string> = {};
    lv.lines.forEach((l, i) => {
      if (l.text.trim()) mapping[l.id] = `내 번역 ${i}`;
    });
    expect((await phone.session.saveUserTranslation(mapping)).ok).toBe(true);
    const backup = JSON.stringify(await phone.store.exportUserData(LATEST_SCHEMA_VERSION, phone.clock.nowEpochMs()));

    // PC: 자동 번역을 켜 둔 새 설치본에 백업을 가져온 뒤 웹 플레이어에서 재생
    const pc = await harness({ ids: new PrefixedIds('w'), autoTranslate: true });
    const parsed = parseBackup(backup, LATEST_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await pc.store.importUserData(parsed.data, pc.clock.nowEpochMs());

    const snap = mapMusicKitSnapshot(RAW, pc.clock.monotonicMs());
    await pc.session.onTrackChanged(snap.track!);
    await pc.session.idle();

    expect(pc.session.current.phase).toBe('ready');
    expect(pc.session.current.translation?.origin).toBe('user');
    expect(pc.session.current.lyrics?.id).toBe(lv.id);
    expect(pc.http.calls).toHaveLength(0); // LRCLIB 재조회 없음
    expect(pc.provider.calls).toHaveLength(0); // AI 호출 없음(자동 번역이 켜져 있어도)
    expect(await pc.store.listSongs()).toHaveLength(1); // 같은 곡으로 연결(새 곡을 만들지 않음)
    const screen = pc.session.screen(snap)!;
    expect(screen.rows.find((row) => row.state === 'active')?.translation).toBe('내 번역 1');
  });
});
