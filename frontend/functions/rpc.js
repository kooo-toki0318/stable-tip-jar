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
const RETRYABLE_RPC_ERROR_CODES = new Set([-32005, -32011]);
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_UPSTREAM_ATTEMPTS = 4;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
    requests.some((item) => !item || !ALLOWED_METHODS.has(item.method))
  ) {
    return Response.json({ error: "Unsupported RPC method." }, { status: 403 });
  }

  let finalResponse = null;
  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    let retryDelay = 750 * 2 ** attempt;
    try {
      const upstream = await fetch(ARC_TESTNET_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const responseBody = await upstream.text();
      finalResponse = {
        body: responseBody,
        status: upstream.status,
        contentType: upstream.headers.get("content-type") ?? "application/json",
      };

      const shouldRetry =
        RETRYABLE_STATUSES.has(upstream.status) ||
        hasRetryableRpcError(responseBody);
      if (!shouldRetry || attempt === MAX_UPSTREAM_ATTEMPTS - 1) break;

      const retryAfterSeconds = Number(upstream.headers.get("retry-after"));
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        retryDelay = retryAfterSeconds * 1_000;
      }
    } catch {
      if (attempt === MAX_UPSTREAM_ATTEMPTS - 1) break;
    }
    await wait(retryDelay);
  }

  if (!finalResponse) {
    return Response.json({ error: "RPC provider is unavailable." }, { status: 502 });
  }

  return new Response(finalResponse.body, {
    status: finalResponse.status,
    headers: {
      "content-type": finalResponse.contentType,
      "cache-control": "no-store",
    },
  });
}

export function onRequest() {
  return new Response("Method not allowed", { status: 405 });
}
