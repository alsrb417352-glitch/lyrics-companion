import { useEffect, useState } from 'react';
import type { AppServices } from '../services';
import { IconButton, Note } from './common';
import { Icon, type IconName } from './icons';
import { NowPlaying } from './NowPlaying';
import { QueueTab } from './QueueTab';
import { Settings } from './Settings';
import { usePlayback } from './usePlayback';

type Tab = 'now' | 'queue' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'now', label: '지금 재생', icon: 'note' },
  { id: 'queue', label: '대기열', icon: 'queue' },
  { id: 'settings', label: '설정', icon: 'settings' },
];

function Main(props: { services: AppServices; onOpenWindow?: () => void }) {
  const { services } = props;
  const [tab, setTab] = useState<Tab>('now');
  const playback = usePlayback(services);
  return (
    <div className="app">
      <nav className="tabs" role="tablist" aria-label="화면">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' tab-on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={18} />
            <span>{t.label}</span>
          </button>
        ))}
        <span className="grow" />
        {props.onOpenWindow ? (
          <IconButton
            icon="window"
            label="따로 띄운 창으로 열기(다른 모니터에 둘 수 있음)"
            size={32}
            iconSize={18}
            onClick={props.onOpenWindow}
          />
        ) : null}
      </nav>
      <main className="tab-body" role="tabpanel">
        {tab === 'now' ? <NowPlaying services={services} playback={playback} /> : null}
        {tab === 'queue' ? (
          <QueueTab services={services} playback={playback} onOpenNowPlaying={() => setTab('now')} />
        ) : null}
        {tab === 'settings' ? <Settings services={services} /> : null}
      </main>
    </div>
  );
}

export type BootState =
  | { kind: 'loading' }
  | { kind: 'ready'; services: AppServices }
  | { kind: 'busy-elsewhere' }
  | { kind: 'error'; message: string };

export function App(props: { boot: () => Promise<BootState>; onOpenWindow?: () => void }) {
  const [state, setState] = useState<BootState>({ kind: 'loading' });
  useEffect(() => {
    props.boot().then(setState, (e: unknown) =>
      // 저장소 마이그레이션 실패 등. 원문 오류에는 비밀정보가 없지만 길이를 제한해 보여 준다.
      setState({ kind: 'error', message: e instanceof Error ? e.message.slice(0, 300) : '초기화 실패' }),
    );
    // boot는 처음 한 번만 실행한다(저장소를 두 번 열지 않음)
  }, []);

  if (state.kind === 'ready')
    return <Main services={state.services} {...(props.onOpenWindow ? { onOpenWindow: props.onOpenWindow } : {})} />;
  return (
    <div className="center-box full">
      {state.kind === 'loading' ? <Note>불러오는 중…</Note> : null}
      {state.kind === 'busy-elsewhere' ? (
        <Note>
          가사 보조가 다른 창(사이드 패널 또는 따로 띄운 창)에서 이미 열려 있습니다. 같은 저장소를 두 곳에서 동시에
          고치지 않도록 한 곳에서만 엽니다. 다른 쪽을 닫은 뒤 이 창을 다시 열어 주세요.
        </Note>
      ) : null}
      {state.kind === 'error' ? <Note tone="danger">시작하지 못했습니다: {state.message}</Note> : null}
    </div>
  );
}
