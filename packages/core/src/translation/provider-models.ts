import { HttpError, type HttpClient } from '../ports.js';
import type { ApiKeyManager } from '../security/api-keys.js';
import type { Logger } from '../security/logger.js';
import { redactText, type SecretRegistry } from '../security/redact.js';

/**
 * AI 제공자 모델 이름 진단(D-39, 2026-10-12 사용자 보고: 모델 칸에 `luna`·`Luna`·`GPT6-Luna`를 넣자
 * OpenAI가 `404 model_not_found`를 돌려줌 — 정확한 API ID는 `gpt-6-luna`).
 *
 * - 제공자 오류 본문(OpenAI 형식 `{"error":{message,type,code,param}}`, Gemini 호환 `[{"error":{...}}]`)을 읽어
 *   사람이 읽을 수 있는 한국어 안내로 바꾼다. 원본 JSON을 그대로 화면에 보이지 않는다.
 * - `GET {baseUrl}/models`로 이 키로 쓸 수 있는 모델 ID 목록을 받는다. 번역 요청이 아니므로 가사를 보내지 않고
 *   과금도 없다(OpenAI·OpenRouter·Gemini 호환 모두 목록 조회는 무료). 키는 요청 헤더에만 넣고 로그·오류에 남기지 않는다.
 * - 입력한 이름과 비슷한 ID를 **제안**만 한다. 자동으로 바꾸지 않는다(모델 ID는 대소문자·기호까지 정확해야 하고
 *   제공자마다 형식이 다르다 — 예: OpenRouter는 `openai/gpt-6-luna`).
 * - 제공자 응답은 불신 데이터: 크기·형식을 검사하고 제어 문자를 지운 문자열만 돌려준다(REQ-SEC-07).
 */

export interface ProviderErrorInfo {
  message: string | null;
  code: string | null;
  type: string | null;
  param: string | null;
}

const MAX_ERROR_TEXT = 300;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]+/g;

function cleanText(v: unknown, max = MAX_ERROR_TEXT): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 제공자 오류 본문 해석. JSON이 아니거나 형식이 다르면 null */
export function parseProviderErrorBody(bodyText: string): ProviderErrorInfo | null {
  if (bodyText.length === 0 || bodyText.length > 100_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  // Gemini OpenAI 호환은 배열로 감싸 보내기도 한다.
  if (Array.isArray(parsed)) parsed = parsed[0];
  if (typeof parsed !== 'object' || parsed === null) return null;
  const err = (parsed as Record<string, unknown>)['error'];
  if (typeof err === 'string') return { message: cleanText(err), code: null, type: null, param: null };
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  const info: ProviderErrorInfo = {
    message: cleanText(e['message']),
    code: cleanText(e['code'], 80),
    type: cleanText(e['type'] ?? e['status'], 80),
    param: cleanText(e['param'], 80),
  };
  return info.message || info.code || info.type ? info : null;
}

/** "모델을 찾을 수 없음" 오류인지(OpenAI `model_not_found`, Gemini·호환 서버의 "model ... not found" 문구) */
export function isModelNotFound(status: number, info: ProviderErrorInfo | null): boolean {
  if (!info || (status !== 404 && status !== 400)) return false;
  if (info.code === 'model_not_found') return true;
  const msg = info.message ?? '';
  return /\bmodels?\b/i.test(msg) && /(does not exist|not found|not exist|unknown model|invalid model)/i.test(msg);
}

function isOpenAiBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/api\.openai\.com(\/|$)/i.test(baseUrl);
}

/**
 * OpenAI 모델 ID 표기 규칙(모두 소문자, 단어 사이 하이픈, `gpt` 뒤 숫자 앞 하이픈)에 맞춘 추정값.
 * 표기만 고친다(예: `GPT6-Luna`·`GPT-6 Luna` → `gpt-6-luna`). 이름을 지어내지 않으므로 `luna` 단독은 그대로다.
 */
export function normalizeOpenAiModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^gpt(?=\d)/, 'gpt-')
    .replace(/-+/g, '-');
}

/** OpenAI 대화 모델 ID의 앞부분(경고용 대략 판정 — 막지 않는다) */
const OPENAI_CHAT_MODEL_PREFIX = /^(gpt|o\d|chatgpt|ft:|codex|computer-use)/;

