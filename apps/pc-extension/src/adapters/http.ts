import { HttpError, type HttpClient, type HttpRequest, type HttpResponse } from '@lyrics-companion/core';

const MAX_BODY_CHARS = 4 * 1024 * 1024;
/** 브라우저가 직접 정하는 헤더(바꿀 수 없음). LRCLIB 식별은 Lrclib-Client 헤더로 전달된다. */
const BROWSER_OWNED = new Set(['user-agent']);

/**
 * core HttpClient 포트의 fetch 구현(확장 프로그램 페이지).
 * - HTTPS만 허용(REQ-SEC-04). 인증서 검증은 브라우저 기본 동작 그대로.
 * - 확장 프로그램 권한(host_permissions)이 있는 주소만 요청이 나간다(AI 제공자 주소는 설정에서 사용자가 허용).
 * - POST가 시간 초과·연결 끊김으로 실패하면 서버 처리 여부를 알 수 없으므로 requestSent='unknown'
 *   (core가 결과 미확인으로 기록하고 자동 재요청하지 않는다, REQ-TR-10).
 */
export class FetchHttpClient implements HttpClient {
  async send(req: HttpRequest): Promise<HttpResponse> {
    if (!req.url.startsWith('https://')) throw new HttpError('tls', 'https 주소만 허용됩니다', 'no');
    if (req.signal?.aborted) throw new HttpError('aborted', '요청이 취소되었습니다', 'no');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, req.timeoutMs);
    const external = req.signal as unknown as { addEventListener?: (t: 'abort', f: () => void) => void } | undefined;
    external?.addEventListener?.('abort', () => ctrl.abort());
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!BROWSER_OWNED.has(k.toLowerCase())) headers[k] = v;
    const sentRisk = req.method === 'GET' ? 'no' : 'unknown';
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      const out: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      const bodyText = await res.text();
      return { status: res.status, headers: out, bodyText: bodyText.length > MAX_BODY_CHARS ? '' : bodyText };
    } catch {
      if (timedOut) throw new HttpError('timeout', '응답 시간이 초과되었습니다', 'unknown');
      if (ctrl.signal.aborted) throw new HttpError('aborted', '요청이 취소되었습니다', 'unknown');
      if (!navigator.onLine) throw new HttpError('offline', '네트워크에 연결할 수 없습니다', 'no');
      if (req.method === 'GET') throw new HttpError('offline', '네트워크에 연결할 수 없습니다', 'no');
      throw new HttpError('network', '네트워크 오류', sentRisk);
    } finally {
      clearTimeout(timer);
    }
  }
}
