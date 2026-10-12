import type { SecretStore } from '@lyrics-companion/core';

/** native-host/install.ps1이 등록하는 이름(Chrome·Edge 공통) */
export const SECRET_HOST = 'com.lyrics_companion.secret_store';

export type SecretHostStatus = 'ok' | 'missing' | 'error';

interface HostReply {
  ok?: unknown;
  value?: unknown;
  error?: unknown;
}

/**
 * core SecretStore 포트의 Windows 보안 저장소 구현(REQ-PC-02, 불변조건 8).
 * 키는 확장 프로그램 저장소(IndexedDB 등)에 두지 않고, 네이티브 메시징 도우미(native-host/secret-host.ps1)가
 * Windows DPAPI(현재 사용자 범위)로 암호화해 사용자 프로필 폴더에 보관한다.
 * - 도우미가 설치되지 않았으면 키는 "없음"으로 읽힌다(AI 번역이 'no-provider'로 건너뜀). 저장은 오류로 알린다.
 * - 키 값은 이 클래스의 반환값 외에 저장·로그하지 않는다(core ApiKeyManager가 요청 직전에만 읽음).
 */
export class NativeSecretStore implements SecretStore {
  constructor(private readonly host = SECRET_HOST) {}

  private call(msg: Record<string, string>): Promise<HostReply> {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.sendNativeMessage) {
        reject(new Error('missing'));
        return;
      }
      chrome.runtime.sendNativeMessage(this.host, msg, (reply: HostReply | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(/not found|forbidden/i.test(err.message ?? '') ? 'missing' : 'error'));
        else resolve(reply ?? {});
      });
    });
  }

  async status(): Promise<SecretHostStatus> {
    try {
      const r = await this.call({ op: 'ping' });
      return r.ok === true ? 'ok' : 'error';
    } catch (e) {
      return e instanceof Error && e.message === 'missing' ? 'missing' : 'error';
    }
  }

  async get(name: string): Promise<string | null> {
    let r: HostReply;
    try {
      r = await this.call({ op: 'get', name });
    } catch {
      return null; // 도우미 없음·실패 → 키 없음으로 본다(AI를 부르지 않는 쪽)
    }
    if (r.ok !== true) return null;
    return typeof r.value === 'string' && r.value.length > 0 ? r.value : null;
  }

  async set(name: string, value: string): Promise<void> {
    let r: HostReply;
    try {
      r = await this.call({ op: 'set', name, value });
    } catch (e) {
      throw new Error(
        e instanceof Error && e.message === 'missing'
          ? 'Windows 보안 저장소 도우미가 설치되지 않았습니다(설치 안내: docs/pc-install.md)'
          : '보안 저장소 도우미와 통신하지 못했습니다',
      );
    }
    if (r.ok !== true) throw new Error('보안 저장소에 저장하지 못했습니다');
  }

  async delete(name: string): Promise<void> {
    try {
      await this.call({ op: 'delete', name });
    } catch {
      // 도우미가 없으면 지울 키도 없다
    }
  }
}

/** 데모·테스트용 메모리 보안 저장소(실제 확장 프로그램에서는 쓰지 않음) */
export class MemorySecretStore implements SecretStore {
  private readonly m = new Map<string, string>();
  async get(name: string) {
    return this.m.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.m.set(name, value);
  }
  async delete(name: string) {
    this.m.delete(name);
  }
}
