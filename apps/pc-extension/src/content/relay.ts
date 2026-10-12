import { isPageMessage, TAB_PORT, TAG, type PanelToTab, type RelayMessage, type TabToPanel } from '../shared/protocol';

/**
 * Apple Music 탭의 확장 프로그램 쪽(ISOLATED world) 중계. page-bridge(MAIN world)와 가사 패널을 잇는다.
 * - 패널이 열려 있을 때만 연결한다(패널이 열리면 'lc-connect'를 보내 온다). 연결이 끊기면 page-bridge에 멈추라고 알린다.
 * - 페이지 메시지는 형식만 거르고 그대로 전달한다(검증은 패널·core).
 */

declare global {
  interface Window {
    __lcRelay?: boolean;
  }
}

function toPage(msg: RelayMessage): void {
  window.postMessage(msg, location.origin);
}

function start(): void {
  if (window.__lcRelay) return;
  window.__lcRelay = true;
  let port: chrome.runtime.Port | null = null;

  const connect = () => {
    if (port) return;
    // 확장 프로그램을 다시 불러온 뒤 남은 옛 스크립트는 chrome.runtime을 쓸 수 없다.
    if (!chrome.runtime?.id) return;
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connect({ name: TAB_PORT });
    } catch {
      return;
    }
    port = p;
    p.onMessage.addListener((m: PanelToTab) => {
      if (m.kind === 'watch') toPage({ __lc: TAG, from: 'relay', kind: 'watch', on: m.on === true });
      else if (m.kind === 'command')
        toPage({ __lc: TAG, from: 'relay', kind: 'command', id: m.id, cmd: m.cmd, arg: m.arg });
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // 패널이 없을 때 생기는 오류 표시를 막는다
      port = null;
      toPage({ __lc: TAG, from: 'relay', kind: 'watch', on: false });
    });
  };

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== location.origin || !port || !isPageMessage(e.data)) return;
    const m = e.data;
    let out: TabToPanel;
    if (m.kind === 'state')
      out = { kind: 'state', raw: m.raw, sentAt: m.sentAt, ...(m.queue ? { queue: m.queue } : {}) };
    else if (m.kind === 'status') out = { kind: 'status', musicKit: m.musicKit };
    else out = { kind: 'result', id: m.id, ok: m.ok, error: m.error, ...(m.queue ? { queue: m.queue } : {}) };
    try {
      port.postMessage(out);
    } catch {
      port = null;
    }
  });

  chrome.runtime.onMessage.addListener((m: unknown, _sender, sendResponse) => {
    if (typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === 'lc-connect') {
      connect();
      // 답을 보내야 패널이 "스크립트 없는 탭"으로 오해해 다시 넣지 않는다.
      sendResponse({ ok: true });
    }
  });

  // 패널이 이미 열려 있으면 바로 연결된다(없으면 곧바로 끊기고, 패널이 열릴 때 다시 요청이 온다).
  connect();
}

start();
