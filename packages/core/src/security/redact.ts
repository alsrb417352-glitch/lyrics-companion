/**
 * 비밀정보 마스킹. 로그·오류 메시지·작업 이력에 들어가기 전에 반드시 통과시킨다.
 * 1) 런타임에 등록된 실제 키 값(정확 일치)  2) 알려진 키 형식 패턴  3) 민감한 필드 이름
 */

export const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SENSITIVE_KEY = /authorization|api[-_]?key|secret|token|password|cookie|x-api-key|x-goog-api-key/i;

export class SecretRegistry {
  private readonly values = new Set<string>();

  register(value: string): void {
    if (value.length >= 8) this.values.add(value);
  }

  unregister(value: string): void {
    this.values.delete(value);
  }

  known(): readonly string[] {
    return [...this.values];
  }
}

export function redactText(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const k of known) {
    if (k.length >= 8) out = out.split(k).join(REDACTED);
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export function redactValue(value: unknown, known: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return '[DEPTH]';
  if (typeof value === 'string') return redactText(value, known);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, known, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message, known) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, known, depth + 1);
    }
    return out;
  }
  return value;
}
