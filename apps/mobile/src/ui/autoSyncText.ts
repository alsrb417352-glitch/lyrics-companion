import { useEffect, useState } from 'react';
import type {
  AutoSyncItem,
  AutoSyncItemStatus,
  AutoSyncRunner,
  AutoSyncState,
  AutoSyncStop,
  ListenNotReady,
} from '@lyrics-companion/core';

/** 소리로 싱크 맞추기(D-44) 화면 문구 — 지금 곡 화면과 플레이리스트 화면이 같이 쓴다 */

export function useAutoSyncState(runner: AutoSyncRunner): AutoSyncState {
  const [state, setState] = useState(runner.current);
  useEffect(() => {
    setState(runner.current);
    return runner.subscribe(setState);
  }, [runner]);
  return state;
}

export const NOT_READY_TEXT: Record<ListenNotReady, string> = {
  unsupported: '이 iPhone은 기기 안 음성 인식(소리로 싱크 맞추기)을 지원하지 않습니다.',
  'os-too-old': 'iOS 26 이상에서만 쓸 수 있습니다. 설정 › 일반 › 소프트웨어 업데이트를 확인해 주세요.',
  'locale-unsupported': '이 가사 언어는 기기 음성 인식이 지원하지 않습니다.',
  'model-download-failed':
    '음성 인식 언어 모델을 내려받지 못했습니다. 인터넷 연결과 저장 공간을 확인하고 다시 시도해 주세요.',
  'mic-denied': '마이크 권한이 꺼져 있습니다. 설정 앱 › 개인정보 보호 및 보안 › 마이크에서 이 앱을 켜 주세요.',
  'mic-undetermined': '시작하면 마이크 사용 허락을 묻습니다(들은 소리는 저장·전송하지 않음).',
  'model-missing': '시작하면 음성 인식 언어 모델을 한 번 내려받습니다(OS가 내려받음).',
  headphones: '이어폰·블루투스로 재생 중이면 마이크가 소리를 듣지 못합니다. 연결을 끊고 iPhone 스피커로 재생해 주세요.',
  busy: '다른 앱이 마이크를 쓰는 중입니다. 잠시 뒤 다시 시도해 주세요.',
};

export const ITEM_TEXT: Record<AutoSyncItemStatus, string> = {
  saved: '맞춤',
  instrumental: '연주곡',
  'no-lines': '맞출 줄 없음',
  'nothing-heard': '소리를 거의 못 들음',
  'too-few-matches': '가사와 충분히 맞지 않음',
  'too-long': '너무 김',
  'no-lyrics': '가사 없음',
  'already-synced': '이미 싱크 있음',
  'has-timing': '이미 싱크 기록 있음',
  'unsupported-language': '지원하지 않는 언어',
  'not-ready': '준비 실패',
  changed: '듣는 동안 가사가 바뀜',
  cancelled: '멈춤',
  'not-played': '재생 안 됨',
  duplicate: '중복',
  error: '오류',
};

/** 한 곡 결과 설명 */
export function itemMessage(item: AutoSyncItem): string {
  const st = item.stats;
  switch (item.status) {
    case 'saved':
      return st
        ? `${st.totalLines}줄 중 ${st.heardLines}줄은 소리로 찾고 ${st.filledLines}줄은 그 사이를 글자 수로 채웠습니다${
            st.untimedLines > 0 ? `(듣지 않은 뒤 ${st.untimedLines}줄은 시간 없음)` : ''
          }.`
        : '소리로 맞춘 싱크를 저장했습니다.';
    case 'nothing-heard':
      return '알아들은 소리가 거의 없어 저장하지 않았습니다. 이어폰을 빼고 iPhone 스피커로, 소리를 조금 크게 해서 다시 해 보세요.';
    case 'too-few-matches':
      return `알아들은 말이 가사와 충분히 맞지 않아 저장하지 않았습니다${
        st ? `(소리로 찾은 줄 ${st.heardLines}/${st.totalLines})` : ''
      }. 조용한 곳에서 다시 하거나 "싱크 직접 기록"을 써 주세요. 가사가 이 곡과 맞는지도 확인해 주세요.`;
    case 'has-timing':
      return '이미 직접 기록한 싱크가 있어 바꾸지 않았습니다.';
    case 'already-synced':
      return '원래 시간 정보가 있는 가사라 맞출 필요가 없습니다.';
    case 'no-lyrics':
      return '저장된 가사가 없습니다.';
    case 'changed':
      return '듣는 동안 가사가 바뀌어 저장하지 않았습니다.';
    case 'cancelled':
      return '저장하지 않고 멈췄습니다.';
    default:
      return ITEM_TEXT[item.status];
  }
}

export function stopText(
  stop: AutoSyncStop | null,
  notReady: ListenNotReady | null,
  error: string | null,
): string | null {
  switch (stop) {
    case 'not-ready':
    case 'headphones':
      return notReady ? NOT_READY_TEXT[notReady] : NOT_READY_TEXT.headphones;
    case 'listener-error':
      return error ?? '듣기 중 오류가 났습니다.';
    case 'track-changed':
      return '다른 곡이 재생되어 멈췄습니다. 끝까지 들은 곡은 저장했습니다.';
    case 'cancelled':
      return '멈췄습니다. 끝까지 들은 곡은 저장했습니다.';
    default:
      return null;
  }
}

export function mmss(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-:--';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 소리가 너무 작음(마이크에 거의 안 들림) */
export function tooQuiet(levelDb: number | null): boolean {
  return levelDb !== null && levelDb < -55;
}
