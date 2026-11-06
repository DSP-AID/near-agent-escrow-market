#!/usr/bin/env node
/**
 * near-agent-escrow-market — automated test suite (DAiL bnty_0522)
 * Run with: node test_market.js   (no npm install, Node stdlib only)
 *
 * Equivalents of the DSP-AID demo-pack (bnty_0451) 7 tests, written against this
 * repository's market.js API, incl. the two hire() safety guards added by the polish:
 * unknown-buyer rejection and duplicate-order-id rejection.
 */

const assert = require("assert");
const { EscrowMarket } = require("./market.js");

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("============================================================");
console.log("RUNNING NEAR AGENT ESCROW TEST SUITE");
console.log("============================================================");

test("1. Happy path: Hire -> Deliver -> Accept releases funds to seller", () => {
  const m = new EscrowMarket();
  m.register("buyer_1", 100);
  m.register("seller_1", 20);
  m.listService("seller_1", "svc_test", "Test Task", 50);

  const ord = m.hire("buyer_1", "svc_test", "ord_1");
  assert.strictEqual(m.balance("buyer_1"), 50, "Buyer should be debited 50 immediately at intent time");
  assert.strictEqual(m.balance("seller_1"), 20, "Seller balance should not change yet");
  assert.strictEqual(m.verify().locked, 50, "50 tokens must be locked in escrow");

  m.deliver(ord);
  assert.strictEqual(m.verify().locked, 50, "Tokens must remain locked while delivered");

  m.accept(ord);
  assert.strictEqual(m.balance("buyer_1"), 50, "Buyer balance remains 50");
  assert.strictEqual(m.balance("seller_1"), 70, "Seller receives 50 tokens (20 + 50 = 70)");
  assert.strictEqual(m.verify().locked, 0, "Locked escrow balance must return to 0");
});

test("2. Dispute path: Dispute after delivery returns 100% of escrow to buyer", () => {
  const m = new EscrowMarket();
  m.register("buyer_2", 150);
  m.register("seller_2", 0);
  m.listService("seller_2", "svc_dispute", "Disputable Task", 60);

  const ord = m.hire("buyer_2", "svc_dispute", "ord_2");
  assert.strictEqual(m.balance("buyer_2"), 90);
  assert.strictEqual(m.verify().locked, 60);

  m.deliver(ord);
  m.dispute(ord);

  assert.strictEqual(m.balance("buyer_2"), 150, "Buyer must receive full 60 token refund (90 + 60 = 150)");
  assert.strictEqual(m.balance("seller_2"), 0, "Seller receives nothing");
  assert.strictEqual(m.verify().locked, 0, "Locked escrow balance must return to 0");
});

test("3. Insufficient balance rejects hire without modifying ledger", () => {
  const m = new EscrowMarket();
  m.register("poor_buyer", 10);
  m.register("seller_3", 0);
  m.listService("seller_3", "svc_expensive", "Expensive Task", 100);

  assert.throws(() => {
    m.hire("poor_buyer", "svc_expensive", "ord_3");
  }, /insufficient balance/);

  assert.strictEqual(m.balance("poor_buyer"), 10, "Buyer balance must remain untouched");
  assert.strictEqual(m.verify().locked, 0, "Locked tokens must remain 0");
});

test("4. Invalid state transition: Cannot accept an undelivered order", () => {
  const m = new EscrowMarket();
  m.register("buyer_4", 100);
  m.register("seller_4", 0);
  m.listService("seller_4", "svc_4", "Task 4", 30);

  const ord = m.hire("buyer_4", "svc_4", "ord_4");

  assert.throws(() => {
    m.accept(ord);
  }, /order not delivered/);

  assert.strictEqual(m.balance("seller_4"), 0, "Seller must not be credited on invalid accept");
});

test("5. Invalid state transition: Cannot double-deliver an order", () => {
  const m = new EscrowMarket();
  m.register("buyer_5", 100);
  m.register("seller_5", 0);
  m.listService("seller_5", "svc_5", "Task 5", 30);

  const ord = m.hire("buyer_5", "svc_5", "ord_5");
  m.deliver(ord);

  assert.throws(() => {
    m.deliver(ord);
  }, /order not escrowed/);
});

test("6. Unknown service, unknown buyer and duplicate order id all throw without fund loss", () => {
  const m = new EscrowMarket();
  m.register("buyer_6", 100);
  m.register("seller_6", 0);
  m.listService("seller_6", "svc_6", "Task 6", 30);

  assert.throws(() => m.hire("buyer_6", "svc_nonexistent", "ord_x"), /unknown service/);
  assert.throws(() => m.hire("unregistered_buyer", "svc_6", "ord_y"), /unknown buyer/);

  const ord = m.hire("buyer_6", "svc_6", "ord_6");
  assert.strictEqual(m.balance("buyer_6"), 70, "First hire debits 30");
  assert.throws(() => m.hire("buyer_6", "svc_6", "ord_6"), /duplicate order id/);
  assert.strictEqual(m.balance("buyer_6"), 70, "Rejected duplicate must not debit the buyer again");
  assert.strictEqual(m.verify().locked, 30, "The live escrow of the first hire must survive");
});

test("7. Invariant multi-order concurrency check", () => {
  const m = new EscrowMarket();
  m.register("buyer_a", 200);
  m.register("buyer_b", 300);
  m.register("seller_c", 0);

  m.listService("seller_c", "svc_c1", "Task C1", 40);
  m.listService("seller_c", "svc_c2", "Task C2", 70);

  const ordA = m.hire("buyer_a", "svc_c1", "ord_A");
  const ordB = m.hire("buyer_b", "svc_c2", "ord_B");

  assert.strictEqual(m.verify().locked, 110, "Locked sum must equal 40 + 70 = 110");

  m.deliver(ordA);
  m.accept(ordA);
  assert.strictEqual(m.verify().locked, 70, "After ordA settles, locked must equal 70");

  m.deliver(ordB);
  m.dispute(ordB);
  assert.strictEqual(m.verify().locked, 0, "After ordB refunds, locked must equal 0");
  assert.strictEqual(m.balance("buyer_a"), 160);
  assert.strictEqual(m.balance("buyer_b"), 300);
  assert.strictEqual(m.balance("seller_c"), 40);
});

console.log("------------------------------------------------------------");
console.log(`RESULT: ${passed}/${total} tests passed.`);
if (passed === total) {
  console.log("ALL TESTS COMPLETED SUCCESSFULLY (EXIT 0).");
} else {
  console.error("SOME TESTS FAILED.");
  process.exit(1);
}
