import type { MusicKitItemRaw, MusicKitSnapshotRaw } from '@lyrics-companion/core';

/**
 * 확장 프로그램 안 메시지 형식.
 *
 *   [music.apple.com 페이지(MAIN world): page-bridge] --window.postMessage--> [relay(ISOLATED)] --Port 'lc-tab'--> [가사 패널]
 *
 * - page-bridge는 MusicKit 값을 가공하지 않고 넘긴다(해석·검증은 core musickit-web.ts).
 * - 페이지 쪽 메시지는 페이지의 다른 스크립트도 만들 수 있으므로 패널은 모두 불신 데이터로 다룬다.
 * - 패널은 페이지로 API 키·저장 데이터 등 아무것도 보내지 않는다(재생 제어 명령만).
 */

export const TAG = 'lc-v1';
export const TAB_PORT = 'lc-tab';

export type PageCommand = 'play' | 'pause' | 'seek' | 'next' | 'prev' | 'playAt' | 'queue';

export interface QueueRaw {
  items: MusicKitItemRaw[];
  /** queue.position(지금 재생 중인 항목 위치) */
  position: unknown;
}

/** page-bridge → relay (window.postMessage) */
export type PageMessage =
  | { __lc: typeof TAG; from: 'page'; kind: 'state'; raw: MusicKitSnapshotRaw; sentAt: number; queue?: QueueRaw }
  | { __lc: typeof TAG; from: 'page'; kind: 'status'; musicKit: 'ready' | 'missing' }
  | { __lc: typeof TAG; from: 'page'; kind: 'result'; id: number; ok: boolean; error?: string; queue?: QueueRaw };

/** relay → page-bridge (window.postMessage) */
export type RelayMessage =
  | { __lc: typeof TAG; from: 'relay'; kind: 'watch'; on: boolean }
  | { __lc: typeof TAG; from: 'relay'; kind: 'command'; id: number; cmd: PageCommand; arg?: number };

/** relay ↔ 패널 (Port) — page/relay 메시지에서 __lc·from을 뺀 것 */
export type TabToPanel =
  | { kind: 'state'; raw: unknown; sentAt: unknown; queue?: unknown }
  | { kind: 'status'; musicKit: unknown }
  | { kind: 'result'; id: unknown; ok: unknown; error?: unknown; queue?: unknown };

export type PanelToTab =
  { kind: 'watch'; on: boolean } | { kind: 'command'; id: number; cmd: PageCommand; arg?: number };

/** 패널이 Apple Music 탭의 relay에게 "연결해 달라"고 보내는 메시지(chrome.tabs.sendMessage) */
export const CONNECT_REQUEST = { kind: 'lc-connect' } as const;

export function isPageMessage(v: unknown): v is PageMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __lc?: unknown }).__lc === TAG &&
    (v as { from?: unknown }).from === 'page'
  );
}

export function isRelayMessage(v: unknown): v is RelayMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __lc?: unknown }).__lc === TAG &&
    (v as { from?: unknown }).from === 'relay'
  );
}

/** 패널이 받은 대기열 원시 값 검증(크기 제한). 항목 해석은 core mapMusicKitQueue. */
export function readQueueRaw(v: unknown): { items: unknown[]; position: number | null } | null {
  if (typeof v !== 'object' || v === null) return null;
  const items = (v as { items?: unknown }).items;
  const pos = (v as { position?: unknown }).position;
  if (!Array.isArray(items)) return null;
  return {
    items: items.slice(0, 1000),
    position: typeof pos === 'number' && Number.isInteger(pos) && pos >= 0 ? pos : null,
  };
}
