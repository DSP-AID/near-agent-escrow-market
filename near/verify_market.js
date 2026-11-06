// Keyless verification of the committed on-chain evidence: every cited tx must resolve live on a
// public testnet RPC with a SUCCESS receipt + the expected event log, and the contract's current
// views must still match the recorded final state. Zero dependencies - plain JSON-RPC over fetch.
//   node verify_market.js   (exit 0 = all evidence verified)
const fs = require('fs');
const path = require('path');

const RPCS = [process.env.NEAR_RPC].filter(Boolean).concat([
  'https://rpc.testnet.near.org',
  'https://test.rpc.fastnear.com',
]);
const ev = JSON.parse(fs.readFileSync(path.join(__dirname, 'evidence.json'), 'utf8'));
const EXPECT_LOG = {
  new: '"register"', storage_deposit: '"register"', list_service: '"list_service"',
  hire: '"escrow_lock"', deliver: '"delivered"', accept: '"escrow_release"', dispute: '"refund"',
};

async function q(rpc, method, params) {
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(25000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'v', method, params }),
  });
  return r.json();
}

async function tryRpcs(method, params) {
  for (const rpc of RPCS) {
    try {
      const j = await q(rpc, method, params);
      if (!j.error) return { ok: true, result: j.result, rpc };
    } catch { /* next provider */ }
  }
  return { ok: false };
}

async function view(m, args) {
  const j = await tryRpcs('query', { request_type: 'call_function', finality: 'final', account_id: ev.contract, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  if (!j.ok || !j.result?.result) throw new Error(`view ${m} unavailable on all RPCs`);
  const raw = j.result.result;
  return (Array.isArray(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'base64')).toString();
}

let fails = 0;
function check(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
}

(async () => {
  // 1. every cited tx must resolve on the public RPC with success + its expected event log
  for (const st of ev.steps) {
    const j = await tryRpcs('EXPERIMENTAL_tx_status', [st.tx, st.signer]);
    if (!j.ok) { check(false, `${st.method} ${st.tx} NOT OBSERVED on public RPC`); continue; }
    const recs = j.result.receipts_outcome || [];
    const ok = recs.some((r) => r.outcome.status.SuccessValue !== undefined) && !recs.some((r) => r.outcome.status.Failure);
    const logs = recs.flatMap((r) => r.outcome.logs || []);
    check(ok && logs.some((l) => l.includes(EXPECT_LOG[st.method])), `${st.method.padEnd(15)} ${st.tx} resolves live [${j.rpc.replace('https://', '').split('.')[0]}]`);
  }

  // 2. the contract's live state must still match the recorded final verification
  const v = ev.verification;
  const live = {
    ft_total_supply: await view('ft_total_supply', {}),
    buyer_balance: await view('ft_balance_of', { account_id: ev.steps[0].args.owner_id }),
    seller_balance: await view('ft_balance_of', { account_id: ev.steps[1].args.account_id }),
    vault_balance: await view('ft_balance_of', { account_id: ev.contract }),
    verify_locked: await view('verify_locked', {}),
    ord_1_state: JSON.parse(await view('get_order', { order_id: 'ord_1' })).state,
    ord_2_state: JSON.parse(await view('get_order', { order_id: 'ord_2' })).state,
  };
  for (const k of Object.keys(v)) check(live[k] === v[k], `live ${k} == recorded (${v[k]})`);

  console.log(fails === 0 ? `\nALL EVIDENCE VERIFIED (${ev.steps.length} txs + ${Object.keys(v).length} state views)` : `\nFAILED: ${fails} check(s)`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('VERIFY CRASHED:', e.message); process.exit(1); });
