// Deploy + init the single FT+escrow market contract on NEAR testnet.
//   node deploy_market.js   (uses near/lib.js accounts; MKT must already exist as a sub-account of MAIN)
// Sequence proven live: deployContract -> init new() signed by MAIN with exactly 0.1 NEAR attached.
// If the account balance is below its consumed code-storage reserve, the deploy retries after
// clearing the old code (deploying empty bytes), which releases the balance-check reserve.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

function report(tag, res) {
  let ok = false;
  for (const r of res.receipts_outcome || []) {
    const st = r.outcome?.status;
    if (st?.SuccessValue !== undefined) ok = true;
    else if (st?.Failure) {
      const f = st.Failure;
      console.log(`${tag} FAIL:`, typeof f === 'string' ? Buffer.from(f, 'base64').toString().slice(0, 300) : JSON.stringify(f).slice(0, 300));
    }
    for (const lg of r.outcome?.logs || []) console.log(`${tag} LOG:`, lg.slice(0, 250));
  }
  console.log(`${tag}: ${ok ? 'OK' : 'FAILED'} tx=${L.txHashes(res)[0]}`);
  if (!ok) process.exit(1);
}

(async () => {
  const wasm = new Uint8Array(fs.readFileSync(path.join(__dirname, 'market.wasm')));
  console.log('deploying', wasm.length, 'bytes to', L.MKT);
  let dres;
  try {
    dres = await L.account(L.MKT).signAndSendTransaction({ receiverId: L.MKT, actions: [L.near.actions.deployContract(wasm)] });
  } catch (e) {
    console.log('deploy threw:', String(e.message).replace(/\s+/g, ' ').slice(0, 160), '- clearing old code and retrying');
    await L.account(L.MKT).signAndSendTransaction({ receiverId: L.MKT, actions: [L.near.actions.deployContract(new Uint8Array(0))] });
    dres = await L.account(L.MKT).signAndSendTransaction({ receiverId: L.MKT, actions: [L.near.actions.deployContract(wasm)] });
  }
  report('DEPLOY', dres);

  // init is signed by MAIN (not MKT): external signers are accepted and the attached deposit
  // then comes from an account that actually holds NEAR (see README disclosure notes).
  const ires = await L.account(L.MAIN).signAndSendTransaction({
    receiverId: L.MKT,
    actions: [L.near.actions.functionCall('new', { owner_id: L.MAIN, vault_id: L.MKT, total_supply: L.t(1000) }, L.GAS, L.STORAGE_DEPOSIT)],
  });
  report('INIT', ires);
  console.log('deploy+init complete');
})().catch((e) => { console.error('THROWN:', String(e.message).replace(/\s+/g, ' ').slice(0, 300)); process.exit(1); });
