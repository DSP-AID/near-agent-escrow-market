#!/usr/bin/env node
/**
 * near-agent-escrow-market — DAiL bnty_0397 prototype
 * Escrowed agent-services market modeled on NEAR Intents semantics:
 * agents hire agents, funds are locked in escrow, work is verified, escrow releases.
 * Dependency-free (Node stdlib only) so reviewers can run it instantly.
 */
const crypto = require("crypto");

class EscrowMarket {
  constructor() {
    this.ledger = new Map();   // agentId -> balance (NEAR tokens)
    this.escrow = new Map();   // orderId -> {buyer, seller, amount, state}
    this.services = new Map(); // serviceId -> {seller, title, price}
    this.events = [];
  }
  _log(ev) { this.events.push({ t: new Date().toISOString(), ...ev }); }
  register(id, startingBalance = 100) {
    this.ledger.set(id, startingBalance);
    this._log({ type: "register", agent: id, balance: startingBalance });
    return id;
  }
  listService(seller, serviceId, title, price) {
    if (!this.ledger.has(seller)) throw new Error("unknown seller");
    this.services.set(serviceId, { seller, title, price });
    this._log({ type: "list_service", seller, serviceId, title, price });
    return serviceId;
  }
  /** Buyer intents to hire: funds MOVE from buyer balance into escrow (locked, not spendable). */
  hire(buyer, serviceId, orderId) {
    const svc = this.services.get(serviceId);
    if (!svc) throw new Error("unknown service");
    if (!this.ledger.has(buyer)) throw new Error("unknown buyer"); // guard: unregistered buyer used to produce a NaN balance
    if (this.escrow.has(orderId)) throw new Error("duplicate order id"); // guard: overwrite would silently strand a live escrow
    const bal = this.ledger.get(buyer);
    if (bal < svc.price) throw new Error("insufficient balance");
    // NEAR-intent style: debit buyer immediately, credit nobody yet
    this.ledger.set(buyer, bal - svc.price);
    this.escrow.set(orderId, { buyer, seller: svc.seller, amount: svc.price, state: "escrowed", service: serviceId });
    this._log({ type: "escrow_lock", orderId, buyer, amount: svc.price });
    return orderId;
  }
  /** Seller delivers; buyer verifies and accepts -> escrow releases to seller. */
  deliver(orderId) {
    const o = this.escrow.get(orderId);
    if (!o || o.state !== "escrowed") throw new Error("order not escrowed");
    o.state = "delivered";
    this._log({ type: "delivered", orderId });
    return orderId;
  }
  accept(orderId) {
    const o = this.escrow.get(orderId);
    if (!o || o.state !== "delivered") throw new Error("order not delivered");
    o.state = "released";
    this.ledger.set(o.seller, (this.ledger.get(o.seller) || 0) + o.amount);
    this._log({ type: "escrow_release", orderId, seller: o.seller, amount: o.amount });
    return orderId;
  }
  /** Dispute: buyer disputes before accept -> full refund path. */
  dispute(orderId) {
    const o = this.escrow.get(orderId);
    if (!o || o.state !== "delivered") throw new Error("order not delivered");
    o.state = "refunded";
    this.ledger.set(o.buyer, (this.ledger.get(o.buyer) || 0) + o.amount);
    this._log({ type: "refund", orderId, buyer: o.buyer, amount: o.amount });
    return orderId;
  }
  balance(id) { return this.ledger.get(id); }
  verify() {
    // invariant: every escrowed/delivered order amount is locked out of buyer balances
    let locked = 0;
    for (const o of this.escrow.values())
      if (o.state === "escrowed" || o.state === "delivered") locked += o.amount;
    return { locked, events: this.events.length };
  }
}

module.exports = { EscrowMarket };

if (require.main === module) {
  const m = new EscrowMarket();
  m.register("alice-agent", 100);
  m.register("bob-agent", 50);
  m.listService("bob-agent", "svc_1", "Data cleaning (200 rows)", 30);
  const o = m.hire("alice-agent", "svc_1", "ord_1");
  console.log("after hire  : alice =", m.balance("alice-agent"), "| verify:", m.verify());
  m.deliver(o);
  m.accept(o);
  console.log("after accept: alice =", m.balance("alice-agent"), "bob =", m.balance("bob-agent"), "| verify:", m.verify());
  console.log(JSON.stringify(m.events, null, 1));
}
