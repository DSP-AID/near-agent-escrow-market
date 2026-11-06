// Full on-chain market flow against the deployed contract (NEAR testnet), one continuous run.
//   node flow_market.js   (run after deploy_market.js; overwrites evidence.json with fresh tx hashes)
// Flow: init -> seller registers + lists a 30 AEDT service -> buyer hires (lock) -> deliver ->
//       accept (release, seller +30) -> second order hire -> deliver -> dispute -> 100% refund.
// Ends with on-chain invariant verification mirroring the local market.js engine, then writes evidence.json.
const L = require('./lib');
const near = L.near;
const PIN = new near.JsonRpcProvider({ url: process.env.NEAR_RPC || L.RPCS[0] });

async function viewRaw(m, args = {}) {
  const r = await fetch(PIN.url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: L.MKT, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`view ${m}: ${JSON.stringify(j.error).slice(0, 200)}`);
  const res = j.result || {};
  if (res.error) throw new Error(`view ${m}: ${String(res.error).slice(0, 200)}`);
  const raw = res.result;
  return (Array.isArray(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'base64')).toString();
}

// RPC finality lag is real on testnet: poll until the view reflects the last confirmed write.
async function view(m, args = {}, expect = null) {
  for (let i = 0; i < 10; i++) {
    let v;
    try { v = await viewRaw(m, args); } catch { continue; }
    if (!expect || expect(v)) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return viewRaw(m, args);
}

async function call(accId, method, args = {}, deposit = 0n) {
  const acc = new near.Account(accId, PIN, L.SECRET);
  let res;
  try {
    res = await acc.signAndSendTransaction({ receiverId: L.MKT, actions: [near.actions.functionCall(method, args, L.GAS, deposit)] });
  } catch (e) {
    const rec = (e.transactionResult?.receipts_outcome || []).map((r) => { const f = r.outcome?.status?.Failure; return !f ? '' : typeof f === 'string' ? Buffer.from(f, 'base64').toString() : JSON.stringify(f); }).join('|');
    throw new Error(`${method}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 150)} | ${rec.slice(0, 200)}`);
  }
  let ok = false;
  const logs = [];
  for (const r of res.receipts_outcome || []) {
    const st = r.outcome?.status;
    if (st?.SuccessValue !== undefined) ok = true;
    else if (st?.Failure) {
      const f = st.Failure;
      throw new Error(`${method}: ${typeof f === 'string' ? Buffer.from(f, 'base64').toString() : JSON.stringify(f)}`.slice(0, 300));
    }
    logs.push(...(r.outcome?.logs || []));
  }
  if (!ok) throw new Error(`${method}: no success receipt`);
  const hashes = L.txHashes(res);
  console.log(`> ${method}(${JSON.stringify(args)})${deposit ? ` +${String(deposit)}y` : ''}  tx: ${hashes[0]}`);
  for (const lg of logs) console.log(`    log: ${lg.slice(0, 200)}`);
  return { signer: accId, method, args, deposit_yocto: String(deposit), tx: hashes[0], explorer: `https://testnet.nearblocks.io/txns/${hashes[0]}`, logs };
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

(async () => {
  const ev = { contract: L.MKT, token_symbol: 'AEDT', steps: [], started: new Date().toISOString() };

  // 0. init: owner (buyer) registered + minted, vault entry created; exactly 0.1 NEAR attached.
  ev.steps.push(await call(L.MAIN, 'new', { owner_id: L.MAIN, vault_id: L.MKT, total_supply: L.t(1000) }, L.STORAGE_DEPOSIT));

  // 1. seller registers with a 0.1 NEAR storage deposit, then lists a service priced at 30 AEDT
  ev.steps.push(await call(L.MAIN, 'storage_deposit', { account_id: L.SELLER }, L.STORAGE_DEPOSIT));
  ev.steps.push(await call(L.SELLER, 'list_service', { service_id: 'svc_1', title: 'Smart-contract audit', price: L.t(30) }));

  // 2. happy path: hire (lock 30 AEDT) -> deliver -> accept (release to seller)
  ev.steps.push(await call(L.MAIN, 'hire', { order_id: 'ord_1', service_id: 'svc_1' }, L.ONE_YOCTO));
  assert((await view('get_order', { order_id: 'ord_1' }, (v) => v.includes('"escrowed"'))).includes('"escrowed"'), 'ord_1 state == escrowed (tokens locked in contract)');
  assert((await view('ft_balance_of', { account_id: L.MKT }, (v) => v === `"${L.t(30)}"`)) === `"${L.t(30)}"`, 'contract FT balance == 30 AEDT while locked');
  ev.steps.push(await call(L.SELLER, 'deliver', { order_id: 'ord_1' }, L.ONE_YOCTO));
  ev.steps.push(await call(L.MAIN, 'accept', { order_id: 'ord_1' }, L.ONE_YOCTO));

  // 3. dispute path: hire -> deliver -> dispute -> full refund to buyer
  ev.steps.push(await call(L.MAIN, 'hire', { order_id: 'ord_2', service_id: 'svc_1' }, L.ONE_YOCTO));
  ev.steps.push(await call(L.SELLER, 'deliver', { order_id: 'ord_2' }, L.ONE_YOCTO));
  ev.steps.push(await call(L.MAIN, 'dispute', { order_id: 'ord_2' }, L.ONE_YOCTO));

  // 4. verification (mirrors the market.js engine invariants)
  const supply = await view('ft_total_supply', {}, (v) => v === `"${L.t(1000)}"`);
  const buyerBal = await view('ft_balance_of', { account_id: L.MAIN }, (v) => v === `"${L.t(970)}"`);
  const sellerBal = await view('ft_balance_of', { account_id: L.SELLER }, (v) => v === `"${L.t(30)}"`);
  const vaultBal = await view('ft_balance_of', { account_id: L.MKT }, (v) => v === '"0"');
  const locked = await view('verify_locked', {}, (v) => v === '"0"');
  const o1 = JSON.parse(await view('get_order', { order_id: 'ord_1' }, (v) => v.includes('"released"')));
  const o2 = JSON.parse(await view('get_order', { order_id: 'ord_2' }, (v) => v.includes('"refunded"')));
  ev.verification = { ft_total_supply: supply, buyer_balance: buyerBal, seller_balance: sellerBal, vault_balance: vaultBal, verify_locked: locked, ord_1_state: o1.state, ord_2_state: o2.state };
  console.log('EVIDENCE:', JSON.stringify(ev.verification));

  assert(supply === `"${L.t(1000)}"`, 'total supply unchanged at 1000 AEDT');
  assert(buyerBal === `"${L.t(970)}"`, 'buyer balance == 970 AEDT (paid 60 in two hires, 30 refunded on dispute, 30 paid out on accept)');
  assert(sellerBal === `"${L.t(30)}"`, 'seller earned exactly 30 AEDT (accepted order)');
  assert(vaultBal === '"0"', 'contract vault drained to 0 (no funds left locked)');
  assert(locked === '"0"', 'verify_locked invariants: sum(open locks) == 0 == contract balance');
  assert(o1.state === 'released', 'ord_1 terminal state == released');
  assert(o2.state === 'refunded', 'ord_2 terminal state == refunded');

  ev.finished = new Date().toISOString();
  require('fs').writeFileSync(require('path').join(__dirname, 'evidence.json'), JSON.stringify(ev, null, 2));
  console.log('\nFLOW ALL-PASS - evidence written to near/evidence.json');
})().catch((e) => { console.error('FLOW FAILED:', e.message); process.exit(1); });
