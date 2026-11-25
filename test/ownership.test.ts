import { describe, expect, it } from 'vitest';
import type { Caller } from '../src/domain/service.js';
import { createRoutes } from '../src/handlers/routes.js';
import { parseAuthMode, type HttpEvent } from '../src/handlers/http.js';
import { makeService, newKey } from './helpers.js';

const alice: Caller = { principal: 'sub:alice' };
const bob: Caller = { principal: 'sub:bob' };

async function setup() {
  const { service } = makeService();
  const aliceFunding = (await service.createFundingAccount({ name: 'Alice funding' }, alice.principal)).id;
  const aliceAcct = (await service.createAccount({ name: 'Alice' }, newKey(), alice)).account.id;
  const bobAcct = (await service.createAccount({ name: 'Bob' }, newKey(), bob)).account.id;
  const t = await service.postTransfer({ fromAccountId: aliceFunding, toAccountId: aliceAcct, amountCents: 1000 }, newKey(), alice);
  return { service, aliceFunding, aliceAcct, bobAcct, fundingTxn: t.transaction.id };
}

describe('L-M3: account ownership with the JWT authorizer on', () => {
  it("another caller's account is a 404 for balance and statement reads", async () => {
    const { service, aliceAcct } = await setup();
    expect((await service.getBalance(aliceAcct, alice)).balanceCents).toBe(1000);
    await expect(service.getBalance(aliceAcct, bob)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.listTransactions(aliceAcct, 10, undefined, bob)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only the owner can debit; anyone can be paid by id', async () => {
    const { service, aliceAcct, bobAcct } = await setup();
    await expect(
      service.postTransfer({ fromAccountId: aliceAcct, toAccountId: bobAcct, amountCents: 1 }, newKey(), bob),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await service.postTransfer({ fromAccountId: aliceAcct, toAccountId: bobAcct, amountCents: 250 }, newKey(), alice);
    expect((await service.getBalance(bobAcct, bob)).balanceCents).toBe(250);
  });

  it("an anonymous caller can't use an authenticated user's funding account", async () => {
    const { service, aliceFunding, bobAcct } = await setup();
    await expect(service.postTransfer({ fromAccountId: aliceFunding, toAccountId: bobAcct, amountCents: 1 }, newKey())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('only the owner of the debited account can reverse a transfer', async () => {
    const { service, fundingTxn } = await setup();
    await expect(service.reverse(fundingTxn, newKey(), bob)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.reverse(fundingTxn, newKey(), alice)).transaction.reversesTransactionId).toBe(fundingTxn);
  });

  it('README contract: the payer reverses, any time, once, only while the payee still holds the money', async () => {
    const { service, aliceAcct, bobAcct } = await setup();
    const pay = await service.postTransfer({ fromAccountId: aliceAcct, toAccountId: bobAcct, amountCents: 400 }, newKey(), alice);
    // The payee can't reverse a payment they received.
    await expect(service.reverse(pay.transaction.id, newKey(), bob)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // If the payee has moved the money on, the reversal can't overdraw them.
    await service.postTransfer({ fromAccountId: bobAcct, toAccountId: aliceAcct, amountCents: 300 }, newKey(), bob);
    await expect(service.reverse(pay.transaction.id, newKey(), alice)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await service.postTransfer({ fromAccountId: aliceAcct, toAccountId: bobAcct, amountCents: 300 }, newKey(), alice);
    const rev = await service.reverse(pay.transaction.id, newKey(), alice);
    await expect(service.reverse(pay.transaction.id, newKey(), alice)).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    // A reversal can't itself be reversed, even by the account it debited.
    await expect(service.reverse(rev.transaction.id, newKey(), bob)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('over HTTP the JWT sub decides ownership', async () => {
    const { service, aliceAcct } = await setup();
    const routes = createRoutes(service, { authMode: 'jwt' });
    const as = (sub: string) =>
      ({
        headers: {},
        pathParameters: { accountId: aliceAcct },
        requestContext: { authorizer: { jwt: { claims: { sub } } } },
      }) as unknown as HttpEvent;
    expect((await routes.getBalance(as('alice'))).statusCode).toBe(200);
    expect((await routes.getBalance(as('bob'))).statusCode).toBe(404);
  });
});

describe('L-N1: a JWT without `sub` fails closed', () => {
  const withClaims = (claims: Record<string, unknown> | undefined, extra: Partial<HttpEvent> = {}) =>
    ({
      headers: { 'idempotency-key': `nosub-${Math.random().toString(36).slice(2, 10)}` },
      isBase64Encoded: false,
      requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
      ...extra,
    }) as unknown as HttpEvent;

  it("Hanna's repro: an m2m token with no sub can't read or debit an anon-owned funding account (401)", async () => {
    const { service } = makeService();
    // Even if an operator created an anon-owned funding account, a sub-less token can't reach it.
    const funding = (await service.createFundingAccount({ name: 'F' }, 'anon')).id;
    const target = (await service.createAccount({ name: 'T' }, newKey(), alice)).account.id;
    const routes = createRoutes(service, { authMode: 'jwt' });
    const m2m = { client_id: 'm2m' };
    const debit = await routes.postTransfer(withClaims(m2m, { body: JSON.stringify({ fromAccountId: funding, toAccountId: target, amountCents: 100 }) }));
    expect(debit.statusCode).toBe(401);
    expect(JSON.parse(debit.body!).error.code).toBe('UNAUTHENTICATED');
    expect((await routes.getBalance(withClaims(m2m, { pathParameters: { accountId: funding } }))).statusCode).toBe(401);
    expect((await routes.createAccount(withClaims(m2m, { body: '{"name":"X"}' }))).statusCode).toBe(401);
    expect((await routes.getBalance(withClaims({ sub: '' }, { pathParameters: { accountId: funding } }))).statusCode).toBe(401);
    expect((await routes.getBalance(withClaims(undefined, { pathParameters: { accountId: funding } }))).statusCode).toBe(401);
    expect((await service.getBalance(funding)).balanceCents).toBe(0);
  });

  it('routes default to jwt mode, so a missing configuration fails closed', async () => {
    const { service } = makeService();
    const funding = (await service.createFundingAccount({ name: 'F' }, 'anon')).id;
    const res = await createRoutes(service).getBalance(withClaims(undefined, { pathParameters: { accountId: funding } }));
    expect(res.statusCode).toBe(401);
  });

  it('only the explicit demo mode uses the anon principal', async () => {
    const { service } = makeService();
    const funding = (await service.createFundingAccount({ name: 'F' }, 'anon')).id;
    const res = await createRoutes(service, { authMode: 'none' }).getBalance(withClaims(undefined, { pathParameters: { accountId: funding } }));
    expect(res.statusCode).toBe(200);
  });

  it('AUTH_MODE must be exactly jwt or none', () => {
    expect(parseAuthMode('jwt')).toBe('jwt');
    expect(parseAuthMode('none')).toBe('none');
    for (const bad of [undefined, '', 'JWT', 'off']) expect(() => parseAuthMode(bad)).toThrow(/AUTH_MODE/);
  });
});
