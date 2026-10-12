/**
 * D-39: 모델 이름 진단·모델 목록(2026-10-12 사용자 보고 — 모델 칸 `luna`·`Luna`·`GPT6-Luna` → OpenAI 404 model_not_found).
 * 실제 OpenAI 호출은 하지 않는다(가짜 HTTP). 오류 본문은 OpenAI가 실제로 돌려준 형식(사용자 화면)과 같게 만든다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness.js';
import { jsonResponse } from '../support/fakes.js';
import { createOpenAiCompatibleProvider } from '../../src/translation/openai-compatible-provider.js';
import { ProviderError } from '../../src/translation/provider.js';
import {
  checkModelName,
  describeProviderHttpError,
  isModelNotFound,
  listProviderModels,
  normalizeOpenAiModelId,
  parseModelList,
  parseProviderErrorBody,
  suggestModelIds,
} from '../../src/translation/provider-models.js';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

const OPENAI = 'https://api.openai.com/v1';
const REQ = { jobId: 'job_1', system: 'sys', user: '{"lines":[]}', responseSchema: {}, maxOutputTokens: 100 };

function fakeKey(): string {
  return ['sk', 'test', 'models', 'Z9'.repeat(12)].join('-');
}

/** OpenAI가 없는 모델에 돌려주는 본문(사용자 화면과 같은 형식) */
function modelNotFoundBody(model: string): string {
  return JSON.stringify(
    {
      error: {
        message: `The model \`${model}\` does not exist or you do not have access to it.`,
        type: 'invalid_request_error',
        param: null,
        code: 'model_not_found',
      },
    },
    null,
    4,
  );
}

const MODELS_BODY = {
  object: 'list',
  data: [
    { id: 'gpt-5.6-luna', object: 'model', created: 1_780_000_000, owned_by: 'openai' },
    { id: 'gpt-6-luna', object: 'model', created: 1_790_000_000, owned_by: 'openai' },
    { id: 'text-embedding-3-small', object: 'model', created: 1_700_000_000, owned_by: 'openai' },
    { id: 'gpt-6', object: 'model', created: 1_789_000_000, owned_by: 'openai' },
  ],
};

