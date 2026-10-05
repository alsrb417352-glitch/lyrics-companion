import { HttpError, type CancelSignal, type HttpClient } from '../ports.js';
import type { ApiKeyManager } from '../security/api-keys.js';
import type { Logger } from '../security/logger.js';
import { redactText, type SecretRegistry } from '../security/redact.js';
import type { ReasoningEffort } from './provider-config.js';
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
  /** 추론 모델이면 추론 강도. 없으면 일반 모델 방식(max_tokens·temperature)으로 보낸다. */
  reasoningEffort?: ReasoningEffort | null;
}

/**
 * 추론 모델은 출력 토큰 한도(max_completion_tokens) 안에서 "생각" 토큰도 쓴다.
 * 번역 결과가 잘리지 않도록 추론 강도별 여유분을 더한다(비용은 실제 사용한 토큰만 청구).
 */
export const REASONING_TOKEN_HEADROOM: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 2_000,
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 32_000,
  max: 64_000,
};

/** 추론 강도가 높을수록 응답이 오래 걸리므로 시간 초과를 늘린다(시간 초과는 "결과 미확인"이 되어 자동 재요청하지 않음). */
export const REASONING_TIMEOUT_MS: Record<ReasoningEffort, number> = {
  none: 60_000,
  minimal: 60_000,
  low: 90_000,
  medium: 120_000,
  high: 180_000,
  xhigh: 300_000,
  max: 420_000,
};

/** 요청 본문 구성(순수 함수, 테스트로 고정) */
export function buildChatCompletionsBody(
  req: Pick<TranslationProviderRequest, 'system' | 'user' | 'responseSchema' | 'maxOutputTokens'>,
  opts: { model: string; structuredOutput?: boolean; reasoningEffort?: ReasoningEffort | null },
): Record<string, unknown> {
  const response_format =
    opts.structuredOutput === false
      ? { type: 'json_object' }
      : { type: 'json_schema', json_schema: { name: 'lyrics_translation', strict: true, schema: req.responseSchema } };
  const messages = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];
  if (opts.reasoningEffort) {
    // 추론 모델: max_tokens·temperature를 받지 않는다 → max_completion_tokens + reasoning_effort
    return {
      model: opts.model,
      messages,
      max_completion_tokens: req.maxOutputTokens + REASONING_TOKEN_HEADROOM[opts.reasoningEffort],
      reasoning_effort: opts.reasoningEffort,
      response_format,
    };
  }
  return { model: opts.model, messages, max_tokens: req.maxOutputTokens, temperature: 0.3, response_format };
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
      const body = buildChatCompletionsBody(req, opts);
      const url = `${base}/chat/completions`;
      opts.logger.info('ai.request', {
        providerId: opts.providerId,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort ?? null,
        jobId: req.jobId,
        url,
      });
      let res;
      try {
        res = await opts.http.send({
          url,
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: opts.timeoutMs ?? (opts.reasoningEffort ? REASONING_TIMEOUT_MS[opts.reasoningEffort] : 60_000),
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
      const choice = (
        parsed as {
          choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
        }
      ).choices?.[0];
      if (choice?.finish_reason === 'length') {
        // 출력 한도에 걸려 잘린 응답(추론 토큰이 한도를 다 쓴 경우 포함). 이미 과금됨 → 자동 재요청 안 함.
        throw new ProviderError(
          'unknown',
          '응답이 출력 한도에서 잘렸습니다(추론 강도를 낮추면 해결될 수 있음)',
          'possible',
        );
      }
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
