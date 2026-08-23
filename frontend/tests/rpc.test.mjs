import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getActivity } from "../functions/api/activity.js";
import { onRequestPost as postRpc } from "../functions/rpc.js";

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

test("RPC blocks log scans but permits receipt and latest-block reads", async () => {
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
    const blockResponse = await postRpc({
      request: rpcRequest("eth_getBlockByNumber"),
    });
    assert.equal(blockResponse.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
