/**
 * 사용자가 등록하는 AI 제공자 설정(비밀 아님). API 키는 여기에 넣지 않고 ApiKeyManager(OS 보안 저장소)에만 둔다.
 * 현재 어댑터: OpenAI 호환 Chat Completions. 다른 형식은 TranslationProvider 포트로 추가한다.
 */

export interface ProviderConfig {
  /** 키 저장 슬롯 이름에도 쓰인다(소문자·숫자·.-_) */
  providerId: string;
  /** https만 허용. 예: https://api.example.com/v1 (끝에 /chat/completions 를 붙여 호출) */
  baseUrl: string;
  model: string;
  /** json_schema 구조화 출력 지원 여부. 모르면 true로 두고 실패 시 끈다. */
  structuredOutput: boolean;
  /**
   * 추론 모델의 추론 강도(OpenAI `reasoning_effort`). null이면 보내지 않는다(일반 모델·호환 서버).
   * 값을 정하면 추론 모델 방식으로 요청한다: `max_completion_tokens` 사용, `temperature` 생략.
   * ChatGPT의 "Extra high" = `xhigh`.
   */
  reasoningEffort: ReasoningEffort | null;
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * 입력 편의를 위한 주소 예시. 모델 이름은 제공자가 자주 바꾸므로 사용자가 직접 입력한다.
 * 실제 호환 여부는 확인하지 않았다(MV-AI-01).
 */
export const PROVIDER_PRESETS: ReadonlyArray<{ label: string; providerId: string; baseUrl: string }> = [
  { label: 'OpenAI', providerId: 'openai', baseUrl: 'https://api.openai.com/v1' },
  {
    label: 'Google Gemini (OpenAI 호환)',
    providerId: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { label: 'OpenRouter', providerId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
];

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F\s]/;

export function validateProviderConfig(
  input: unknown,
): { ok: true; config: ProviderConfig } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: '설정 형식이 올바르지 않습니다' };
  const o = input as Record<string, unknown>;
  const providerId = typeof o['providerId'] === 'string' ? o['providerId'].trim() : '';
  if (!PROVIDER_ID.test(providerId)) return { ok: false, error: '제공자 ID는 영문 소문자·숫자·.-_ 만 쓸 수 있습니다' };
  const rawUrl = typeof o['baseUrl'] === 'string' ? o['baseUrl'].trim().replace(/\/+$/, '') : '';
  if (rawUrl.length > 300 || CONTROL.test(rawUrl)) return { ok: false, error: '주소가 올바르지 않습니다' };
  const m = /^https:\/\/([^/?#@]+)(\/[^?#]*)?$/.exec(rawUrl);
  if (!m) return { ok: false, error: '주소는 https:// 로 시작해야 하며 인증정보·쿼리를 포함할 수 없습니다' };
  const model = typeof o['model'] === 'string' ? o['model'].trim() : '';
  if (model.length === 0 || model.length > 128 || CONTROL.test(model))
    return { ok: false, error: '모델 이름이 올바르지 않습니다' };
  const structuredOutput = o['structuredOutput'] !== false;
  // 이전 버전 설정(필드 없음)은 null(보내지 않음)로 읽는다.
  const re = o['reasoningEffort'];
  if (re !== undefined && re !== null && !(REASONING_EFFORTS as readonly unknown[]).includes(re))
    return { ok: false, error: '추론 강도 값이 올바르지 않습니다' };
  const reasoningEffort = (re ?? null) as ReasoningEffort | null;
  return { ok: true, config: { providerId, baseUrl: rawUrl, model, structuredOutput, reasoningEffort } };
}

export function serializeProviderConfig(c: ProviderConfig): string {
  return JSON.stringify({
    providerId: c.providerId,
    baseUrl: c.baseUrl,
    model: c.model,
    structuredOutput: c.structuredOutput,
    reasoningEffort: c.reasoningEffort,
  });
}

export function parseProviderConfig(text: string | null): ProviderConfig | null {
  if (!text) return null;
  try {
    const r = validateProviderConfig(JSON.parse(text));
    return r.ok ? r.config : null;
  } catch {
    return null;
  }
}
