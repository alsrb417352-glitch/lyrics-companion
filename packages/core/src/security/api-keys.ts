import type { SecretStore } from '../ports.js';
import type { SecretRegistry } from './redact.js';

/**
 * 사용자 AI API 키 관리. 키는 SecretStore(OS 보안 저장소)에만 저장한다.
 * 일반 설정·SQLite·로그·내보내기 파일에는 키를 쓰지 않는다. UI에는 존재 여부와 끝 4자리만 노출한다.
 */
export class ApiKeyManager {
  constructor(
    private readonly store: SecretStore,
    private readonly registry: SecretRegistry,
  ) {}

  private static slot(providerId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)) throw new Error('잘못된 providerId');
    return `ai-key.${providerId}`;
  }

  static validateKeyFormat(key: string): string | null {
    const trimmed = key.trim();
    if (trimmed.length < 8 || trimmed.length > 512) return '키 길이가 올바르지 않습니다';
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) return '키에 공백이나 제어 문자가 있습니다';
    return null;
  }

  async set(providerId: string, key: string): Promise<void> {
    const problem = ApiKeyManager.validateKeyFormat(key);
    if (problem) throw new Error(problem);
    const value = key.trim();
    const previous = await this.store.get(ApiKeyManager.slot(providerId));
    await this.store.set(ApiKeyManager.slot(providerId), value);
    this.registry.register(value);
    if (previous && previous !== value) this.registry.register(previous); // 이전 키도 계속 마스킹
  }

  async delete(providerId: string): Promise<void> {
    await this.store.delete(ApiKeyManager.slot(providerId));
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.store.get(ApiKeyManager.slot(providerId))) !== null;
  }

  /** 화면 표시용: 끝 4자리만 */
  async hint(providerId: string): Promise<string | null> {
    const v = await this.store.get(ApiKeyManager.slot(providerId));
    return v ? `••••${v.slice(-4)}` : null;
  }

  /** 요청 직전에만 호출한다. 반환값을 저장·로그하지 않는다. */
  async getForRequest(providerId: string): Promise<string | null> {
    const v = await this.store.get(ApiKeyManager.slot(providerId));
    if (v) this.registry.register(v);
    return v;
  }
}