describe('제공자 오류 해석', () => {
  it('[REQ-TR-01] OpenAI model_not_found 본문을 읽고, 원본 JSON 대신 모델 이름·해결 방법을 안내한다', () => {
    const body = modelNotFoundBody('luna');
    const info = parseProviderErrorBody(body);
    expect(info).toMatchObject({ code: 'model_not_found', type: 'invalid_request_error' });
    expect(isModelNotFound(404, info)).toBe(true);
    const msg = describeProviderHttpError(404, body, { model: 'luna', baseUrl: OPENAI });
    expect(msg).toContain('"luna"');
    expect(msg).toContain('gpt-6-luna');
    expect(msg).toContain('모델 목록 불러오기');
    expect(msg).not.toContain('{');
  });

  it('[REQ-TR-01] 표기만 틀린 이름(GPT6-Luna)은 OpenAI 표기로 고친 이름을 제안한다', () => {
    const msg = describeProviderHttpError(404, modelNotFoundBody('GPT6-Luna'), {
      model: 'GPT6-Luna',
      baseUrl: OPENAI,
    });
    expect(msg).toContain('혹시 "gpt-6-luna"');
  });

  it('[REQ-TR-01] 표기가 맞는 이름(gpt-6-luna)인데 404면 엉뚱한 표기 예 대신 "권한 없음" 가능성을 안내한다', () => {
    const msg = describeProviderHttpError(404, modelNotFoundBody('gpt-6-luna'), {
      model: 'gpt-6-luna',
      baseUrl: OPENAI,
    });
    expect(msg).toContain('권한');
    expect(msg).toContain('모델 목록 불러오기');
    expect(msg).not.toContain('혹시');
  });

  it('[REQ-TR-01] Gemini 호환(배열) 오류·주소 오류 404·키 오류 401을 구분한다', () => {
    const gemini = JSON.stringify([
      { error: { code: 404, message: 'models/gem-x is not found for API version v1beta', status: 'NOT_FOUND' } },
    ]);
    expect(isModelNotFound(404, parseProviderErrorBody(gemini))).toBe(true);
    const badUrl = JSON.stringify({
      error: { message: 'Invalid URL (POST /v1/chat/completion)', type: 'invalid_request_error' },
    });
    expect(isModelNotFound(404, parseProviderErrorBody(badUrl))).toBe(false);
    expect(describeProviderHttpError(404, badUrl, { model: 'gpt-6-luna', baseUrl: OPENAI })).toContain('API 주소');
    expect(
      describeProviderHttpError(401, '{"error":{"message":"Incorrect API key"}}', { model: 'm', baseUrl: OPENAI }),
    ).toContain('키');
    // 형식을 모르는 본문은 앞부분만(이전 동작)
    expect(describeProviderHttpError(400, 'plain text error', { model: 'm', baseUrl: OPENAI })).toContain(
      'plain text error',
    );
  });

  it('[REQ-TR-01][REQ-TR-10] 실제 번역 요청이 404 model_not_found면 bad_request(자동 재요청 없음)·과금 없음·읽을 수 있는 메시지', async () => {
    const h = await createHarness();
    open.push(h);
    await h.keys.set('openai', fakeKey());
    h.http.on(
      (r) => r.url === `${OPENAI}/chat/completions`,
      () => ({ status: 404, headers: { 'content-type': 'application/json' }, bodyText: modelNotFoundBody('luna') }),
    );
    const p = createOpenAiCompatibleProvider({
      providerId: 'openai',
      baseUrl: OPENAI,
      model: 'luna',
      reasoningEffort: 'xhigh',
      http: h.http,
      keys: h.keys,
      logger: h.logger,
      secrets: h.secrets,
    });
    const err = (await p.translate(REQ).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('bad_request');
    expect(err.billedRisk).toBe('none');
    expect(err.message).toContain('"luna"');
    expect(err.message).toContain('gpt-6-luna');
    expect(err.message).not.toContain('"error"');
  });

  it('[REQ-SEC-01] 제공자 오류 문구에 키가 섞여 와도 화면용 메시지에 남지 않는다', async () => {
    const h = await createHarness();
    open.push(h);
    const key = fakeKey();
    await h.keys.set('openai', key);
    h.http.on(
      () => true,
      () => jsonResponse(401, { error: { message: `Incorrect API key provided: ${key}`, code: 'invalid_api_key' } }),
    );
    const p = createOpenAiCompatibleProvider({
      providerId: 'openai',
      baseUrl: OPENAI,
      model: 'gpt-6-luna',
      http: h.http,
      keys: h.keys,
      logger: h.logger,
      secrets: h.secrets,
    });
    const err = (await p.translate(REQ).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain(key);
    const listed = await listProviderModels({
      providerId: 'openai',
      baseUrl: OPENAI,
      http: h.http,
      keys: h.keys,
      secrets: h.secrets,
    });
    expect(listed).toMatchObject({ ok: false, kind: 'auth' });
    expect(JSON.stringify(listed)).not.toContain(key);
  });
});

describe('모델 이름 점검(네트워크 없음)', () => {
  it('[REQ-TR-01] OpenAI 주소에서 ChatGPT 표시 이름·대문자 표기를 경고하고, 올바른 ID·다른 제공자는 그대로 둔다', () => {
    expect(normalizeOpenAiModelId('GPT6-Luna')).toBe('gpt-6-luna');
    expect(normalizeOpenAiModelId('GPT-6 Luna')).toBe('gpt-6-luna');
    expect(checkModelName('GPT6-Luna', OPENAI)).toMatchObject({ suggestion: 'gpt-6-luna' });
    // "luna"·"Luna"는 표기를 고쳐도 OpenAI ID 모양이 아님 → 지어낸 제안 없이 경고만
    for (const m of ['luna', 'Luna']) {
      const c = checkModelName(m, OPENAI);
      expect(c.suggestion).toBeNull();
      expect(c.warning).toContain('모델 목록 불러오기');
    }
    expect(checkModelName('gpt-6-luna', OPENAI)).toEqual({ suggestion: null, warning: null });
    expect(checkModelName('openai/GPT-6-Luna', 'https://openrouter.ai/api/v1')).toEqual({
      suggestion: null,
      warning: null,
    });
  });
});

describe('모델 목록', () => {
  it('[REQ-TR-01] GET /models로 목록을 받고(키는 헤더에만, 가사 전송 없음) 최신 순으로 정렬, 입력과 비슷한 ID를 제안한다', async () => {
    const h = await createHarness();
    open.push(h);
    const key = fakeKey();
    await h.keys.set('openai', key);
    h.http.on(
      (r) => r.url === `${OPENAI}/models` && r.method === 'GET',
      () => jsonResponse(200, MODELS_BODY),
    );
    const r = await listProviderModels({
      providerId: 'openai',
      baseUrl: `${OPENAI}/`,
      http: h.http,
      keys: h.keys,
      secrets: h.secrets,
      logger: h.logger,
    });
    expect(r).toEqual({ ok: true, models: ['gpt-6-luna', 'gpt-6', 'gpt-5.6-luna', 'text-embedding-3-small'] });
    const sent = h.http.calls[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.body).toBeUndefined();
    expect(sent.url).not.toContain(key);
    expect(sent.headers['Authorization']).toBe(`Bearer ${key}`);
    expect(JSON.stringify(h.sink.entries)).not.toContain(key);
    const models = r.ok ? r.models : [];
    for (const typed of ['luna', 'Luna', 'GPT6-Luna']) expect(suggestModelIds(typed, models)[0]).toBe('gpt-6-luna');
    expect(suggestModelIds('', models)).toEqual([]);
  });

  it('[REQ-TR-01] 키 없음·네트워크 없음·404(목록 미지원)을 구분해 알리고 요청을 꾸며내지 않는다', async () => {
    const h = await createHarness();
    open.push(h);
    const base = { providerId: 'openai', baseUrl: OPENAI, http: h.http, keys: h.keys, secrets: h.secrets };
    expect(await listProviderModels(base)).toMatchObject({ ok: false, kind: 'no-key' });
    expect(h.http.calls).toHaveLength(0);
    await h.keys.set('openai', fakeKey());
    h.http.offline = true;
    expect(await listProviderModels(base)).toMatchObject({ ok: false, kind: 'offline' });
    h.http.offline = false;
    h.http.on(
      () => true,
      () => jsonResponse(404, { error: { message: 'not found' } }),
    );
    expect(await listProviderModels(base)).toMatchObject({ ok: false, kind: 'not-found' });
    expect(await listProviderModels({ ...base, baseUrl: 'http://insecure.example/v1' })).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });

  it('[REQ-SEC-07] 목록 응답은 불신 데이터: 형식이 틀린 항목·공백/제어 문자·중복·너무 긴 ID는 버린다', () => {
    const body = JSON.stringify({
      data: [
        { id: 'ok-model', created: 2 },
        { id: 'ok-model', created: 1 },
        { id: 'has space' },
        { id: 'bad\u0007bell' },
        { id: 'x'.repeat(129) },
        { id: 42 },
        null,
        'string-item',
        { id: 'older', created: 1 },
      ],
    });
    expect(parseModelList(body)).toEqual(['ok-model', 'older']);
    expect(parseModelList('<html>')).toBeNull();
    expect(parseModelList('{"data":"nope"}')).toBeNull();
  });
});
