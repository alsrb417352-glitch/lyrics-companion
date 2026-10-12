/**
 * PC 파일 입출력(브라우저 기본 기능만): 내보내기 = 다운로드 폴더로 저장, 가져오기 = 파일 선택 창.
 * 내용·파일 이름은 core가 만들고, 여기서는 파일을 쓰고 읽기만 한다. 고른 파일은 바꾸거나 지우지 않는다.
 * downloads 권한을 쓰지 않는다(브라우저가 평소처럼 다운로드로 처리).
 */

export function downloadTextFile(fileName: string, text: string, mime = 'text/plain'): void {
  // TXT에는 UTF-8 BOM을 붙여 오래된 Windows 프로그램에서도 한글·일본어가 깨지지 않게 한다(core 파서는 BOM을 무시한다).
  // JSON(백업)은 BOM 없이 그대로 쓴다.
  const parts = mime === 'text/plain' ? ['﻿', text] : [text];
  const blob = new Blob(parts, { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type PickedText =
  | { canceled: true }
  | { canceled: false; name: string; text: string }
  | { canceled: false; name: string; error: string };

/** 텍스트 파일 하나를 골라 읽는다. 파일은 불신 데이터: 크기를 먼저 확인하고, 내용 검증은 core가 한다. */
export function pickTextFile(accept: string, maxChars: number): Promise<PickedText> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let settled = false;
    const done = (r: PickedText) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(r);
    };
    input.addEventListener('cancel', () => done({ canceled: true }));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        done({ canceled: true });
        return;
      }
      // UTF-8 한 글자는 최대 4바이트
      if (file.size > maxChars * 4) {
        done({ canceled: false, name: file.name, error: '파일이 너무 큽니다' });
        return;
      }
      file.text().then(
        (text) => done({ canceled: false, name: file.name, text }),
        () => done({ canceled: false, name: file.name, error: '파일을 읽지 못했습니다' }),
      );
    });
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
  });
}

/** 로컬 시각 기준 날짜·시간 조각(파일 이름용) */
export function localStamp(epochMs: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const now = new Date(epochMs);
  return { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), mi: now.getMinutes() };
}
