// PC 확장 프로그램의 Windows 보안 저장소 도우미(apps/pc-extension/native-host/secret-host.cmd) 시험.
// 브라우저가 하는 것처럼 [4바이트 길이 + JSON]을 표준 입력으로 보내고 답을 읽는다. Windows에서만 실행한다.
// 저장 폴더는 LC_SECRET_DIR로 저장소 안 .tmp/에 둔다(사용자 프로필·레지스트리를 건드리지 않음). 시험 값은 실행 중에 만든다.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from '../lib/common.mjs';

const HOST = join(ROOT, 'apps', 'pc-extension', 'native-host', 'secret-host.cmd');
const ORIGIN = 'chrome-extension://ggohabnpccimkbiclbehihpgiocjedhd/';
const DIR = join(ROOT, '.tmp', `secret-host-test-${process.pid}`);
const onWindows = process.platform === 'win32';

function call(message, origin = ORIGIN) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const len = Buffer.alloc(4);
  len.writeInt32LE(body.length);
  const res = spawnSync('cmd.exe', ['/d', '/c', HOST, origin, '--parent-window=0'], {
    input: Buffer.concat([len, body]),
    env: { ...process.env, LC_SECRET_DIR: DIR },
    timeout: 60_000,
    windowsHide: true,
  });
  const out = res.stdout ?? Buffer.alloc(0);
  if (out.length < 4) throw new Error(`응답 없음: ${res.stderr?.toString() ?? ''}`);
  const n = out.readInt32LE(0);
  return JSON.parse(out.subarray(4, 4 + n).toString('utf8'));
}

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe.skipIf(!onWindows)('Windows 보안 저장소 도우미(DPAPI)', () => {
  it('[REQ-PC-02][REQ-SEC-01] 키를 DPAPI로 암호화해 저장하고 같은 사용자만 다시 읽으며, 삭제할 수 있다', () => {
    mkdirSync(DIR, { recursive: true });
    const value = `test-value-${randomUUID()}`;
    expect(call({ op: 'ping' })).toEqual({ ok: true });
    expect(call({ op: 'get', name: 'ai-key.openai' })).toEqual({ ok: true, value: null });
    expect(call({ op: 'set', name: 'ai-key.openai', value })).toEqual({ ok: true });
    // 디스크에는 암호문만 있다(평문·키 이름 이외 정보 없음)
    const files = readdirSync(DIR);
    expect(files).toEqual(['ai-key.openai.bin']);
    const raw = readFileSync(join(DIR, files[0]));
    expect(raw.includes(Buffer.from(value, 'utf8'))).toBe(false);
    expect(raw.includes(Buffer.from(value, 'utf16le'))).toBe(false);
    expect(call({ op: 'get', name: 'ai-key.openai' })).toEqual({ ok: true, value });
    expect(call({ op: 'delete', name: 'ai-key.openai' })).toEqual({ ok: true });
    expect(existsSync(join(DIR, 'ai-key.openai.bin'))).toBe(false);
    expect(call({ op: 'get', name: 'ai-key.openai' })).toEqual({ ok: true, value: null });
  }, 120_000);

  it('[REQ-PC-02][REQ-SEC-04] 등록한 확장 프로그램이 아닌 호출자·경로 조작 이름·잘못된 요청은 거부한다', () => {
    expect(call({ op: 'ping' }, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')).toEqual({
      ok: false,
      error: 'forbidden-origin',
    });
    expect(call({ op: 'get', name: '../outside' })).toEqual({ ok: false, error: 'bad-name' });
    expect(call({ op: 'set', name: 'ai-key.x', value: '' })).toEqual({ ok: false, error: 'bad-value' });
    expect(call({ op: 'format-disk' })).toEqual({ ok: false, error: 'bad-op' });
  }, 120_000);
});
