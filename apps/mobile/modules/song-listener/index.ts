import { requireOptionalNativeModule, type NativeModule } from 'expo';

/**
 * 소리로 싱크 맞추기(docs/plan.md D-44) 듣기 모듈(JS 측 타입). 구현: ios/SongListenerModule.swift
 * iPhone 마이크로 스피커 소리를 듣고 기기 안 음성 인식(iOS 26 이상)으로 알아들은 말과 시각을 모은다.
 * iPhone이 아니면(Android·웹) null 이다. 값은 원시 값 그대로이며 검사·해석은 core heard-audio.ts가 한다.
 */

/** 준비 상태 원시 값: { ok, reason?, route } (core mapListenReadiness로 해석) */
export type ListenReadinessRaw = Record<string, unknown>;
/** 한 번 받아 온 결과 원시 값: { segments, samples, audioMs, levelDb?, route, error? } (core parseListenChunk로 검사) */
export type ListenChunkRaw = Record<string, unknown>;

export declare class SongListenerNativeModule extends NativeModule {
  check(locale: string): Promise<ListenReadinessRaw>;
  prepare(locale: string): Promise<ListenReadinessRaw>;
  start(locale: string, hints: string[]): Promise<void>;
  drain(): Promise<ListenChunkRaw>;
  stop(): Promise<ListenChunkRaw>;
  cancel(): Promise<void>;
}

export const SongListener = requireOptionalNativeModule<SongListenerNativeModule>('SongListener');
