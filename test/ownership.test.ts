import { describe, expect, it } from 'vitest';
import type { Caller } from '../src/domain/service.js';
import { createRoutes } from '../src/handlers/routes.js';
import type { HttpEvent } from '../src/handlers/http.js';
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

  it('over HTTP the JWT sub decides ownership', async () => {
    const { service, aliceAcct } = await setup();
    const routes = createRoutes(service);
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
