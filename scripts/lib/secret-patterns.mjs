// 비밀정보 패턴(저장소 검사용). core의 런타임 마스킹(redact.ts)과 별개로, 커밋될 파일을 검사한다.

export const SECRET_RULES = [
  { id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'slack-token', re: /xox[abpr]-[A-Za-z0-9-]{10,}/g },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'bearer-literal', re: /Bearer\s+[A-Za-z0-9._~+/-]{30,}={0,2}/g },
  {
    id: 'generic-assignment',
    re: /(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{24,}['"]/gi,
  },
];

export const ALLOW_MARKER = 'secret-scan: allow';

/** 텍스트에서 비밀정보 후보를 찾는다. 값은 앞 4자만 남기고 가린다. */
export function scanText(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        findings.push({ rule: rule.id, line: i + 1, preview: `${m[0].slice(0, 4)}…(${m[0].length}자)` });
      }
    }
  });
  return findings;
}

export function isForbiddenFileName(name) {
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') return 'env-file';
  if (/\.(pem|p12|pfx|keystore|jks|mobileprovision)$/i.test(name)) return 'key-material';
  if (/^google-services\.json$|^GoogleService-Info\.plist$/.test(name)) return 'service-config';
  return null;
}
