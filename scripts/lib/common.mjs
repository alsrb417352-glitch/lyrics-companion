// 검사 스크립트 공통 유틸. Windows의 공백·한글 경로에서도 동작하도록 셸을 거치지 않고 node로 직접 실행한다.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** node_modules에 설치된 패키지의 실행 파일 경로(셸·.cmd 래퍼 없이 실행하기 위함) */
export function binPath(pkg, binName = pkg) {
  const pkgJson = join(ROOT, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(pkgJson)) {
    throw new Error(`${pkg}가 설치되어 있지 않습니다. 먼저 "npm ci"를 실행하세요.`);
  }
  const pj = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[binName];
  if (!rel) throw new Error(`${pkg}에서 실행 파일 ${binName}을 찾을 수 없습니다.`);
  return join(dirname(pkgJson), rel);
}

/** node <script> args... 를 ROOT에서 실행. 셸을 쓰지 않으므로 경로 인용 문제가 없다. */
export function runNode(script, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: {
      ...process.env,
      // node:sqlite 실험 기능 경고 숨김(동작에는 영향 없음)
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      FORCE_COLOR: process.env.FORCE_COLOR ?? (process.stdout.isTTY ? '1' : '0'),
    },
  });
  return {
    code: res.status ?? 1,
    durationMs: Date.now() - started,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
  };
}

export function hasNonAscii(s) {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(s);
}
