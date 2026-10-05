/**
 * OpenAI 추론 모델(예: gpt-6-luna) 호환 요청 형식.
 * 추론 모델은 max_tokens·temperature를 받지 않으므로, 추론 강도를 정하면 max_completion_tokens + reasoning_effort로 보낸다.
 * 실제 OpenAI 호출은 하지 않는다(가짜 HTTP). 실제 확인은 MV-AI-01.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness.js';
import { jsonResponse } from '../support/fakes.js';
import {
  buildChatCompletionsBody,
  createOpenAiCompatibleProvider,
  REASONING_TIMEOUT_MS,
  REASONING_TOKEN_HEADROOM,
} from '../../src/translation/openai-compatible-provider.js';
import { parseProviderConfig, validateProviderConfig } from '../../src/translation/provider-config.js';
import { ProviderError } from '../../src/translation/provider.js';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length)
    await open
      .pop()
      ?.close()
      .catch(() => undefined);
});

const REQ = {
  jobId: 'job_1',
  system: 'sys',
  user: '{"lines":[]}',
  responseSchema: { type: 'object' },
  maxOutputTokens: 1000,
};

function fakeKey(): string {
  return ['sk', 'test', 'reason', 'Q4'.repeat(10)].join('-');
}

describe('추론 모델 요청 형식', () => {
  it('[REQ-TR-01] 추론 강도를 정하면 max_completion_tokens·reasoning_effort로 보내고 temperature·max_tokens는 보내지 않는다', () => {
    const body = buildChatCompletionsBody(REQ, { model: 'gpt-6-luna', reasoningEffort: 'xhigh' });
    expect(body['reasoning_effort']).toBe('xhigh');
    expect(body['max_completion_tokens']).toBe(1000 + REASONING_TOKEN_HEADROOM.xhigh);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect((body['response_format'] as { type: string }).type).toBe('json_schema');
  });

  it('[REQ-TR-01] 추론 강도가 없으면(일반 모델·호환 서버) 이전 형식 그대로', () => {
    const body = buildChatCompletionsBody(REQ, { model: 'm', reasoningEffort: null });
    expect(body['max_tokens']).toBe(1000);
    expect(body['temperature']).toBe(0.3);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('[REQ-TR-01][REQ-TR-10] 실제 전송 본문·시간 초과가 추론 강도를 따르고, 출력 한도에서 잘린 응답은 과금 가능 실패로 처리한다', async () => {
    const h = await createHarness();
    open.push(h);
    await h.keys.set('openai', fakeKey());
    h.http.on(
      (r) => r.url === 'https://api.openai.com/v1/chat/completions',
      () => jsonResponse(200, { choices: [{ finish_reason: 'length', message: { content: '{"status":' } }] }),
    );
    const p = createOpenAiCompatibleProvider({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-6-luna',
      reasoningEffort: 'xhigh',
      http: h.http,
      keys: h.keys,
      logger: h.logger,
      secrets: h.secrets,
    });
    const err = await p.translate(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).billedRisk).toBe('possible');
    const sent = h.http.calls[0]!;
    expect(sent.timeoutMs).toBe(REASONING_TIMEOUT_MS.xhigh);
    const body = JSON.parse(sent.body ?? '{}') as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('xhigh');
    expect(body['model']).toBe('gpt-6-luna');
    expect(body).not.toHaveProperty('temperature');
  });

  it('[REQ-TR-01] 설정: 추론 강도 값 검사, 이전 버전 설정(필드 없음)은 null로 읽는다', () => {
    const base = { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' };
    expect(validateProviderConfig({ ...base, reasoningEffort: 'xhigh' })).toMatchObject({
      ok: true,
      config: { reasoningEffort: 'xhigh' },
    });
    expect(validateProviderConfig({ ...base, reasoningEffort: 'ultra' }).ok).toBe(false);
    expect(parseProviderConfig(JSON.stringify({ ...base, structuredOutput: true }))?.reasoningEffort).toBeNull();
  });
});
