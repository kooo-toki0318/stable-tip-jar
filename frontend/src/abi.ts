export const arcTipJarAbi = [
  {
    type: "function",
    name: "tip",
    stateMutability: "payable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "message", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "claimableBalance",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimableTipCount",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "receivedByRecipient",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimedByRecipient",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "recipientTipCount",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "recipientClaimCount",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRecipientClaim",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [
      { name: "amount", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getRecipientTip",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [
      { name: "sender", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "timestamp", type: "uint256" },
      { name: "message", type: "string" },
    ],
  },
] as const;
