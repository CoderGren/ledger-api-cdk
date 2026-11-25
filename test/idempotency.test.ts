import { describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain/errors.js';
import { IDEMPOTENCY_TTL_SECONDS, type Caller } from '../src/domain/service.js';
import { createRoutes } from '../src/handlers/routes.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeService, newKey } from './helpers.js';

const alice: Caller = { principal: 'sub:alice' };
const bob: Caller = { principal: 'sub:bob' };

describe('L-M4: POST /accounts honors Idempotency-Key', () => {
  it('requires a key', async () => {
    const { service } = makeService();
    await expect(service.createAccount({ name: 'A' }, undefined)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a retried create returns the same account and creates nothing new', async () => {
    const { service, repo } = makeService();
    const key = newKey();
    const first = await service.createAccount({ name: 'Savings', currency: 'EUR' }, key);
    const again = await service.createAccount({ name: 'Savings', currency: 'EUR' }, key);
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ account: first.account, replayed: true });
    expect(repo.accounts.size).toBe(1);
  });

  it('the same key with a different body is a 409', async () => {
    const { service } = makeService();
    const key = newKey();
    await service.createAccount({ name: 'A' }, key);
    await expect(service.createAccount({ name: 'B' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('over HTTP: 201 then 200 with the same id and idempotent-replayed: true', async () => {
    const routes = createRoutes(makeService().service, { authMode: 'none' });
    const ev = { headers: { 'idempotency-key': 'acct-key-0001' }, body: '{"name":"A"}', isBase64Encoded: false } as unknown as HttpEvent;
    const r1 = await routes.createAccount(ev);
    const r2 = await routes.createAccount(ev);
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 200]);
    expect(JSON.parse(r2.body!).id).toBe(JSON.parse(r1.body!).id);
    expect(r2.headers?.['idempotent-replayed']).toBe('true');
    const noKey = await routes.createAccount({ ...ev, headers: {} } as HttpEvent);
    expect(noKey.statusCode).toBe(400);
  });
});

describe('idempotency keys are scoped per caller', () => {
  it('two callers can use the same key without seeing each other’s results', async () => {
    const { service } = makeService();
    const key = 'shared-key-123';
    const a = await service.createAccount({ name: 'Alice' }, key, alice);
    const b = await service.createAccount({ name: 'Bob' }, key, bob);
    expect(b.replayed).toBe(false);
    expect(b.account.id).not.toBe(a.account.id);
  });

  it('JWT sub from the authorizer context becomes the scope', async () => {
    const { service, repo } = makeService();
    const routes = createRoutes(service, { authMode: 'jwt' });
    const ev = {
      headers: { 'idempotency-key': 'jwt-key-0001' },
      body: '{"name":"A"}',
      isBase64Encoded: false,
      requestContext: { authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    } as unknown as HttpEvent;
    await routes.createAccount(ev);
    expect([...repo.idempotency.keys()]).toEqual(['sub:user-1#jwt-key-0001']);
  });
});

describe('TTL and failure semantics', () => {
  it('a key is honored for 7 days, then treated as unused even before TTL deletion', async () => {
    const { service, clock } = makeService();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
    const body = { fromAccountId: funding, toAccountId: a, amountCents: 100 };
    const key = newKey();
    const first = await service.postTransfer(body, key);
    clock.advanceSeconds(IDEMPOTENCY_TTL_SECONDS - 60);
    expect((await service.postTransfer(body, key)).transaction.id).toBe(first.transaction.id);
    clock.advanceSeconds(120);
    const later = await service.postTransfer(body, key);
    expect(later.replayed).toBe(false);
    expect(later.transaction.id).not.toBe(first.transaction.id);
    expect((await service.getBalance(a)).balanceCents).toBe(200);
  });

  it('a failed request does not consume the key', async () => {
    const { service } = makeService();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
    const b = (await service.createAccount({ name: 'B' }, newKey())).account.id;
    const key = newKey();
    await expect(service.postTransfer({ fromAccountId: a, toAccountId: b, amountCents: 50 }, key)).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    await service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: 50 }, newKey());
    const retried = await service.postTransfer({ fromAccountId: a, toAccountId: b, amountCents: 50 }, key);
    expect(retried.replayed).toBe(false);
  });

  it('retries contended commits (TransactionConflict) a bounded number of times', async () => {
    const { service, repo } = makeService();
    const funding = (await service.createFundingAccount({ name: 'F' })).id;
    const a = (await service.createAccount({ name: 'A' }, newKey())).account.id;
    const realCommit = repo.commit.bind(repo);
    let failures = 2;
    let calls = 0;
    repo.commit = async (...args) => {
      calls++;
      if (failures-- > 0) throw new LedgerError('CONCURRENT_UPDATE', 'conflict');
      return realCommit(...args);
    };
    const ok = await service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: 5 }, newKey());
    expect(ok.replayed).toBe(false);
    expect(calls).toBe(3);

    failures = 10;
    calls = 0;
    await expect(service.postTransfer({ fromAccountId: funding, toAccountId: a, amountCents: 5 }, newKey())).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
    });
    expect(calls).toBe(3);
    expect((await service.getBalance(a)).balanceCents).toBe(5);
  });
});
