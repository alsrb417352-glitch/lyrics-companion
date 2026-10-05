import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { lyricsToPlainText, plainTextFileName, type LyricsVersion } from '@lyrics-companion/core';

/**
 * 원문 가사 TXT 내보내기(REQ-ED-04, docs/plan.md D-29).
 * 내용·파일 이름은 core가 만들고(lyricsToPlainText·plainTextFileName), 여기서는 파일을 쓰고 공유 시트만 연다.
 * 사용자가 공유 시트에서 "파일에 저장"·메모·ChatGPT 등 보낼 곳을 고른다. 앱이 직접 외부로 보내지 않는다.
 * 공유가 끝나면 캐시 사본을 지운다.
 */
export async function exportLyricsText(
  lyrics: LyricsVersion,
  meta: { title: string; artist: string },
): Promise<{ fileName: string; lines: number }> {
  const text = lyricsToPlainText(lyrics);
  if (text === '') throw new Error('내보낼 가사가 없습니다');
  if (!(await Sharing.isAvailableAsync())) throw new Error('이 기기에서는 공유 시트를 열 수 없습니다');
  const fileName = plainTextFileName(meta);
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/plain',
      UTI: 'public.plain-text',
      dialogTitle: '원문 가사 내보내기',
    });
  } finally {
    try {
      file.delete();
    } catch {
      // 캐시 사본 삭제 실패는 무시(시스템이 정리)
    }
  }
  return { fileName, lines: text.split('\n').filter((l) => l !== '').length };
}
