import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  BACKUP_LIMITS,
  backupFileName,
  LATEST_SCHEMA_VERSION,
  parseBackup,
  type BackupParseResult,
  type Clock,
  type LyricsStore,
} from '@lyrics-companion/core';

/**
 * 백업 파일 입출력(iOS). 판단·검증은 core(parseBackup·importUserData)가 하고, 여기서는 파일만 다룬다.
 * - 내보내기: 앱 캐시에 JSON을 쓰고 iOS 공유 시트를 연다 → 사용자가 "파일에 저장"(iCloud Drive·나의 iPhone) 선택.
 *   공유가 끝나면 캐시 사본을 지운다. 앱이 직접 외부로 보내지 않는다.
 * - 가져오기: iOS 파일 선택기 → 읽기만 한다(선택한 파일은 바꾸거나 지우지 않음).
 * 백업에는 API 키·제공자 설정·자동 번역 동의가 없다(core가 넣지 않음).
 */

export async function exportBackup(store: LyricsStore, clock: Clock): Promise<{ fileName: string; bytes: number }> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('이 기기에서는 공유 시트를 열 수 없습니다');
  const data = await store.exportUserData(LATEST_SCHEMA_VERSION, clock.nowEpochMs());
  const text = JSON.stringify(data);
  const now = new Date(clock.nowEpochMs());
  const fileName = backupFileName({
    y: now.getFullYear(),
    mo: now.getMonth() + 1,
    d: now.getDate(),
    h: now.getHours(),
    mi: now.getMinutes(),
  });
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: '가사 보조 백업 저장',
    });
  } finally {
    try {
      file.delete();
    } catch {
      // 캐시 사본 삭제 실패는 무시(시스템이 정리)
    }
  }
  return { fileName, bytes: text.length };
}

export type PickedBackup = { canceled: true } | { canceled: false; name: string; parsed: BackupParseResult };

export async function pickBackup(): Promise<PickedBackup> {
  const picked = await File.pickFileAsync({ mimeTypes: ['application/json', 'text/plain'] });
  if (picked.canceled) return { canceled: true };
  const file = picked.result;
  // 크기를 먼저 확인해 너무 큰 파일은 읽지 않는다(불신 파일).
  // 선택한 파일은 지우거나 고치지 않는다(임시 사본은 시스템이 정리).
  if (file.size > BACKUP_LIMITS.maxChars * 4) {
    return { canceled: false, name: file.name, parsed: { ok: false, error: '파일이 너무 큽니다' } };
  }
  const text = await file.text();
  return { canceled: false, name: file.name, parsed: parseBackup(text, LATEST_SCHEMA_VERSION) };
}
