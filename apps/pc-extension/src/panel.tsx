import { createRoot } from 'react-dom/client';
import type { SqlJsStatic } from 'sql.js';
import { FetchHttpClient } from './adapters/http';
import { NativeSecretStore } from './adapters/native-secret-store';
import { IdbFileStore } from './adapters/sqljs-driver';
import { SystemClock } from './adapters/system';
import { TabsPlayback } from './adapters/web-playback';
import { createAppServices, type HostPermissions } from './services';
import { App, type BootState } from './ui/App';

/**
 * 확장 프로그램 패널 진입점(사이드 패널 panel.html, 또는 따로 띄운 창 panel.html?window=1).
 * 저장소(IndexedDB 안의 SQLite 파일)를 한 곳에서만 고치도록 Web Locks로 한 화면만 연다.
 */

declare global {
  interface Window {
    initSqlJs?: (config: { locateFile: (file: string) => string }) => Promise<SqlJsStatic>;
  }
}

const LOCK = 'lyrics-companion-db';
const isWindow = new URLSearchParams(location.search).has('window');

const permissions: HostPermissions = {
  has: (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] }),
  request: (origin) => chrome.permissions.request({ origins: [`${origin}/*`] }),
};

/** 저장소 잠금을 얻으면 앱이 닫힐 때까지 쥐고 있는다. 얻지 못하면 null. */
function acquireLock(waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), waitMs);
    navigator.locks
      .request(LOCK, { signal: ctrl.signal }, () => {
        clearTimeout(timer);
        resolve(true);
        return new Promise<void>(() => undefined); // 페이지가 닫힐 때 자동으로 풀린다
      })
      .catch(() => resolve(false));
  });
}

async function boot(): Promise<BootState> {
  // 따로 띄운 창은 사이드 패널이 닫히며 잠금을 놓을 때까지 잠시 기다린다.
  if (!(await acquireLock(isWindow ? 4_000 : 1_500))) return { kind: 'busy-elsewhere' };
  if (!window.initSqlJs) throw new Error('SQLite 모듈을 불러오지 못했습니다');
  const sqlJs = await window.initSqlJs({ locateFile: (f) => chrome.runtime.getURL(f) });
  // 저장 공간이 부족해도 브라우저가 이 데이터를 지우지 않게 요청한다(unlimitedStorage 권한과 함께).
  void navigator.storage?.persist?.().catch(() => false);
  const files = await IdbFileStore.open();
  const secrets = new NativeSecretStore();
  const services = await createAppServices({
    sqlJs,
    files,
    secrets,
    secretStatus: () => secrets.status(),
    playback: new TabsPlayback(new SystemClock()),
    http: new FetchHttpClient(),
    permissions,
  });
  return { kind: 'ready', services };
}

async function openWindow(): Promise<void> {
  await chrome.windows.create({
    url: chrome.runtime.getURL('panel.html?window=1'),
    type: 'popup',
    width: 460,
    height: 820,
  });
  // 사이드 패널을 닫아 저장소 잠금을 넘겨준다.
  window.close();
}

if (isWindow) document.documentElement.classList.add('as-window');
createRoot(document.getElementById('root')!).render(
  <App boot={boot} {...(isWindow ? {} : { onOpenWindow: () => void openWindow() })} />,
);
