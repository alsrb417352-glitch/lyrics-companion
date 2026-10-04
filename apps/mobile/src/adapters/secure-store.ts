import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from '@lyrics-companion/core';

/**
 * core SecretStore 포트의 OS 보안 저장소 구현(iOS Keychain).
 * THIS_DEVICE_ONLY: iCloud 키체인·기기 백업으로 다른 기기에 옮겨지지 않는다(REQ-SEC-01).
 * 주의: iOS Keychain 항목은 앱을 지워도 남을 수 있다(docs/security.md).
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class ExpoSecretStore implements SecretStore {
  get(name: string): Promise<string | null> {
    return SecureStore.getItemAsync(name, OPTIONS);
  }
  set(name: string, value: string): Promise<void> {
    return SecureStore.setItemAsync(name, value, OPTIONS);
  }
  delete(name: string): Promise<void> {
    return SecureStore.deleteItemAsync(name, OPTIONS);
  }
}
