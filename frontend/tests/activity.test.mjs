import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getActivity } from "../functions/api/activity.js";

const account = "0x1111111111111111111111111111111111111111";
const accountTopic = `0x${"0".repeat(24)}${account.slice(2)}`;
const tipTopic =
  "0x17d59ac88bacfa01c652a4837c504a433c5fb1c5ea49c001a64a1b2e1e16c1d0";
const claimTopic =
  "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a";

test("activity endpoint pages ArcScan logs and classifies wallet events", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedUrls.push(url);
    assert.equal(url.searchParams.get("topic"), accountTopic);
    return Response.json({
      items: [
        {
          block_number: 54_430_760,
          block_timestamp: "2024-07-03T09:46:41.000000Z",
          index: 2,
          transaction_hash: `0x${"b".repeat(64)}`,
          data: "0x",
          topics: [claimTopic, accountTopic, null, null],
        },
        {
          block_number: 54_430_759,
          block_timestamp: "2024-07-03T09:46:40.000000Z",
          index: 1,
          transaction_hash: `0x${"a".repeat(64)}`,
          data: "0x",
          topics: [tipTopic, accountTopic, accountTopic, null],
        },
      ],
      next_page_params: null,
    });
  };

  try {
    const response = await getActivity({
      request: new Request(
        `https://example.com/api/activity?network=testnet&address=${account}`,
      ),
      env: {},
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0].pathname, /\/addresses\/0x44fd.*\/logs$/);
    assert.equal(body.sentTipCount, 1);
    assert.equal(body.sentTips.length, 1);
    assert.equal(body.sentTips[0].timestamp, "1720000000");
    assert.equal(body.receivedTipTransactions[0].index, 0);
    assert.equal(body.claimTransactions[0].index, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("activity endpoint follows ArcScan pagination cursors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = new URL(input);
    if (calls === 1) {
      assert.equal(url.searchParams.get("index"), null);
      return Response.json({
        items: [],
        next_page_params: { block_number: 54_430_759, index: 1 },
      });
    }
    assert.equal(url.searchParams.get("block_number"), "54430759");
    assert.equal(url.searchParams.get("index"), "1");
    return Response.json({ items: [], next_page_params: null });
  };

  try {
    const response = await getActivity({
      request: new Request(`https://example.com/api/activity?address=${account}`),
      env: {},
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("activity endpoint handles an empty ArcScan history", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ items: [], next_page_params: null });

  try {
    const response = await getActivity({
      request: new Request(`https://example.com/api/activity?address=${account}`),
      env: {},
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sentTipCount, 0);
    assert.deepEqual(body.sentTips, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
