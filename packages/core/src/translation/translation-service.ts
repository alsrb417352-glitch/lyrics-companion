import type { Clock, CancelSignal, IdGenerator } from '../ports.js';
import type { JobFailure, JobKind, LyricsVersion, TranslationJob } from '../model.js';
import { translatableLines } from '../lyrics/lyrics-version.js';
import { kanaToHangul } from '../pronunciation/kana-to-hangul.js';
import type { Logger } from '../security/logger.js';
import { redactText, type SecretRegistry } from '../security/redact.js';
import type { LyricsStore, NewPronunciation, NewTranslation } from '../storage/lyrics-store.js';
import { buildTranslationRequest, PROMPT_VERSION } from './prompt.js';
import { ProviderError, type TranslationProviderRegistry } from './provider.js';
import { selectPronunciation, selectTranslation } from './selection.js';
import { validateTranslationResponse, type ValidationIssue } from './validate.js';

/**
 * 번역 조정자. 이 클래스가 "언제 AI를 호출하는가"에 대한 불변조건을 강제한다.
 *
 * 불변조건(INV, docs/architecture.md):
 * INV-1 저장된 번역(사용자 또는 AI)이 있으면 ensureTranslation은 제공자를 호출하지 않는다.
 * INV-2 모델·프롬프트·제공자 변경은 기존 번역을 무효화하지 않는다(재생성 경로 없음).
 * INV-3 사용자 번역은 일부 행만 있어도 AI로 보완·수정하지 않는다.
 * INV-4 발음이 없다는 이유로 번역을 재생성하지 않는다. 발음은 requestPronunciation(명시 요청)으로만 생성한다.
 * INV-5 재번역은 retranslate(명시 요청)로만 실행하며 새 버전으로 저장한다.
 * INV-6 같은 판본·같은 종류의 동시 요청은 하나의 작업으로 합친다.
 * INV-7 결과 저장과 작업 완료는 원자적이다. 검증 실패·저장 실패는 완료로 기록하지 않는다.
 * INV-8 처리 여부가 불확실한 작업(타임아웃·앱 종료)은 자동 재요청하지 않는다.
 * INV-9 자동 번역은 사용자가 켠 경우에만, 일일 요청 상한 안에서만 실행한다.
 */

export interface TranslationPolicy {
  maxRequestsPerDay: number;
  maxSourceChars: number;
  maxLines: number;
}

export const DEFAULT_TRANSLATION_POLICY: TranslationPolicy = {
  maxRequestsPerDay: 30,
  maxSourceChars: 12_000,
  maxLines: 400,
};

export type SkipReason =
  | 'no-lyrics'
  | 'instrumental'
  | 'target-language'
  | 'not-japanese'
  | 'too-large'
  | 'auto-disabled'
  | 'no-provider'
  | 'budget'
  | 'unknown-outcome-pending';

export type TranslationOutcome =
  | { kind: 'existing'; origin: 'user' | 'ai'; versionId: string }
  | {
      kind: 'created';
      jobId: string;
      translationId: string | null;
      pronunciationId: string | null;
      partialFailure: JobFailure | null;
    }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'failed'; jobId: string; failure: JobFailure };

export interface TranslationServiceDeps {
  store: LyricsStore;
  providers: TranslationProviderRegistry;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  secrets: SecretRegistry;
  policy?: Partial<TranslationPolicy>;
}

interface JobPlan {
  lv: LyricsVersion;
  kind: JobKind;
  trigger: 'auto' | 'user';
  acknowledgeUnknownOutcome: boolean;
  signal?: CancelSignal;
}

function utcDay(epochMs: number): string {
  // 순수 날짜 포맷 계산(현재 시각을 읽지 않음). 일일 사용량은 UTC 기준으로 집계한다.
  // eslint-disable-next-line no-restricted-globals
  return new Date(epochMs).toISOString().slice(0, 10);
}

