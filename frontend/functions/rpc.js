const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function onRequestPost({ request }) {
  const body = await request.text();
  if (body.length > 65_536) {
    return Response.json({ error: "Request body is too large." }, { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const requests = Array.isArray(payload) ? payload : [payload];
  if (
    requests.length === 0 ||
    requests.some((item) => !item || !ALLOWED_METHODS.has(item.method))
  ) {
    return Response.json({ error: "Unsupported RPC method." }, { status: 403 });
  }

  let upstream;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      upstream = await fetch(ARC_TESTNET_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!RETRYABLE_STATUSES.has(upstream.status) || attempt === 3) break;
      await upstream.body?.cancel();
    } catch (error) {
      if (attempt === 3) throw error;
    }

    const retryAfterSeconds = Number(upstream?.headers.get("retry-after"));
    const retryDelay =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1_000
        : 300 * 2 ** attempt;
    await wait(retryDelay);
  }

  if (!upstream) {
    return Response.json({ error: "RPC provider is unavailable." }, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

export function onRequest() {
  return new Response("Method not allowed", { status: 405 });
}
