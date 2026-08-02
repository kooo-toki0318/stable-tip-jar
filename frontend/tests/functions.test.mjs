import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getActivity } from "../functions/api/activity.js";
import { onRequestPost as postRpc } from "../functions/rpc.js";

const account = "0x1111111111111111111111111111111111111111";
const accountTopic = `0x${"0".repeat(24)}${account.slice(2)}`;
const tipTopic =
  "0x17d59ac88bacfa01c652a4837c504a433c5fb1c5ea49c001a64a1b2e1e16c1d0";
const claimTopic =
  "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a";

function rpcRequest(method, options = {}) {
  return new Request("https://example.com/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.com",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    ...options,
  });
}

test("activity endpoint keeps the Envio token server-side and classifies events", async () => {
  const originalFetch = globalThis.fetch;
  let query;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, "Bearer test-token");
    query = JSON.parse(init.body);
    return Response.json({
      archive_height: 54_430_760,
      next_block: 54_430_760,
      data: {
        blocks: [{ number: 54_430_759, timestamp: 1_720_000_000 }],
        logs: [
          {
            block_number: 54_430_759,
            log_index: 1,
            transaction_hash: `0x${"a".repeat(64)}`,
            data: "0x",
            topic0: tipTopic,
            topic1: accountTopic,
            topic2: accountTopic,
          },
          {
            block_number: 54_430_759,
            log_index: 2,
            transaction_hash: `0x${"b".repeat(64)}`,
            data: "0x",
            topic0: claimTopic,
            topic1: accountTopic,
          },
        ],
      },
    });
  };

  try {
    const response = await getActivity({
      request: new Request(
        `https://example.com/api/activity?network=testnet&address=${account}`,
      ),
      env: { ENVIO_API_TOKEN: "test-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(query.from_block, 54_430_758);
    assert.equal(query.logs.length, 3);
    assert.equal(body.sentTipCount, 1);
    assert.equal(body.sentTips.length, 1);
    assert.equal(body.receivedTipTransactions[0].index, 0);
    assert.equal(body.claimTransactions[0].index, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("activity endpoint reports a missing server-side token without touching RPC", async () => {
  const response = await getActivity({
    request: new Request(`https://example.com/api/activity?address=${account}`),
    env: {},
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "INDEXER_NOT_CONFIGURED");
});

test("RPC fails over once for -32005 and -32011 errors", async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const [code, message] of [
      [-32005, "rate limit exceeded"],
      [-32011, "request limit reached"],
    ]) {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x4cef52" });
      };

      const response = await postRpc({ request: rpcRequest("eth_chainId") });
      assert.equal((await response.json()).result, "0x4cef52");
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0], calls[1]);
      assert.equal(response.headers.get("x-arc-rpc-attempts"), "2");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("RPC fails over once for HTTP 429", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("too many requests", { status: 429 })
      : Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
  };

  try {
    const response = await postRpc({ request: rpcRequest("eth_blockNumber") });
    assert.equal((await response.json()).result, "0x1");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RPC rejects oversized bodies before calling an upstream", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({});
  };

  try {
    const response = await postRpc({
      request: new Request("https://example.com/rpc", {
        method: "POST",
        body: "x".repeat(131_073),
      }),
    });
    assert.equal(response.status, 413);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RPC blocks log scans but permits receipt replacement checks", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ jsonrpc: "2.0", id: 1, result: null });
  };

  try {
    const logsResponse = await postRpc({ request: rpcRequest("eth_getLogs") });
    assert.equal(logsResponse.status, 403);
    const transactionResponse = await postRpc({
      request: rpcRequest("eth_getTransactionByHash"),
    });
    assert.equal(transactionResponse.status, 200);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
