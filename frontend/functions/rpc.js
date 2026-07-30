const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionReceipt",
]);

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

  const upstream = await fetch(ARC_TESTNET_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

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