export interface ModelNameCheck {
  /** 표기를 고친 제안. 없으면 null */
  suggestion: string | null;
  /** 화면에 보일 경고. 없으면 null */
  warning: string | null;
}

/** 저장 전·입력 중 모델 이름 점검(네트워크 없이). OpenAI 주소일 때만 OpenAI 표기 규칙을 적용한다. */
export function checkModelName(model: string, baseUrl: string): ModelNameCheck {
  const m = model.trim();
  if (!m || !isOpenAiBaseUrl(baseUrl.trim())) return { suggestion: null, warning: null };
  const normalized = normalizeOpenAiModelId(m);
  // 표기를 고쳐도 OpenAI 대화 모델 ID 모양(gpt-…, o3…, chatgpt-… 등)이 아니면 이름 자체가 다른 것(예: ChatGPT 표시 이름).
  if (!OPENAI_CHAT_MODEL_PREFIX.test(normalized)) {
    return {
      suggestion: null,
      warning:
        'ChatGPT 화면의 이름(예: Luna)과 API 모델 ID(예: gpt-6-luna)는 다릅니다. "모델 목록 불러오기"로 정확한 ID를 확인하세요.',
    };
  }
  if (normalized !== m) {
    return {
      suggestion: normalized,
      warning: `OpenAI 모델 ID는 모두 소문자이고 단어 사이를 하이픈(-)으로 잇습니다. "${normalized}"인지 확인하세요.`,
    };
  }
  return { suggestion: null, warning: null };
}

/**
 * 제공자 HTTP 오류(4xx)를 화면용 한국어 문장으로. 결과는 호출자가 다시 마스킹한다.
 * 형식을 모르는 본문은 앞부분만 그대로 붙인다(이전 동작과 같음).
 */
export function describeProviderHttpError(
  status: number,
  bodyText: string,
  ctx: { model: string; baseUrl: string },
): string {
  const info = parseProviderErrorBody(bodyText);
  const detail = info?.message ?? cleanText(bodyText.slice(0, MAX_ERROR_TEXT)) ?? '';
  const code = info?.code ? ` ${info.code}` : '';
  if (isModelNotFound(status, info)) {
    const check = checkModelName(ctx.model, ctx.baseUrl);
    if (!check.warning) {
      // 이름 표기는 맞아 보임(예: gpt-6-luna) → OpenAI는 "권한 없음"도 같은 404로 알려 준다.
      return (
        `모델 "${ctx.model}"을(를) 쓸 수 없습니다(HTTP ${status}${code}). ` +
        '이름이 틀렸거나 이 키의 계정(프로젝트)에 이 모델 사용 권한이 없습니다. ' +
        '설정 탭 → "모델 목록 불러오기"로 이 키로 쓸 수 있는 이름을 확인하세요.'
      );
    }
    const guess = check.suggestion ? ` 혹시 "${check.suggestion}"인가요?` : '';
    return (
      `모델 "${ctx.model}"을(를) 찾을 수 없습니다(HTTP ${status}${code}).${guess} ` +
      '모델 이름은 제공자가 정한 API용 ID와 대소문자·기호까지 똑같이 넣어야 합니다' +
      (isOpenAiBaseUrl(ctx.baseUrl) ? '(예: ChatGPT의 "Luna" → gpt-6-luna)' : '') +
      '. 설정 탭 → "모델 목록 불러오기"로 이 키로 쓸 수 있는 이름을 고르세요.'
    );
  }
  if (status === 401)
    return `API 키가 올바르지 않거나 취소되었습니다(HTTP 401${code}). 설정 탭에서 키를 다시 저장하세요. ${detail}`.trim();
  if (status === 403)
    return `이 키로는 이 기능·모델을 쓸 권한이 없습니다(HTTP 403${code}). 제공자 계정의 권한·결제·조직 인증을 확인하세요. ${detail}`.trim();
  if (status === 404)
    return `요청 주소를 찾을 수 없습니다(HTTP 404${code}). 설정의 API 주소(OpenAI는 https://api.openai.com/v1)를 확인하세요. ${detail}`.trim();
  return `요청이 거부되었습니다(HTTP ${status}${code}). ${detail}`.trim();
}

// ---------------------------------------------------------------- 모델 목록

export interface ProviderModelListOptions {
  providerId: string;
  baseUrl: string;
  http: HttpClient;
  keys: ApiKeyManager;
  secrets: SecretRegistry;
  logger?: Logger;
  timeoutMs?: number;
}

