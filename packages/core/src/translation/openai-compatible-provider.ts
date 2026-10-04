import { HttpError, type CancelSignal, type HttpClient } from '../ports.js';
import type { ApiKeyManager } from '../security/api-keys.js';
import type { Logger } from '../security/logger.js';
import { redactText, type SecretRegistry } from '../security/redact.js';
import {
  ProviderError,
  type TranslationProvider,
  type TranslationProviderRequest,
  type TranslationProviderResponse,
} from './provider.js';

/**
 * "OpenAI 호환 Chat Completions" 형식 어댑터(첫 번째 참조 구현).
 * 다른 형식(Anthropic Messages, Gemini 등)은 같은 TranslationProvider 포트로 별도 어댑터를 추가한다.
 * - HTTPS만 허용한다.
 * - 키는 요청 직전에 보안 저장소에서 읽고, 로그에는 헤더·본문을 남기지 않는다.
 * - 제공자 오류 메시지는 키가 섞여 있을 수 있으므로 마스킹한다.
 * - 이 어댑터의 실제 서비스 연동은 아직 검증하지 않았다(가짜 HTTP로만 테스트, docs/testing.md MV-AI-01).
 */
export interface OpenAiCompatibleOptions {
  providerId: string;
  baseUrl: string;
  model: string;
  http: HttpClient;
  keys: ApiKeyManager;
  logger: Logger;
  secrets: SecretRegistry;
  timeoutMs?: number;
  /** json_schema 구조화 출력을 지원하지 않는 호환 서버면 false(json_object로 대체) */
  structuredOutput?: boolean;
}

export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): TranslationProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/.test(base)) throw new Error('AI 제공자 baseUrl은 https여야 합니다');

  return {
    providerId: opts.providerId,
    model: opts.model,
    async translate(req: TranslationProviderRequest, signal?: CancelSignal): Promise<TranslationProviderResponse> {
      const key = await opts.keys.getForRequest(opts.providerId);
      if (!key) throw new ProviderError('auth', 'API 키가 등록되지 않았습니다', 'none');
      const body = {
        model: opts.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        max_tokens: req.maxOutputTokens,
        temperature: 0.3,
        response_format:
          opts.structuredOutput === false
            ? { type: 'json_object' }
            : {
                type: 'json_schema',
                json_schema: { name: 'lyrics_translation', strict: true, schema: req.responseSchema },
              },
      };
      const url = `${base}/chat/completions`;
      opts.logger.info('ai.request', { providerId: opts.providerId, model: opts.model, jobId: req.jobId, url });
      let res;
      try {
        res = await opts.http.send({
          url,
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: opts.timeoutMs ?? 60_000,
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (e instanceof HttpError) {
          const msg = redactText(e.message, opts.secrets.known());
          if (e.kind === 'aborted')
            throw new ProviderError('aborted', msg, e.requestSent === 'no' ? 'none' : 'possible');
          if (e.kind === 'offline' && e.requestSent === 'no') throw new ProviderError('offline', msg, 'none');
          if (e.kind === 'timeout') throw new ProviderError('timeout', msg, 'possible');
          throw new ProviderError('unknown', msg, e.requestSent === 'no' ? 'none' : 'possible');
        }
        throw new ProviderError('unknown', 'transport error', 'possible');
      }
      const known = opts.secrets.known();
      const snippet = redactText(res.bodyText.slice(0, 300), known);
      if (res.status === 401 || res.status === 403)
        throw new ProviderError('auth', `HTTP ${res.status}: ${snippet}`, 'none');
      if (res.status === 429) {
        const ra = Number(res.headers['retry-after']);
        throw new ProviderError('rate_limited', `HTTP 429`, 'none', Number.isFinite(ra) ? ra * 1000 : undefined);
      }
      if (res.status === 503) throw new ProviderError('overloaded', 'HTTP 503', 'none');
      if (res.status >= 400 && res.status < 500)
        throw new ProviderError('bad_request', `HTTP ${res.status}: ${snippet}`, 'none');
      if (res.status >= 500) throw new ProviderError('server', `HTTP ${res.status}`, 'possible');

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.bodyText);
      } catch {
        return { rawText: '' };
      }
      const choice = (parsed as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> })
        .choices?.[0];
      const content = choice?.message?.content;
      const refusal = choice?.message?.refusal;
      const requestId = res.headers['x-request-id'];
      return {
        rawText: typeof content === 'string' ? content : '',
        refused: typeof refusal === 'string' && refusal.length > 0,
        ...(requestId ? { providerRequestId: requestId } : {}),
      };
    },
  };
}
