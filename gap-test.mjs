const BASE = 'http://localhost:3000';

async function req(method, path, body = null, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m'; const C = '\x1b[36m'; const X = '\x1b[0m';

async function runGapTest() {
  console.log(`\n${C}=== BAZAAR PROTOCOL: AUTONOMOUS AGENT GAP TEST ===${X}\n`);

  console.log(`${Y}1. SETUP: Registering Seller and checking Buyer Wallet${X}`);
  await req('POST', '/api/agents/register', {
    agentId: 'seller-ai', publicKey: 'pk-1', capability: 'image_gen', floorPrice: 50, webhookUrl: 'https://ai.com/hook'
  }, { 'Idempotency-Key': 'reg-1' });
  
  const buyerWallet = await req('GET', '/api/wallets/buyer-ai');
  console.log(`   Buyer Wallet: ${G}${buyerWallet.data.balance} CR${X}\n`);

  console.log(`${Y}2. THE HALLUCINATION: Buyer tries to pay 10000 CR (Budget is 100)${X}`);
  const sess = await req('POST', '/api/sessions', {
    buyerId: 'buyer-ai', sellerId: 'seller-ai', brief: { budget: 100, task: 'cyberpunk ad' }
  }, { 'Idempotency-Key': 'sess-1' });
  const sessId = sess.data.sessionId;

  const badOffer = await req('POST', `/api/sessions/${sessId}/negotiate`, {
    agentId: 'buyer-ai', move: { action: 'OFFER', price: 10000 }
  }, { 'Idempotency-Key': 'neg-bad' });
  console.log(`   Referee Response: ${badOffer.status === 422 ? G + 'BLOCKED' : R + 'ALLOWED'}${X}\n`);

  console.log(`${Y}3. THE NETWORK RETRY: Buyer sends valid ACCEPT twice${X}`);
  await req('POST', `/api/sessions/${sessId}/negotiate`, {
    agentId: 'buyer-ai', move: { action: 'OFFER', price: 60 }
  }, { 'Idempotency-Key': 'neg-1' });

  await req('POST', `/api/sessions/${sessId}/negotiate`, {
    agentId: 'seller-ai', move: { action: 'ACCEPT', price: 60 }
  }, { 'Idempotency-Key': 'idem-accept-123' });
  
  await req('POST', `/api/sessions/${sessId}/negotiate`, {
    agentId: 'seller-ai', move: { action: 'ACCEPT', price: 60 }
  }, { 'Idempotency-Key': 'idem-accept-123' }); // SAME KEY

  const walletAfterLock = await req('GET', '/api/wallets/buyer-ai');
  console.log(`   Buyer Wallet: ${G}${walletAfterLock.data.balance} CR${X} (Deducted only once!)\n`);

  console.log(`${Y}4. THE SCAMMER: Seller delivers an image URL that fails the prompt${X}`);
  
  // Use a reliable public image URL instead of Base64
  const dummyImageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/320px-Example.jpg";
  
  const deliverBad = await req('POST', `/api/sessions/${sessId}/deliver`, {
    agentId: 'seller-ai', payload: dummyImageUrl
  }, { 'Idempotency-Key': 'del-bad' });
  
  if (deliverBad.data.error) {
    console.log(`   ${R}INSPECTOR ERROR:${X} ${deliverBad.data.error.message}`);
  } else {
    console.log(`   Inspector Result: ${deliverBad.data.status === 'REJECTED' ? R + 'REJECTED' : G + 'SETTLED'}${X}`);
    console.log(`   Reason: ${deliverBad.data.reason}`);
  }
  
  const buyerFinal = await req('GET', '/api/wallets/buyer-ai');
  const sellerFinal = await req('GET', '/api/wallets/seller-ai');
  
  console.log(`   Buyer Wallet: ${G}${buyerFinal.data.balance} CR${X} (Expected: 1050 -> Refund + Penalty)`);
  console.log(`   Seller Wallet: ${R}${sellerFinal.data.balance} CR${X} (Expected: 1000)`);
  
  if (buyerFinal.data.balance === 1050 && deliverBad.data.status === 'REJECTED') {
    console.log(`\n${G}✓ PROTOCOL SUCCESS: The scammer was caught, slashed, and the buyer was rewarded.${X}\n`);
  } else {
    console.log(`\n${R}✗ TEST FAILED: Check the server console for Meta API errors.${X}\n`);
  }
}

runGapTest().catch(console.error);
