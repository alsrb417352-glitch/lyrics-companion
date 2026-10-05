import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { lyricsToPlainText, plainTextFileName, type LyricsVersion } from '@lyrics-companion/core';

/**
 * TXT 파일 내보내기·고르기(iOS).
 * 내용·파일 이름은 core가 만들고, 여기서는 파일을 쓰고 공유 시트를 열거나 파일 선택기로 읽기만 한다.
 * 사용자가 공유 시트에서 "파일에 저장"·메모·ChatGPT 등 보낼 곳을 고른다. 앱이 직접 외부로 보내지 않는다.
 * 공유가 끝나면 캐시 사본을 지운다. 고른 파일은 바꾸거나 지우지 않는다.
 */
export async function shareTextFile(opts: { text: string; fileName: string; dialogTitle: string }): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('이 기기에서는 공유 시트를 열 수 없습니다');
  const file = new File(Paths.cache, opts.fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(opts.text);
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/plain',
      UTI: 'public.plain-text',
      dialogTitle: opts.dialogTitle,
    });
  } finally {
    try {
      file.delete();
    } catch {
      // 캐시 사본 삭제 실패는 무시(시스템이 정리)
    }
  }
}

/** 원문 가사 TXT 내보내기(REQ-ED-04, docs/plan.md D-29). */
export async function exportLyricsText(
  lyrics: LyricsVersion,
  meta: { title: string; artist: string },
): Promise<{ fileName: string; lines: number }> {
  const text = lyricsToPlainText(lyrics);
  if (text === '') throw new Error('내보낼 가사가 없습니다');
  const fileName = plainTextFileName(meta);
  await shareTextFile({ text, fileName, dialogTitle: '원문 가사 내보내기' });
  return { fileName, lines: text.split('\n').filter((l) => l !== '').length };
}

export type PickedText =
  | { canceled: true }
  | { canceled: false; name: string; text: string }
  | { canceled: false; name: string; error: string };

/**
 * TXT 파일 하나를 골라 읽는다(번역 묶음 가져오기, D-34). 파일은 불신 데이터: 크기를 먼저 확인하고,
 * 내용 검증은 core(parseTranslationBundle)가 한다.
 */
export async function pickTextFile(maxChars: number): Promise<PickedText> {
  const picked = await File.pickFileAsync({ mimeTypes: ['text/plain'] });
  if (picked.canceled) return { canceled: true };
  const file = picked.result;
  // UTF-8 한 글자는 최대 4바이트
  if (file.size > maxChars * 4) return { canceled: false, name: file.name, error: '파일이 너무 큽니다' };
  return { canceled: false, name: file.name, text: await file.text() };
}
