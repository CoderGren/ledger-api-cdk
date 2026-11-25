import { LedgerService } from '../src/domain/service.js';
import { InMemoryLedgerRepository } from '../src/store/memory-repository.js';

/** Deterministic service: sequential ids and a ticking clock. */
export function makeService() {
  let n = 0;
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = {
    advanceSeconds: (s: number) => {
      t += s * 1000;
    },
  };
  const repo = new InMemoryLedgerRepository(() => Math.floor(t / 1000));
  const service = new LedgerService({
    repo,
    newId: () => `id-${String(++n).padStart(6, '0')}`,
    now: () => new Date((t += 1000)).toISOString(),
    retryDelayMs: () => 0,
  });
  return { repo, service, clock };
}

let keyCounter = 0;
export const newKey = () => `test-key-${++keyCounter}`;
