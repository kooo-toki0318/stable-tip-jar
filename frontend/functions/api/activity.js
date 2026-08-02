const HYPERSYNC_URL = "https://arc-testnet.hypersync.xyz/query";
const DEFAULT_CONTRACT_ADDRESS = "0x44fd57baeaac3d2f0a20a8032840e00bd44e8668";
const DEFAULT_DEPLOYMENT_BLOCK = 54_430_758;
const TIP_RECEIVED_TOPIC =
  "0x17d59ac88bacfa01c652a4837c504a433c5fb1c5ea49c001a64a1b2e1e16c1d0";
const CLAIMED_TOPIC =
  "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MAX_PAGES = 4;

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

function normalizeLog(log, timestamps) {
  const blockNumber = numberValue(log.block_number);
  const logIndex = numberValue(log.log_index);
  const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter(
    (topic) => typeof topic === "string",
  );

  return {
    blockNumber,
    logIndex,
    transactionHash: log.transaction_hash,
    data: log.data,
    topics,
    timestamp: timestamps.get(String(blockNumber)) ?? null,
  };
}

function logKey(log) {
  return `${String(log.block_number)}:${String(log.log_index)}:${String(
    log.transaction_hash,
  ).toLowerCase()}`;
}

async function fetchActivityPages({ token, accountTopic, contractAddress, fromBlock }) {
  const logs = [];
  const blocks = [];
  const seenLogs = new Set();
  let nextBlock = fromBlock;
  let targetEnd = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetch(HYPERSYNC_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from_block: nextBlock,
        ...(targetEnd === null ? {} : { to_block: targetEnd }),
        logs: [
          {
            address: [contractAddress],
            topics: [[TIP_RECEIVED_TOPIC], [accountTopic]],
          },
          {
            address: [contractAddress],
            topics: [[TIP_RECEIVED_TOPIC], [], [accountTopic]],
          },
          {
            address: [contractAddress],
            topics: [[CLAIMED_TOPIC], [accountTopic]],
          },
        ],
        field_selection: {
          block: ["number", "timestamp"],
          log: [
            "block_number",
            "log_index",
            "transaction_hash",
            "data",
            "topic0",
            "topic1",
            "topic2",
            "topic3",
          ],
        },
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Indexer returned ${response.status}: ${detail}`);
    }

    const payload = await response.json();
    const pageLogs = Array.isArray(payload?.data?.logs) ? payload.data.logs : [];
    const pageBlocks = Array.isArray(payload?.data?.blocks) ? payload.data.blocks : [];
    for (const log of pageLogs) {
      const key = logKey(log);
      if (!seenLogs.has(key)) {
        seenLogs.add(key);
        logs.push(log);
      }
    }
    blocks.push(...pageBlocks);

    if (targetEnd === null) targetEnd = numberValue(payload.archive_height);
    const followingBlock = numberValue(payload.next_block);
    if (!Number.isSafeInteger(followingBlock) || followingBlock <= nextBlock) {
      throw new Error("Indexer returned an invalid pagination cursor.");
    }
    nextBlock = followingBlock;
    if (!Number.isSafeInteger(targetEnd)) {
      throw new Error("Indexer returned an invalid archive height.");
    }
    if (nextBlock >= targetEnd) return { logs, blocks };
  }

  throw new Error("Indexer pagination limit was reached.");
}

export async function onRequestGet({ request, env }) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) {
    return json(
      { code: "CROSS_ORIGIN_DENIED", error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }
  const account = requestUrl.searchParams.get("address") ?? "";
  const network = requestUrl.searchParams.get("network") ?? "testnet";
  if (network !== "testnet") {
    return json(
      { code: "INDEXER_NETWORK_UNSUPPORTED", error: "History is not configured for this network." },
      { status: 501 },
    );
  }
  if (!ADDRESS_PATTERN.test(account)) {
    return json({ code: "INVALID_ADDRESS", error: "A valid wallet address is required." }, { status: 400 });
  }

  const token = env.ENVIO_API_TOKEN;
  if (!token) {
    return json(
      {
        code: "INDEXER_NOT_CONFIGURED",
        error: "History indexer is not configured.",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const contractAddress = String(
    env.ARC_TIP_JAR_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS,
  ).toLowerCase();
  const fromBlock = Number(
    env.ARC_TIP_JAR_DEPLOYMENT_BLOCK ?? DEFAULT_DEPLOYMENT_BLOCK,
  );
  if (!ADDRESS_PATTERN.test(contractAddress) || !Number.isSafeInteger(fromBlock)) {
    return json(
      { code: "INDEXER_CONFIG_INVALID", error: "History indexer configuration is invalid." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const accountTopic = indexedAddressTopic(account);
    const { logs, blocks } = await fetchActivityPages({
      token,
      accountTopic,
      contractAddress,
      fromBlock,
    });
    const timestamps = new Map(
      blocks.map((block) => [String(numberValue(block.number)), String(block.timestamp)]),
    );
    logs.sort(
      (left, right) =>
        numberValue(left.block_number) - numberValue(right.block_number) ||
        numberValue(left.log_index) - numberValue(right.log_index),
    );

    const lowerAccountTopic = accountTopic.toLowerCase();
    const sentLogs = logs.filter(
      (log) =>
        String(log.topic0).toLowerCase() === TIP_RECEIVED_TOPIC &&
        String(log.topic1).toLowerCase() === lowerAccountTopic,
    );
    const receivedLogs = logs.filter(
      (log) =>
        String(log.topic0).toLowerCase() === TIP_RECEIVED_TOPIC &&
        String(log.topic2).toLowerCase() === lowerAccountTopic,
    );
    const claimLogs = logs.filter(
      (log) =>
        String(log.topic0).toLowerCase() === CLAIMED_TOPIC &&
        String(log.topic1).toLowerCase() === lowerAccountTopic,
    );

    return json(
      {
        sentTipCount: sentLogs.length,
        sentTips: sentLogs
          .slice(-8)
          .reverse()
          .map((log) => normalizeLog(log, timestamps)),
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
          "cache-control": "public, max-age=10, s-maxage=30, stale-while-revalidate=60",
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
