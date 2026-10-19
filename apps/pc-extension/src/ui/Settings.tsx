import { useCallback, useEffect, useState } from 'react';
import {
  BACKUP_LIMITS,
  backupFileName,
  checkModelName,
  LATEST_SCHEMA_VERSION,
  parseBackup,
  PROVIDER_PRESETS,
  suggestModelIds,
  validateProviderConfig,
  type BackupSummary,
  type ImportReport,
  type ReasoningEffort,
  type UserDataExport,
} from '@lyrics-companion/core';
import { downloadTextFile, localStamp, pickTextFile } from '../adapters/files';
import type { SecretHostStatus } from '../adapters/native-secret-store';
import { DEFAULT_LYRICS_LEAD_MS, originOf, type AppServices } from '../services';
import { Button, Chip, Note, useSessionState, type Msg } from './common';

/** 화면에 보여 줄 추론 강도(ChatGPT 표기와 맞춤). null = 보내지 않음(일반 모델) */
const EFFORT_CHOICES: Array<{ value: ReasoningEffort | null; label: string }> = [
  { value: null, label: '보내지 않음' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

/** 비슷한 이름이 없을 때 보여 줄 최신 모델 수 */
const RECENT_MODEL_COUNT = 24;

function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function reportText(r: ImportReport): string {
  return [
    `곡 ${r.songsAdded}개 추가`,
    r.songsExisting ? `이미 있던 곡 ${r.songsExisting}개` : null,
    `번역 ${r.translationsAdded}개 · 발음 ${r.pronunciationsAdded}개 추가`,
    r.linksRelinked ? `백업 번역으로 연결 ${r.linksRelinked}곡` : null,
    r.linksKept ? `이 PC 번역 유지 ${r.linksKept}곡` : null,
    r.conflicts ? `내용이 달라 건너뜀 ${r.conflicts}개` : null,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
}

const HOST_TEXT: Record<SecretHostStatus | 'checking', string> = {
  checking: '확인 중…',
  ok: '설치됨 — 키는 Windows 보안 저장소(DPAPI, 현재 사용자)에 암호화되어 보관됩니다.',
  missing:
    '설치되지 않음 — 키를 저장하려면 docs/pc-install.md의 "보안 저장소 도우미 설치"를 한 번 실행하세요(install.ps1).',
  error: '응답 없음 — 도우미 설치 상태를 확인하세요(docs/pc-install.md).',
};

type Pending = { name: string; data: UserDataExport; summary: BackupSummary };

/** 백업 내보내기·가져오기(REQ-ST-04). iPhone 앱과 같은 파일 형식이라 서로 옮길 수 있다. */
function BackupSection(props: { services: AppServices }) {
  const { services } = props;
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 200) : '실패했습니다', danger: true });
    } finally {
      setBusy(false);
    }
  };

  const onExport = () =>
    run(async () => {
      const data = await services.store.exportUserData(LATEST_SCHEMA_VERSION, services.clock.nowEpochMs());
      const fileName = backupFileName(localStamp(services.clock.nowEpochMs()));
      downloadTextFile(fileName, JSON.stringify(data), 'application/json');
      setMsg({ text: `백업 파일을 다운로드 폴더에 저장했습니다: ${fileName}` });
    });

  const onPick = () =>
    run(async () => {
      setPending(null);
      const picked = await pickTextFile('.json,application/json', BACKUP_LIMITS.maxChars);
      if (picked.canceled) return;
      if ('error' in picked) {
        setMsg({ text: picked.error, danger: true });
        return;
      }
      const parsed = parseBackup(picked.text, LATEST_SCHEMA_VERSION);
      if (!parsed.ok) {
        setMsg({ text: `가져올 수 없는 파일입니다: ${parsed.error}`, danger: true });
        return;
      }
      setPending({ name: picked.name, data: parsed.data, summary: parsed.summary });
    });

  const onConfirm = (p: Pending) =>
    run(async () => {
      const report = await services.store.importUserData(p.data, services.clock.nowEpochMs());
      setPending(null);
      // 지금 재생 중인 곡도 저장소 기준으로 다시 연다(저장된 번역이 있으면 AI를 부르지 않음).
      await services.session.reloadCurrent();
      setMsg({ text: `가져오기 완료 — ${reportText(report)}` });
    });

  return (
    <section className="settings-section">
      <h3>백업 · iPhone과 주고받기</h3>
      <Note>
        iPhone 앱(설정 › 백업)에서 만든 백업 파일을 여기서 가져오면 내 번역·발음·싱크 기록이 PC에도 생깁니다. 반대로
        여기서 만든 파일을 iPhone에서 가져올 수도 있습니다. 백업에는 API 키·AI 제공자 설정·자동 번역 동의가 들어가지
        않습니다.
      </Note>
      <div className="row wrap">
        <Button
          kind="primary"
          icon="download"
          label="백업 파일 만들기"
          onClick={() => void onExport()}
          disabled={busy}
        />
        <Button icon="upload" label="백업 가져오기" onClick={() => void onPick()} disabled={busy} />
      </div>
      {pending ? (
        <div className="card">
          <strong>{pending.name}</strong>
          <Note>
            {fmtDate(pending.summary.exportedAtEpochMs)}에 만든 백업 · 곡 {pending.summary.songs}개 · 내 번역{' '}
            {pending.summary.userTranslations}개 · AI 번역 {pending.summary.aiTranslations}개 · 내 발음{' '}
            {pending.summary.userPronunciations}개 · AI 발음 {pending.summary.aiPronunciations}개
            {pending.summary.lyricsTranslations + pending.summary.lyricsPronunciations > 0
              ? ` · 가사에 포함된 번역 ${pending.summary.lyricsTranslations}개 · 발음 ${pending.summary.lyricsPronunciations}개`
              : ''}
          </Note>
          <Note>
            이 PC에 있는 데이터는 지우거나 바꾸지 않고 없는 것만 추가합니다. 같은 곡이 양쪽에 있으면 내 번역이 있는 쪽을
            보여 줍니다.
          </Note>
          <div className="row">
            <Button kind="primary" label="가져오기" onClick={() => void onConfirm(pending)} disabled={busy} />
            <Button label="취소" onClick={() => setPending(null)} disabled={busy} />
          </div>
        </div>
      ) : null}
      {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
    </section>
  );
}