export type ProviderModelListResult =
  | { ok: true; models: string[] }
  | {
      ok: false;
      kind: 'no-key' | 'auth' | 'not-found' | 'offline' | 'http' | 'invalid';
      message: string;
    };

// eslint-disable-next-line no-control-regex
const MODEL_ID = /^[^\s\u0000-\u001F\u007F]{1,128}$/;
const MAX_MODELS = 2000;
const MAX_MODEL_LIST_BYTES = 5_000_000;

/** 목록 응답 해석(순수 함수). 최신(`created`가 큰) 모델이 앞에 오도록 정렬한다. */
export function parseModelList(bodyText: string): string[] | null {
  if (bodyText.length > MAX_MODEL_LIST_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const data =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)['data']
      : parsed;
  if (!Array.isArray(data)) return null;
  const seen = new Map<string, number>();
  for (const item of data) {
    if (seen.size >= MAX_MODELS) break;
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = o['id'];
    if (typeof id !== 'string' || !MODEL_ID.test(id) || seen.has(id)) continue;
    const created = typeof o['created'] === 'number' && Number.isFinite(o['created']) ? o['created'] : 0;
    seen.set(id, created);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/** 이 키로 쓸 수 있는 모델 ID 목록을 받는다. 번역 요청·가사 전송·과금 없음. */
export async function listProviderModels(opts: ProviderModelListOptions): Promise<ProviderModelListResult> {
  const base = opts.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#@]+/.test(base))
    return { ok: false, kind: 'invalid', message: 'API 주소는 https:// 로 시작해야 합니다' };
  const key = await opts.keys.getForRequest(opts.providerId);
  if (!key) return { ok: false, kind: 'no-key', message: '먼저 API 키를 저장해 주세요.' };
  const url = `${base}/models`;
  opts.logger?.info('ai.models.request', { providerId: opts.providerId, url });
  const known = (): readonly string[] => opts.secrets.known();
  let res;
  try {
    res = await opts.http.send({
      url,
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
  } catch (e) {
    const offline = e instanceof HttpError && (e.kind === 'offline' || e.kind === 'network');
    const msg = e instanceof Error ? redactText(e.message, known()) : '';
    return {
      ok: false,
      kind: offline ? 'offline' : 'http',
      message: offline ? '네트워크에 연결되지 않았습니다.' : `모델 목록을 받지 못했습니다(${msg || '전송 오류'}).`,
    };
  }
  if (res.status < 200 || res.status >= 300) {
    const info = parseProviderErrorBody(res.bodyText);
    const detail = redactText(info?.message ?? '', known());
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 404 ? 'not-found' : 'http';
    const head =
      kind === 'auth'
        ? `API 키가 올바르지 않거나 권한이 없습니다(HTTP ${res.status}).`
        : kind === 'not-found'
          ? `이 제공자는 모델 목록 주소(${redactText(url, known())})를 지원하지 않거나 API 주소가 틀렸습니다(HTTP 404).`
          : `모델 목록을 받지 못했습니다(HTTP ${res.status}).`;
    opts.logger?.warn('ai.models.failed', { providerId: opts.providerId, status: res.status });
    return { ok: false, kind, message: `${head}${detail ? ` ${detail}` : ''}` };
  }
  const models = parseModelList(res.bodyText);
  if (!models) return { ok: false, kind: 'invalid', message: '모델 목록 응답 형식을 알 수 없습니다.' };
  opts.logger?.info('ai.models.ok', { providerId: opts.providerId, count: models.length });
  return { ok: true, models };
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 입력과 비슷한 모델 ID(대소문자·기호를 무시하고 포함하는 것). 정확히 같은 것 → 짧은 것 → 목록 순(최신 먼저).
 * 예: `luna`·`Luna`·`GPT6-Luna` → `gpt-6-luna`.
 */
export function suggestModelIds(input: string, models: readonly string[], limit = 8): string[] {
  const q = squash(input);
  if (!q) return [];
  const exactCi = input.trim().toLowerCase();
  return models
    .map((id, index) => ({ id, index, s: squash(id) }))
    .filter((m) => m.s.includes(q))
    .sort(
      (a, b) =>
        Number(b.id.toLowerCase() === exactCi) - Number(a.id.toLowerCase() === exactCi) ||
        a.id.length - b.id.length ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map((m) => m.id);
}