function groupOf(kind: JobKind): 'tr' | 'pr' {
  return kind === 'pronunciation' ? 'pr' : 'tr';
}

export class TranslationService {
  private readonly policy: TranslationPolicy;
  private readonly inFlight = new Map<string, Promise<TranslationOutcome>>();

  constructor(private readonly deps: TranslationServiceDeps) {
    this.policy = { ...DEFAULT_TRANSLATION_POLICY, ...deps.policy };
  }

  /** 앱 시작 시 호출: 중단된 작업을 unknown_outcome으로 표시(재요청하지 않음) */
  async recoverInterruptedJobs(): Promise<number> {
    const n = await this.deps.store.markInterruptedJobs(this.deps.clock.nowEpochMs());
    if (n > 0) this.deps.logger.warn('jobs.interrupted', { count: n });
    return n;
  }

  /**
   * 표시용 번역 확보. 우선순위: 사용자 번역 → 저장된 AI 번역 → (조건 충족 시) 신규 AI 번역.
   * 저장본이 있으면 어떤 경우에도 제공자를 호출하지 않는다.
   */
  async ensureTranslation(
    lyricsVersionId: string,
    opts: { trigger: 'auto' | 'user'; acknowledgeUnknownOutcome?: boolean; signal?: CancelSignal },
  ): Promise<TranslationOutcome> {
    const { store } = this.deps;
    const lv = await store.getLyricsVersion(lyricsVersionId);
    if (!lv) return { kind: 'skipped', reason: 'no-lyrics' };
    const existing = selectTranslation(await store.listTranslations(lv.id));
    if (existing) return { kind: 'existing', origin: existing.origin, versionId: existing.id };
    const isJa = lv.language === 'ja' || lv.language === 'mixed';
    const hasPron = selectPronunciation(await store.listPronunciations(lv.id)) !== null;
    return this.start({
      lv,
      kind: isJa && !hasPron ? 'translation+pronunciation' : 'translation',
      trigger: opts.trigger,
      acknowledgeUnknownOutcome: opts.acknowledgeUnknownOutcome ?? false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** 사용자가 해당 곡에 대해 명시적으로 요청한 재번역. 기존 버전(사용자 포함)은 보존된다. */
  async retranslate(
    lyricsVersionId: string,
    opts: { acknowledgeUnknownOutcome?: boolean; signal?: CancelSignal } = {},
  ): Promise<TranslationOutcome> {
    const lv = await this.deps.store.getLyricsVersion(lyricsVersionId);
    if (!lv) return { kind: 'skipped', reason: 'no-lyrics' };
    return this.start({
      lv,
      kind: 'translation',
      trigger: 'user',
      acknowledgeUnknownOutcome: opts.acknowledgeUnknownOutcome ?? false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** 발음(독음) 생성은 별도의 명시 요청으로만 실행한다. 번역은 건드리지 않는다. */
  async requestPronunciation(
    lyricsVersionId: string,
    opts: { regenerate?: boolean; acknowledgeUnknownOutcome?: boolean; signal?: CancelSignal } = {},
  ): Promise<TranslationOutcome> {
    const { store } = this.deps;
    const lv = await store.getLyricsVersion(lyricsVersionId);
    if (!lv) return { kind: 'skipped', reason: 'no-lyrics' };
    if (lv.language !== 'ja' && lv.language !== 'mixed') return { kind: 'skipped', reason: 'not-japanese' };
    const existing = selectPronunciation(await store.listPronunciations(lv.id));
    if (existing && !opts.regenerate) return { kind: 'existing', origin: existing.origin, versionId: existing.id };
    return this.start({
      lv,
      kind: 'pronunciation',
      trigger: 'user',
      acknowledgeUnknownOutcome: opts.acknowledgeUnknownOutcome ?? false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** 동시 요청 합치기: 검사와 등록 사이에 await가 없어야 한다. */
  private start(plan: JobPlan): Promise<TranslationOutcome> {
    const key = `${plan.lv.id}:${groupOf(plan.kind)}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.run(plan).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async run(plan: JobPlan): Promise<TranslationOutcome> {
    const { store, clock, ids, logger } = this.deps;
    const { lv, kind } = plan;

    // ---- 실행 조건
    if (lv.kind === 'instrumental') return { kind: 'skipped', reason: 'instrumental' };
    const lines = translatableLines(lv);
    if (lines.length === 0) return { kind: 'skipped', reason: 'no-lyrics' };
    if (kind !== 'pronunciation' && lv.language === 'ko') return { kind: 'skipped', reason: 'target-language' };
    const chars = lines.reduce((n, l) => n + l.text.length, 0);
    if (lines.length > this.policy.maxLines || chars > this.policy.maxSourceChars) {
      return { kind: 'skipped', reason: 'too-large' };
    }
    if (plan.trigger === 'auto' && !(await store.getTranslationSettings()).autoTranslate) {
      return { kind: 'skipped', reason: 'auto-disabled' };
    }
    const unknown = await store.listJobs({ lyricsVersionId: lv.id, status: 'unknown_outcome' });
    const overlapping = unknown.some(
      (j) => groupOf(j.kind) === groupOf(kind) || j.kind === 'translation+pronunciation',
    );
    if (overlapping && (plan.trigger === 'auto' || !plan.acknowledgeUnknownOutcome)) {
      return { kind: 'skipped', reason: 'unknown-outcome-pending' };
    }
    const provider = await this.deps.providers.active();
    if (!provider) return { kind: 'skipped', reason: 'no-provider' };
    if (!(await store.reserveUsage(utcDay(clock.nowEpochMs()), chars, this.policy.maxRequestsPerDay))) {
      return { kind: 'skipped', reason: 'budget' };
    }

    // ---- 작업 기록 후 요청
    const wantTranslation = kind !== 'pronunciation';
    const wantReading = kind !== 'translation';
    const built = buildTranslationRequest(lv, { wantTranslation, wantReading });
    const now = clock.nowEpochMs();
    const job: TranslationJob = {
      id: ids.next('job'),
      lyricsVersionId: lv.id,
      kind,
      status: 'in_flight',
      providerId: provider.providerId,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      createdAtEpochMs: now,
      updatedAtEpochMs: now,
      failure: null,
    };
    await store.createJob(job);
    logger.info('ai.job.start', {
      jobId: job.id,
      kind,
      trigger: plan.trigger,
      providerId: provider.providerId,
      model: provider.model,
      lines: lines.length,
      sourceChars: chars,
    });

    let rawText: string;
    let refused: boolean;
    try {
      const resp = await provider.translate(
        {
          jobId: job.id,
          system: built.system,
          user: built.user,
          responseSchema: built.responseSchema,
          maxOutputTokens: Math.min(16_000, chars * 4 + 512),
        },
        plan.signal,
      );
      rawText = resp.rawText;
      refused = resp.refused === true;
    } catch (e) {
      const failure = this.toFailure(e, kind);
      const status =
        failure.kind === 'aborted' ? 'cancelled' : failure.billedRisk === 'possible' ? 'unknown_outcome' : 'failed';
      await store.updateJob(job.id, status, failure, clock.nowEpochMs());
      logger.warn('ai.job.failed', { jobId: job.id, status, kind: failure.kind });
      return { kind: 'failed', jobId: job.id, failure };
    }

    // ---- 검증
    const v = validateTranslationResponse(rawText, built, refused);
    const at = clock.nowEpochMs();
    const provenance = { providerId: provider.providerId, model: provider.model, promptVersion: PROMPT_VERSION };
    let translation: NewTranslation | null = null;
    let pronunciation: NewPronunciation | null = null;
    const failedParts: Array<{ part: 'translation' | 'pronunciation'; issues: ValidationIssue[] }> = [];

    if (v.translation) {
      if (v.translation.ok) {
        translation = {
          id: ids.next('tr'),
          lyricsVersionId: lv.id,
          origin: 'ai',
          lines: v.translation.lines,
          sourceTextHash: lv.textHash,
          provenance,
          createdAtEpochMs: at,
        };
      } else failedParts.push({ part: 'translation', issues: v.translation.issues });
    }
    if (v.reading) {
      if (v.reading.ok) {
        const pl: NewPronunciation['lines'] = {};
        for (const [id, kana] of Object.entries(v.reading.lines)) pl[id] = { kana, hangul: kanaToHangul(kana) };
        pronunciation = {
          id: ids.next('pr'),
          lyricsVersionId: lv.id,
          origin: 'ai',
          lines: pl,
          sourceTextHash: lv.textHash,
          provenance,
          createdAtEpochMs: at,
        };
      } else failedParts.push({ part: 'pronunciation', issues: v.reading.issues });
    }

    const validationFailure = (parts: typeof failedParts): JobFailure => {
      const issues = parts.flatMap((p) => p.issues);
      const isRefusal = issues.some((i) => i.code === 'REFUSAL');
      const scope = parts.length === 2 ? 'all' : (parts[0]?.part ?? 'all');
      return {
        kind: isRefusal ? 'refusal' : 'invalid_response',
        message: issues
          .slice(0, 5)
          .map((i) => `${i.code}${i.lineId ? `@${i.lineId}` : ''}`)
          .join(', '),
        retryScope: isRefusal ? 'none' : scope,
        billedRisk: 'none',
      };
    };

    // 거절 신호가 하나라도 있으면 응답 전체를 신뢰하지 않는다(유효해 보이는 부분도 저장하지 않음).
    const refusedAny = failedParts.some((p) => p.issues.some((i) => i.code === 'REFUSAL'));
    if (refusedAny) {
      translation = null;
      pronunciation = null;
    }
    if (!translation && !pronunciation) {
      const failure = validationFailure(failedParts);
      await store.updateJob(job.id, 'failed', failure, at);
      logger.warn('ai.job.invalid', { jobId: job.id, failure: failure.message });
      return { kind: 'failed', jobId: job.id, failure };
    }

    const partialFailure = failedParts.length > 0 ? validationFailure(failedParts) : null;
    try {
      await store.commitAiResult({ jobId: job.id, translation, pronunciation, partialFailure, atEpochMs: at });
    } catch (e) {
      const failure: JobFailure = {
        kind: 'storage',
        message: redactText(e instanceof Error ? e.message : String(e), this.deps.secrets.known()),
        retryScope: 'none',
        billedRisk: 'none',
      };
      try {
        await store.updateJob(job.id, 'failed', failure, clock.nowEpochMs());
      } catch {
        // 저장소 자체가 실패한 경우: 작업은 in_flight로 남고 다음 시작 시 unknown_outcome이 된다.
      }
      logger.error('ai.job.storage_failed', { jobId: job.id });
      return { kind: 'failed', jobId: job.id, failure };
    }
    logger.info('ai.job.completed', { jobId: job.id, partial: partialFailure !== null });
    return {
      kind: 'created',
      jobId: job.id,
      translationId: translation?.id ?? null,
      pronunciationId: pronunciation?.id ?? null,
      partialFailure,
    };
  }

  private toFailure(e: unknown, kind: JobKind): JobFailure {
    const known = this.deps.secrets.known();
    const scope: JobFailure['retryScope'] =
      kind === 'pronunciation' ? 'pronunciation' : kind === 'translation' ? 'translation' : 'all';
    if (e instanceof ProviderError) {
      const noRetry = e.kind === 'auth' || e.kind === 'bad_request';
      return {
        kind: e.kind,
        message: redactText(e.message, known),
        retryScope: noRetry ? 'none' : scope,
        billedRisk: e.billedRisk,
        ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
      };
    }
    return {
      kind: 'unknown',
      message: redactText(e instanceof Error ? e.message : String(e), known),
      retryScope: scope,
      billedRisk: 'possible',
    };
  }
}
