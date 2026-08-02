const ARC_TESTNET_RPC_URLS = [
  "https://rpc.testnet.arc.network",
  "https://rpc.drpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network",
];
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_getBalance",
  "eth_getCode",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_RPC_ERROR_CODES = new Set([-32005, -32011]);
const MAX_REQUEST_BODY_BYTES = 131_072;
const MAX_BATCH_SIZE = 20;
const MAX_UPSTREAM_ATTEMPTS = 2;
let providerCursor = 0;

function hasRetryableRpcError(responseBody) {
  try {
    const payload = JSON.parse(responseBody);
    const responses = Array.isArray(payload) ? payload : [payload];
    return responses.some((item) => {
      const code = Number(item?.error?.code);
      const message = String(item?.error?.message ?? "").toLowerCase();
      return (
        RETRYABLE_RPC_ERROR_CODES.has(code) ||
        message.includes("rate limit exceeded") ||
        message.includes("request limit reached") ||
        message.includes("too many requests")
      );
    });
  } catch {
    return false;
  }
}

export async function onRequestPost({ request }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json(
      { error: "Cross-origin RPC requests are not allowed." },
      { status: 403 },
    );
  }

  const bodyBytes = await request.arrayBuffer();
  if (bodyBytes.byteLength > MAX_REQUEST_BODY_BYTES) {
    return Response.json({ error: "Request body is too large." }, { status: 413 });
  }
  const body = new TextDecoder().decode(bodyBytes);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const requests = Array.isArray(payload) ? payload : [payload];
  if (
    requests.length === 0 ||
    requests.length > MAX_BATCH_SIZE ||
    requests.some((item) => !item || !ALLOWED_METHODS.has(item.method))
  ) {
    return Response.json({ error: "Unsupported RPC method." }, { status: 403 });
  }

  const startProvider = providerCursor % ARC_TESTNET_RPC_URLS.length;
  providerCursor = (providerCursor + 1) % ARC_TESTNET_RPC_URLS.length;
  let finalResponse = null;
  let attemptsMade = 0;
  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt + 1;
    const rpcUrl =
      ARC_TESTNET_RPC_URLS[
        (startProvider + attempt) % ARC_TESTNET_RPC_URLS.length
      ];
    try {
      const upstream = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const responseBody = await upstream.text();
      finalResponse = {
        body: responseBody,
        status: upstream.status,
        contentType: upstream.headers.get("content-type") ?? "application/json",
        provider: new URL(rpcUrl).hostname,
      };

      const shouldRetry =
        RETRYABLE_STATUSES.has(upstream.status) ||
        hasRetryableRpcError(responseBody);
      if (!shouldRetry || attempt === MAX_UPSTREAM_ATTEMPTS - 1) break;
    } catch {
      if (attempt === MAX_UPSTREAM_ATTEMPTS - 1) break;
    }
  }

  if (!finalResponse) {
    return Response.json({ error: "RPC provider is unavailable." }, { status: 502 });
  }

  return new Response(finalResponse.body, {
    status: finalResponse.status,
    headers: {
      "content-type": finalResponse.contentType,
      "cache-control": "no-store",
      "x-arc-rpc-provider": finalResponse.provider,
      "x-arc-rpc-attempts": String(attemptsMade),
    },
  });
}

export function onRequest() {
  return new Response("Method not allowed", { status: 405 });
}
