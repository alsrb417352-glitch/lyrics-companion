/**
 * 백그라운드에서 가사 찾기·자동 번역 수용 테스트(AT-26, REQ-PB-09, docs/plan.md D-45).
 * 앱이 백그라운드에 있어도(소리 없는 오디오로 깨어 있는 동안) 재생 상태 따라가기 → 곡 식별 → 가사 조회 →
 * 자동 번역 정책이 화면에 보일 때와 똑같이 진행되는지, 그리고 언제 깨어 있고 언제 놓는지 확인한다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TRACKS, type Harness } from '../support/harness.js';
import {
  BACKGROUND_RULES,
  KeepAlivePolicy,
  parseKeepAliveSetting,
  PlaybackFollower,
  playbackPollMs,
} from '../../src/playback/background.js';
import type { PlaybackSnapshot, PlaybackStatus, ServiceTrackRef } from '../../src/ports.js';

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

function snap(
  h: Harness,
  track: ServiceTrackRef | null,
  status: PlaybackStatus,
  positionMs = 10_000,
): PlaybackSnapshot {
  return {
    track,
    status,
    positionMs: track ? positionMs : null,
    capturedAtMonotonicMs: h.clock.monotonicMs(),
    rate: status === 'playing' ? 1 : 0,
  };
}

/** 앱의 재생 따라가기(usePlayback)를 백그라운드 조건으로 흉내: 유지 중이면 3초마다 읽는다 */
function backgroundApp(h: Harness, enabled = true) {
  const policy = new KeepAlivePolicy();
  const follower = new PlaybackFollower({ session: h.session, clock: h.clock, policy });
  const keepAlive = () => policy.decide({ enabled, autoSyncRunning: false }, h.clock.monotonicMs()).on;
  return { policy, follower, keepAlive };
}

