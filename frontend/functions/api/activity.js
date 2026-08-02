const ARCSCAN_API_URL = "https://testnet.arcscan.app/api/v2";
const DEFAULT_CONTRACT_ADDRESS = "0x44fd57baeaac3d2f0a20a8032840e00bd44e8668";
const TIP_RECEIVED_TOPIC =
  "0x17d59ac88bacfa01c652a4837c504a433c5fb1c5ea49c001a64a1b2e1e16c1d0";
const CLAIMED_TOPIC =
  "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MAX_PAGES = 20;

function json(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function indexedAddressTopic(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return Number(value);
  return Number.NaN;
}

function timestampValue(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? String(Math.floor(milliseconds / 1_000))
    : null;
}

function normalizeLog(log) {
  return {
    blockNumber: numberValue(log.block_number),
    logIndex: numberValue(log.index),
    transactionHash: log.transaction_hash,
    data: log.data,
    topics: Array.isArray(log.topics)
      ? log.topics.filter((topic) => typeof topic === "string")
      : [],
    timestamp: timestampValue(log.block_timestamp),
  };
}

function logKey(log) {
  return `${String(log.block_number)}:${String(log.index)}:${String(
    log.transaction_hash,
  ).toLowerCase()}`;
}

async function fetchActivityLogs({ accountTopic, contractAddress }) {
  const logs = [];
  const seenLogs = new Set();
  const seenCursors = new Set();
  let nextPageParams = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(
      `${ARCSCAN_API_URL}/addresses/${contractAddress}/logs`,
    );
    url.searchParams.set("topic", accountTopic);
    if (nextPageParams) {
      for (const [key, value] of Object.entries(nextPageParams)) {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`ArcScan returned ${response.status}: ${detail}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.items)) {
      throw new Error("ArcScan returned an invalid activity response.");
    }
    for (const log of payload.items) {
      const key = logKey(log);
      if (!seenLogs.has(key)) {
        seenLogs.add(key);
        logs.push(log);
      }
    }

    nextPageParams = payload.next_page_params;
    if (!nextPageParams) return logs;
    const cursor = JSON.stringify(nextPageParams);
    if (seenCursors.has(cursor)) {
      throw new Error("ArcScan returned a repeated pagination cursor.");
    }
    seenCursors.add(cursor);
  }

  throw new Error("ArcScan pagination limit was reached.");
}

export async function onRequestGet({ request, env }) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) {
    return json(
      {
        code: "CROSS_ORIGIN_DENIED",
        error: "Cross-origin requests are not allowed.",
      },
      { status: 403 },
    );
  }

  const account = requestUrl.searchParams.get("address") ?? "";
  const network = requestUrl.searchParams.get("network") ?? "testnet";
  if (network !== "testnet") {
    return json(
      {
        code: "INDEXER_NETWORK_UNSUPPORTED",
        error: "History is not configured for this network.",
      },
      { status: 501 },
    );
  }
  if (!ADDRESS_PATTERN.test(account)) {
    return json(
      { code: "INVALID_ADDRESS", error: "A valid wallet address is required." },
      { status: 400 },
    );
  }

  const contractAddress = String(
    env.ARC_TIP_JAR_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS,
  ).toLowerCase();
  if (!ADDRESS_PATTERN.test(contractAddress)) {
    return json(
      {
        code: "INDEXER_CONFIG_INVALID",
        error: "History indexer configuration is invalid.",
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const accountTopic = indexedAddressTopic(account);
    const logs = await fetchActivityLogs({ accountTopic, contractAddress });
    logs.sort(
      (left, right) =>
        numberValue(left.block_number) - numberValue(right.block_number) ||
        numberValue(left.index) - numberValue(right.index),
    );

    const lowerAccountTopic = accountTopic.toLowerCase();
    const sentLogs = logs.filter(
      (log) =>
        String(log.topics?.[0]).toLowerCase() === TIP_RECEIVED_TOPIC &&
        String(log.topics?.[1]).toLowerCase() === lowerAccountTopic,
    );
    const receivedLogs = logs.filter(
      (log) =>
        String(log.topics?.[0]).toLowerCase() === TIP_RECEIVED_TOPIC &&
        String(log.topics?.[2]).toLowerCase() === lowerAccountTopic,
    );
    const claimLogs = logs.filter(
      (log) =>
        String(log.topics?.[0]).toLowerCase() === CLAIMED_TOPIC &&
        String(log.topics?.[1]).toLowerCase() === lowerAccountTopic,
    );

    return json(
      {
        sentTipCount: sentLogs.length,
        sentTips: sentLogs
          .slice(-8)
          .reverse()
          .map(normalizeLog),
        receivedTipTransactions: receivedLogs.slice(-8).map((log, offset) => ({
          index: receivedLogs.length - Math.min(receivedLogs.length, 8) + offset,
          transactionHash: log.transaction_hash,
        })),
        claimTransactions: claimLogs.slice(-8).map((log, offset) => ({
          index: claimLogs.length - Math.min(claimLogs.length, 8) + offset,
          transactionHash: log.transaction_hash,
        })),
      },
      {
        headers: {
          "cache-control":
            "public, max-age=10, s-maxage=30, stale-while-revalidate=60",
        },
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown indexer error.";
    return json(
      { code: "INDEXER_UNAVAILABLE", error: detail },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export function onRequest() {
  return new Response("Method not allowed", { status: 405 });
}
