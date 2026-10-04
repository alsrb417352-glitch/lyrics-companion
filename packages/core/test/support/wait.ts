/** 조건이 참이 될 때까지 마이크로태스크·매크로태스크를 양보하며 대기(실제 시간 대기 없음) */
export async function waitFor(cond: () => boolean, label = 'condition', maxTurns = 2000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`waitFor timeout: ${label}`);
}