/**
 * 설정: AI 제공자·API 키(REQ-TR-01, REQ-SEC-01/03, REQ-PC-02), 자동 번역 동의(REQ-TR-13, REQ-SEC-05), 싱크 보정, 백업.
 * API 키는 Windows 보안 저장소 도우미(DPAPI)에만 저장하고 화면에는 끝 4자리만 보인다. 입력칸은 저장 후 비운다.
 */
export function Settings(props: { services: AppServices }) {
  const { services } = props;
  const { store, keys } = services;
  const [providerId, setProviderId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [structured, setStructured] = useState(true);
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [host, setHost] = useState<SecretHostStatus | 'checking'>('checking');
  const [auto, setAuto] = useState(false);
  const [usage, setUsage] = useState<{ requests: number; sourceChars: number } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  // 모델 목록(D-39): 이 키로 쓸 수 있는 모델 ID. null = 아직 불러오지 않음
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsMsg, setModelsMsg] = useState<Msg>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const modelCheck = checkModelName(model, baseUrl);
  const modelSuggestions = models ? suggestModelIds(model, models) : [];
  const modelChoices = models
    ? modelSuggestions.length > 0
      ? modelSuggestions
      : models.slice(0, RECENT_MODEL_COUNT)
    : [];
  const modelListed = models !== null && model.trim() !== '' && models.includes(model.trim());
  const globalOffset = useSessionState(services.session).globalOffsetMs;
  const fmt = (ms: number) => `${ms > 0 ? '+' : ''}${(ms / 1000).toFixed(2)}초`;

  const reload = useCallback(async () => {
    setHost('checking');
    const status = await services.secretStatus();
    setHost(status);
    const cfg = await store.getProviderConfig();
    if (cfg) {
      setProviderId(cfg.providerId);
      setBaseUrl(cfg.baseUrl);
      setModel(cfg.model);
      setStructured(cfg.structuredOutput);
      setEffort(cfg.reasoningEffort);
      setKeyHint(status === 'ok' ? await keys.hint(cfg.providerId) : null);
      const origin = originOf(cfg.baseUrl);
      setAllowed(origin ? await services.permissions.has(origin) : false);
    }
    setAuto((await store.getTranslationSettings()).autoTranslate);
    setUsage(await store.getUsage(utcDay(services.clock.nowEpochMs())));
  }, [store, keys, services]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const validated = () =>
    validateProviderConfig({ providerId, baseUrl, model, structuredOutput: structured, reasoningEffort: effort });

  const saveConfig = async () => {
    const r = validated();
    if (!r.ok) {
      setMsg({ text: r.error, danger: true });
      return;
    }
    const origin = originOf(r.config.baseUrl);
    // 확장 프로그램이 이 주소로 요청을 보낼 수 있게 사용자에게 허용을 받는다(클릭 안에서만 가능).
    const ok = origin ? await services.permissions.request(origin) : false;
    setAllowed(ok);
    await store.setProviderConfig(r.config);
    setKeyHint(host === 'ok' ? await keys.hint(r.config.providerId) : null);
    // 저장은 막지 않되(목록을 못 받는 호환 서버도 있음), 틀렸을 가능성이 보이면 함께 알린다.
    const warn =
      models !== null && !models.includes(r.config.model)
        ? ` 단, "${r.config.model}"은(는) 불러온 모델 목록에 없어 번역이 실패할 수 있습니다.`
        : modelCheck.warning
          ? ` 단, ${modelCheck.warning}`
          : '';
    setMsg(
      ok
        ? { text: `제공자 설정을 저장했습니다. 저장된 번역은 그대로 유지됩니다.${warn}`, danger: warn !== '' }
        : {
            text: `설정은 저장했지만 ${origin ?? '그 주소'} 접근을 허용하지 않아 번역 요청을 보내지 않습니다.`,
            danger: true,
          },
    );
  };

  const loadModels = async () => {
    // 모델 칸이 비어 있어도 목록은 불러올 수 있게 임시 이름으로 주소·ID만 검사한다.
    const r = validateProviderConfig({ providerId, baseUrl, model: model.trim() || 'x', structuredOutput: true });
    if (!r.ok) {
      setModelsMsg({ text: r.error, danger: true });
      return;
    }
    const origin = originOf(r.config.baseUrl);
    // 접근 허용 요청은 클릭 직후(다른 await 전)에 해야 브라우저가 창을 띄운다.
    const ok = origin ? await services.permissions.request(origin) : false;
    setAllowed(ok);
    if (!ok) {
      setModelsMsg({ text: `${origin ?? '그 주소'} 접근을 허용해야 모델 목록을 불러올 수 있습니다.`, danger: true });
      return;
    }
    setLoadingModels(true);
    setModelsMsg({ text: '모델 목록을 불러오는 중…' });
    try {
      const res = await services.listProviderModels(r.config.providerId, r.config.baseUrl);
      if (res.ok) {
        setModels(res.models);
        setModelsMsg({
          text: `이 키로 쓸 수 있는 모델 ${res.models.length}개를 불러왔습니다. 아래에서 눌러 고른 뒤 "제공자 설정 저장"을 누르세요.`,
        });
      } else {
        setModels(null);
        setModelsMsg({
          text: res.kind === 'no-key' ? '먼저 아래 "API 키" 칸에 키를 저장해 주세요.' : res.message,
          danger: true,
        });
      }
    } finally {
      setLoadingModels(false);
    }
  };

  const saveKey = async () => {
    const r = validated();
    if (!r.ok) {
      setMsg({ text: '먼저 제공자 설정을 올바르게 입력해 주세요.', danger: true });
      return;
    }
    try {
      await keys.set(r.config.providerId, keyInput);
      setKeyInput('');
      setKeyHint(await keys.hint(r.config.providerId));
      setMsg({ text: 'API 키를 Windows 보안 저장소에 저장했습니다.' });
    } catch (e) {
      setKeyInput('');
      setMsg({ text: e instanceof Error ? e.message : '키를 저장하지 못했습니다', danger: true });
    }
  };

  const deleteKey = async () => {
    if (!providerId) return;
    await keys.delete(providerId);
    setKeyHint(null);
    setMsg({ text: 'API 키를 삭제했습니다.' });
  };

  const toggleAuto = async (on: boolean) => {
    await store.setTranslationSettings({ autoTranslate: on });
    setAuto(on);
  };

  return (
    <div className="scroll">
      <div className="pad settings">
        <section className="settings-section">
          <h3>가사 싱크(모든 곡)</h3>
          <Note>
            가사가 노래보다 늦게 넘어가면 &quot;빨리&quot;, 먼저 넘어가면 &quot;늦게&quot;를 누르세요. 모든 곡에
            적용되고, 곡마다 다른 차이는 지금 재생 화면의 −/+로 따로 맞춥니다. 기본값 {fmt(DEFAULT_LYRICS_LEAD_MS)}.
          </Note>
          <div className="row">
            <Button label="늦게 0.05초" onClick={() => void services.session.setGlobalOffset(globalOffset - 50)} />
            <strong className="offset-value">{fmt(globalOffset)}</strong>
            <Button label="빨리 0.05초" onClick={() => void services.session.setGlobalOffset(globalOffset + 50)} />
            <Button
              label="기본값"
              onClick={() => void services.session.setGlobalOffset(DEFAULT_LYRICS_LEAD_MS)}
              disabled={globalOffset === DEFAULT_LYRICS_LEAD_MS}
            />
          </div>
        </section>

        <section className="settings-section">
          <h3>AI 번역 제공자</h3>
          <Note>
            OpenAI 호환 방식(Chat Completions)을 지원하는 제공자를 등록합니다. 모델 이름은 API용 이름을 그대로
            넣습니다(예: gpt-6-luna). 저장할 때 브라우저가 그 주소 접근 허용을 묻습니다.
          </Note>
          <div className="row wrap">
            {PROVIDER_PRESETS.map((p) => (
              <Chip
                key={p.providerId}
                label={p.label}
                on={providerId === p.providerId}
                onClick={() => {
                  setProviderId(p.providerId);
                  setBaseUrl(p.baseUrl);
                }}
              />
            ))}
          </div>
          <label className="field">
            <span>제공자 ID</span>
            <input
              className="input"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>API 주소(https)</span>
            <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            <span>모델 이름(API용 ID)</span>
            <input
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="예: gpt-6-luna"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          {modelCheck.warning ? <Note tone="danger">{modelCheck.warning}</Note> : null}
          {modelCheck.suggestion ? (
            <div className="row wrap">
              <Chip
                label={`${modelCheck.suggestion}(으)로 고치기`}
                on={false}
                onClick={() => setModel(modelCheck.suggestion ?? model)}
              />
            </div>
          ) : null}
          <div className="row">
            <Button
              label={loadingModels ? '불러오는 중…' : '모델 목록 불러오기'}
              onClick={() => void loadModels()}
              disabled={loadingModels}
            />
          </div>
          {modelsMsg ? <Note tone={modelsMsg.danger ? 'danger' : 'dim'}>{modelsMsg.text}</Note> : null}
          {models !== null && model.trim() !== '' ? (
            <Note tone={modelListed ? 'dim' : 'danger'}>
              {modelListed
                ? `"${model.trim()}"은(는) 이 키로 쓸 수 있는 모델입니다.`
                : `"${model.trim()}"은(는) 목록에 없습니다. 아래에서 고르세요.`}
            </Note>
          ) : null}
          {modelChoices.length > 0 ? (
            <div className="field">
              <span>
                {modelSuggestions.length > 0
                  ? '입력한 이름과 비슷한 모델'
                  : '최신 모델(입력한 이름과 비슷한 모델 없음)'}
              </span>
              <div className="row wrap">
                {modelChoices.map((id) => (
                  <Chip key={id} label={id} on={model.trim() === id} onClick={() => setModel(id)} />
                ))}
              </div>
            </div>
          ) : null}
          <label className="check">
            <input type="checkbox" checked={structured} onChange={(e) => setStructured(e.target.checked)} />
            구조화 출력(json_schema) 사용
          </label>
          <div className="field">
            <span>추론 강도(추론 모델만)</span>
            <div className="row wrap">
              {EFFORT_CHOICES.map((c) => (
                <Chip key={c.label} label={c.label} on={effort === c.value} onClick={() => setEffort(c.value)} />
              ))}
            </div>
          </div>
          {allowed === false ? (
            <Note tone="danger">이 주소 접근이 허용되지 않았습니다. 다시 저장해 허용해 주세요.</Note>
          ) : null}
          <Button kind="primary" label="제공자 설정 저장" onClick={() => void saveConfig()} />
        </section>

        <section className="settings-section">
          <h3>API 키</h3>
          <Note>보안 저장소 도우미: {HOST_TEXT[host]}</Note>
          <Note>
            키는 설정 파일·확장 프로그램 저장소·로그·백업에 들어가지 않습니다. 현재: {keyHint ?? '등록 안 됨'}
          </Note>
          <input
            className="input"
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="키 붙여넣기"
            autoComplete="off"
            spellCheck={false}
            aria-label="API 키"
            disabled={host !== 'ok'}
          />
          <div className="row">
            <Button
              kind="primary"
              label="키 저장"
              onClick={() => void saveKey()}
              disabled={!keyInput || host !== 'ok'}
            />
            <Button kind="danger" label="키 삭제" onClick={() => void deleteKey()} disabled={!keyHint} />
            <Button label="다시 확인" onClick={() => void reload()} />
          </div>
        </section>

        <section className="settings-section">
          <h3>자동 번역</h3>
          <label className="check">
            <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
            번역이 없는 곡을 재생하면 자동으로 번역
          </label>
          <Note>
            켜면 저장된 번역이 없는 곡의 가사 원문 전체가 위에 등록한 AI 제공자에게 전송되고, 제공자 요금이 청구됩니다.
            하루 최대 30회까지만 요청합니다. 한 번 번역한 곡은 이 PC에 저장되어 다시 요청하지 않습니다. 꺼 두어도 곡
            화면의 버튼으로 한 곡씩 요청할 수 있습니다.
          </Note>
          {usage ? (
            <Note>
              오늘(UTC) 요청: {usage.requests}회 · 보낸 원문 {usage.sourceChars.toLocaleString()}자
            </Note>
          ) : null}
        </section>

        <BackupSection services={services} />

        <section className="settings-section">
          <h3>정보</h3>
          <Note>
            가사·번역·발음·싱크 보정값은 이 PC의 브라우저 확장 프로그램 저장소(IndexedDB, SQLite 파일)에만 저장되고,
            백업 파일을 만들 때만 밖으로 나갑니다. 확장 프로그램을 제거하면 이 데이터도 지워지므로 먼저 백업하세요. 가사
            출처: LRCLIB. 곡 정보 조회: Apple iTunes.
          </Note>
          {services.migratedFrom ? (
            <Note>저장소를 v{services.migratedFrom}에서 최신 형식으로 바꾸기 전에 사본을 만들어 두었습니다.</Note>
          ) : null}
        </section>
        {msg ? <Note tone={msg.danger ? 'danger' : 'dim'}>{msg.text}</Note> : null}
      </div>
    </div>
  );
}
