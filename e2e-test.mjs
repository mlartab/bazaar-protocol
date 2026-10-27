const BASE = 'http://localhost:3000';

async function req(method, path, body, idempotencyKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function run() {
  console.log("=== STARTING E2E AGENT SIMULATION ===\n");

  // 1. Register Seller
  console.log("1. Registering Seller Agent...");
  const reg = await req('POST', '/api/agents/register', {
    agentId: 'seller-E2E',
    publicKey: 'pub-key-123',
    capability: 'image_gen',
    floorPrice: 50,
    webhookUrl: 'https://agent.ai/webhook'
  }, 'idem-reg-1');
  console.log(`Status: ${reg.status}`);
  console.log(`Response:`, reg.data.agent ? reg.data.agent.hexSeal : reg.data);
  console.log("");

  // 2. Check Buyer Wallet
  console.log("2. Checking Buyer Wallet...");
  const buyerWallet1 = await req('GET', '/api/wallets/buyer-E2E');
  console.log(`Status: ${buyerWallet1.status} | Balance: ${buyerWallet1.data.balance} CR`);
  console.log("");

  // 3. Open Session
  console.log("3. Buyer opens Session...");
  const sess = await req('POST', '/api/sessions', {
    buyerId: 'buyer-E2E',
    sellerId: 'seller-E2E',
    brief: { budget: 100, task: "Generate a cyberpunk ad" }
  }, 'idem-sess-1');
  const sessionId = sess.data.sessionId;
  console.log(`Status: ${sess.status} | Session ID: ${sessionId}`);
  console.log("");

  // 4. Negotiate: Lowball (Should Fail)
  console.log("4. Buyer offers 30 (Below floor - Should Fail)...");
  const neg1 = await req('POST', `/api/sessions/${sessionId}/negotiate`, {
    agentId: 'buyer-E2E',
    move: { action: 'OFFER', price: 30 }
  }, 'idem-neg-1');
  console.log(`Status: ${neg1.status} | Error: ${neg1.data.error?.code || neg1.data.error}`);
  console.log("");

  // 5. Negotiate: Valid Offer
  console.log("5. Buyer offers 80 (Valid)...");
  const neg2 = await req('POST', `/api/sessions/${sessionId}/negotiate`, {
    agentId: 'buyer-E2E',
    move: { action: 'OFFER', price: 80 }
  }, 'idem-neg-2');
  console.log(`Status: ${neg2.status} | State: ${neg2.data.status}`);
  console.log("");

  // 6. Negotiate: Accept (Locks Escrow)
  console.log("6. Seller accepts 80...");
  const neg3 = await req('POST', `/api/sessions/${sessionId}/negotiate`, {
    agentId: 'seller-E2E',
    move: { action: 'ACCEPT', price: 80 }
  }, 'idem-neg-3');
  console.log(`Status: ${neg3.status} | State: ${neg3.data.status} | Escrow Locked: ${neg3.data.agreedPrice} CR`);
  console.log("");

  // 7. Check Wallets After Lock
  const buyerWallet2 = await req('GET', '/api/wallets/buyer-E2E');
  console.log(`7. Buyer Wallet after Lock: ${buyerWallet2.data.balance} CR (Should be 920)`);
  console.log("");

  // 8. Deliver Work (Triggers Real Meta Vision API)
  // Base64 payload: the Meta API rejects external HTTP URLs for security.
  console.log("8. Seller delivers Base64 image (Triggers Meta Vision)...");
  const pixelB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const deliver = await req('POST', `/api/sessions/${sessionId}/deliver`, {
    agentId: 'seller-E2E',
    payload: pixelB64
  }, 'idem-del-1');
  console.log(`Status: ${deliver.status} | Result: ${deliver.data.status} | Reason: ${deliver.data.reason || 'N/A'}`);
  console.log("");

  // 9. Check Final Wallets
  console.log("9. Checking Final Wallets...");
  const buyerWallet3 = await req('GET', '/api/wallets/buyer-E2E');
  const sellerWallet = await req('GET', '/api/wallets/seller-E2E');
  console.log(`Buyer Balance: ${buyerWallet3.data.balance} CR`);
  console.log(`Seller Balance: ${sellerWallet.data.balance} CR`);
  console.log("\n=== SIMULATION COMPLETE ===");
}

run().catch(console.error);
