// 비밀정보 검사기 자체 테스트. 키 형태 문자열은 소스에 남기지 않도록 실행 중에 조립한다.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../lib/common.mjs';
import { isForbiddenFileName, scanText } from '../lib/secret-patterns.mjs';
import { scanRepository } from '../scan-secrets.mjs';

const mk = (...parts) => parts.join('');

describe('비밀정보 검사기', () => {
  it('[REQ-SEC-02] 알려진 키 형식을 찾고 값은 가려서 보고한다', () => {
    const text = [
      `const a = "${mk('sk-', 'proj-', 'A'.repeat(30))}"`,
      `key: ${mk('sk-ant-', 'api03-', 'B'.repeat(30))}`,
      `google=${mk('AI', 'za', 'C'.repeat(35))}`,
      mk('-----BEGIN ', 'PRIVATE KEY-----'),
      `apiKey = "${'D'.repeat(32)}"`,
      'plain text without secrets',
    ].join('\n');
    const f = scanText(text);
    expect(f.map((x) => x.rule)).toEqual(
      expect.arrayContaining(['openai-key', 'anthropic-key', 'google-api-key', 'private-key', 'generic-assignment']),
    );
    expect(f.every((x) => !x.preview.includes('AAAA'))).toBe(true);
  });

  it('[REQ-SEC-02] 허용 표시가 있는 행과 일반 문장은 통과시킨다', () => {
    expect(scanText(`${mk('sk-', 'E'.repeat(30))} // secret-scan: allow`)).toEqual([]);
    expect(scanText('API 키는 OS 보안 저장소에만 저장한다. token 갱신 절차 참고')).toEqual([]);
  });

  it('[REQ-SEC-02] .env·키 파일은 이름만으로 금지 대상이다', () => {
    expect(isForbiddenFileName('.env')).toBe('env-file');
    expect(isForbiddenFileName('.env.local')).toBe('env-file');
    expect(isForbiddenFileName('.env.example')).toBeNull();
    expect(isForbiddenFileName('release.keystore')).toBe('key-material');
  });

  it('[REQ-SEC-02] 저장소 스캔이 임시 디렉터리의 비밀을 찾아낸다', () => {
    const dir = join(ROOT, '.tmp', 'scan-test', '공백 있는 폴더');
    rmSync(join(ROOT, '.tmp', 'scan-test'), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leak.txt'), `token=${mk('gh', 'p_', 'F'.repeat(36))}\n`);
    writeFileSync(join(dir, '.env'), 'X=1\n');
    const { findings } = scanRepository(join(ROOT, '.tmp', 'scan-test'));
    expect(findings.map((x) => x.rule).sort()).toEqual(['env-file', 'github-token']);
    rmSync(join(ROOT, '.tmp', 'scan-test'), { recursive: true, force: true });
  });
});