describe('AT-26 백그라운드에서 가사 찾기·자동 번역', () => {
  it('[AT-26][REQ-PB-09][REQ-TR-13] 앱이 백그라운드여도 깨어 있는 동안 곡이 바뀌면 가사를 찾고 자동 번역(켜져 있을 때)까지 저장한다', async () => {
    const h = await harness({ autoTranslate: true });
    const app = backgroundApp(h);
    // 화면을 보던 중 첫 곡 재생 → 유지 켜짐
    app.follower.push(snap(h, TRACKS.jaStudio, 'playing'));
    await app.follower.idle();
    await h.session.idle();
    expect(app.keepAlive()).toBe(true);
    // 다른 앱으로 이동(백그라운드): 유지 중이므로 3초마다 읽는다
    expect(playbackPollMs({ appActive: false, keepAlive: app.keepAlive(), foregroundMs: 250 })).toBe(
      BACKGROUND_RULES.backgroundPollMs,
    );
    const aiBefore = h.provider.calls.length;
    h.clock.advance(BACKGROUND_RULES.backgroundPollMs);
    app.follower.push(snap(h, TRACKS.enStudio, 'playing', 1_000)); // 다음 곡
    await app.follower.idle();
    await h.session.idle();
    expect(h.session.current.track?.serviceTrackId).toBe(TRACKS.enStudio.serviceTrackId);
    expect(h.session.current.lyrics).not.toBeNull();
    expect(h.provider.calls.length).toBe(aiBefore + 1);
    expect(h.session.current.translation?.origin).toBe('ai');
    // 나중에 화면을 열면 저장본으로 바로(네트워크·AI 추가 호출 없음)
    const httpBefore = h.http.calls.length;
    const h2 = await h.restart();
    open.push(h2);
    await h2.session.onTrackChanged(TRACKS.enStudio);
    await h2.session.idle();
    expect(h2.http.calls.length).toBe(0);
    expect(h2.provider.calls).toHaveLength(0);
    expect(h2.session.current.translation?.origin).toBe('ai');
    expect(httpBefore).toBeGreaterThan(0);
  });

  it('[AT-26][REQ-PB-09][REQ-TR-13] 자동 번역이 꺼져 있으면 백그라운드에서도 가사만 찾고 AI는 부르지 않는다. 같은 곡 측정이 이어져도 다시 찾지 않는다', async () => {
    const h = await harness({ autoTranslate: false });
    const app = backgroundApp(h);
    app.follower.push(snap(h, TRACKS.jaStudio, 'playing'));
    await app.follower.idle();
    await h.session.idle();
    expect(h.session.current.lyrics).not.toBeNull();
    const http = h.http.calls.length;
    for (let i = 0; i < 20; i++) {
      h.clock.advance(BACKGROUND_RULES.backgroundPollMs);
      app.follower.push(snap(h, TRACKS.jaStudio, 'playing', 10_000 + (i + 1) * 3_000));
    }
    await app.follower.idle();
    await h.session.idle();
    expect(h.http.calls.length).toBe(http);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('[AT-26][REQ-PB-09] 재생 중이거나 멈춘 지 10분 안이면 유지, 오래 멈추면 놓는다. 설정을 끄거나 소리로 싱크 맞추기 중이면 유지하지 않는다', () => {
    let now = 0;
    const p = new KeepAlivePolicy();
    const s = (status: PlaybackStatus, track: ServiceTrackRef | null = TRACKS.jaStudio): PlaybackSnapshot => ({
      track,
      status,
      positionMs: 0,
      capturedAtMonotonicMs: now,
      rate: 1,
    });
    const on = (o: { enabled?: boolean; autoSyncRunning?: boolean } = {}) =>
      p.decide({ enabled: o.enabled ?? true, autoSyncRunning: o.autoSyncRunning ?? false }, now);
    expect(on()).toEqual({ on: false, reason: 'never-played' });
    p.observe(s('playing'), now);
    expect(on()).toEqual({ on: true, reason: 'playing' });
    expect(on({ enabled: false })).toEqual({ on: false, reason: 'disabled' });
    expect(on({ autoSyncRunning: true })).toEqual({ on: false, reason: 'auto-sync' });
    now += 60 * 60_000; // 한 시간 계속 재생
    p.observe(s('playing'), now);
    expect(on().on).toBe(true);
    p.observe(s('paused'), now);
    now += BACKGROUND_RULES.idleMs - 1_000;
    p.observe(s('paused'), now);
    expect(on()).toEqual({ on: true, reason: 'recently-playing' });
    // 상태를 모르는 측정은 판단을 바꾸지 않는다
    p.observe(s('unknown'), now);
    expect(on().on).toBe(true);
    now += 2_000;
    expect(on()).toEqual({ on: false, reason: 'idle' });
    // 다시 재생하면 유지
    p.observe(s('playing'), now);
    expect(on().on).toBe(true);
    // 곡이 없어짐(재생 목록 끝) → 그때부터 10분
    p.observe(s('stopped', null), now);
    expect(on()).toEqual({ on: true, reason: 'recently-playing' });
    now += BACKGROUND_RULES.idleMs + 1;
    expect(on().on).toBe(false);
  });

  it('[AT-26][REQ-PB-09] 재조회 간격: 화면에 보이면 짧게, 백그라운드는 유지 중일 때만 3초, 아니면 읽지 않음. 설정 기본값은 켜짐', async () => {
    expect(playbackPollMs({ appActive: true, keepAlive: false, foregroundMs: 250 })).toBe(250);
    expect(playbackPollMs({ appActive: false, keepAlive: true, foregroundMs: 250 })).toBe(3_000);
    expect(playbackPollMs({ appActive: false, keepAlive: false, foregroundMs: 250 })).toBeNull();
    expect(parseKeepAliveSetting(null)).toBe(true);
    expect(parseKeepAliveSetting('false')).toBe(false);
    const h = await harness();
    expect(await h.store.getBackgroundKeepAlive()).toBe(true);
    await h.store.setBackgroundKeepAlive(false);
    const h2 = await h.restart();
    open.push(h2);
    expect(await h2.store.getBackgroundKeepAlive()).toBe(false);
    // 기기 설정이라 백업에 넣지 않는다
    const exported = JSON.stringify(await h2.store.exportUserData(5, 0));
    expect(exported).not.toContain('keep_alive');
  });
});
