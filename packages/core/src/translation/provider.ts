import type { CancelSignal } from '../ports.js';
import type { FailureKind } from '../model.js';

/** 번역 제공자 포트. 특정 회사·모델에 종속되지 않도록 core는 이 인터페이스만 사용한다. */
export interface TranslationProviderRequest {
  jobId: string;
  system: string;
  user: string;
  /** 구조화 출력 지원 제공자에게 전달할 JSON Schema */
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface TranslationProviderResponse {
  /** 모델이 반환한 텍스트(JSON 기대). 검증 전까지 신뢰하지 않는다. */
  rawText: string;
  /** 제공자가 거절 신호를 별도 필드로 준 경우 */
  refused?: boolean;
  providerRequestId?: string;
}

export interface TranslationProvider {
  readonly providerId: string;
  readonly model: string;
  translate(request: TranslationProviderRequest, signal?: CancelSignal): Promise<TranslationProviderResponse>;
}

/**
 * 제공자 오류. billedRisk='possible'이면 서버가 요청을 처리·과금했을 수 있으므로 자동 재요청하지 않는다.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: Extract<
      FailureKind,
      'auth' | 'rate_limited' | 'overloaded' | 'bad_request' | 'server' | 'timeout' | 'offline' | 'aborted' | 'unknown'
    >,
    message: string,
    readonly billedRisk: 'none' | 'possible',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** 활성 제공자 선택. 키가 없거나 설정되지 않았으면 null */
export interface TranslationProviderRegistry {
  active(): Promise<TranslationProvider | null>;
}
