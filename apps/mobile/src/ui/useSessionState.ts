import { useEffect, useState } from 'react';
import type { NowPlayingSession, SessionState } from '@lyrics-companion/core';

export function useSessionState(session: NowPlayingSession): SessionState {
  const [state, setState] = useState(session.current);
  useEffect(() => {
    setState(session.current);
    const unsubscribe = session.subscribe(setState);
    return () => {
      unsubscribe();
    };
  }, [session]);
  return state;
}
