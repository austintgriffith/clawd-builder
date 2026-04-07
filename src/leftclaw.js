import { createPublicClient, http, encodeFunctionData, parseAbi, decodeAbiParameters } from 'viem';
import { base } from 'viem/chains';
import { log } from './logger.js';

const CONTRACT_ADDRESS = '0xb2fb486a9569ad2c97d9c73936b46ef7fdaa413a';
const LEFTCLAW_API = 'https://leftclaw.services';

function getClient() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('BASE_RPC_URL not set');
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
}

function decodeWord(hex, wordIndex) {
  const start = wordIndex * 64;
  return BigInt('0x' + hex.slice(start, start + 64));
}

function decodeAddress(hex, wordIndex) {
  const start = wordIndex * 64;
  return '0x' + hex.slice(start + 24, start + 64);
}

function decodeString(hex, tupleStart, offsetFromTuple) {
  const absWord = tupleStart + offsetFromTuple / 32;
  const length = Number(decodeWord(hex, absWord));
  const dataStart = (absWord + 1) * 64;
  const dataHex = hex.slice(dataStart, dataStart + length * 2);
  return Buffer.from(dataHex, 'hex').toString('utf8');
}

export async function getJobOnChain(jobId) {
  log(`Reading job ${jobId} from on-chain...`);
  const client = getClient();

  const callData = encodeFunctionData({
    abi: parseAbi(['function getJob(uint256 jobId)']),
    functionName: 'getJob',
    args: [BigInt(jobId)],
  });

  const result = await client.call({
    to: CONTRACT_ADDRESS,
    data: callData,
  });

  const hex = result.data.slice(2);

  // Word 0: outer offset (32 → tuple at word 1)
  // Tuple starts at word 1. Fields decoded empirically:
  const tupleStart = 1;
  const id             = Number(decodeWord(hex, tupleStart + 0));
  const jobClient      = decodeAddress(hex, tupleStart + 1);
  const serviceTypeId  = Number(decodeWord(hex, tupleStart + 2));
  const status         = Number(decodeWord(hex, tupleStart + 3));
  const priceUsd       = Number(decodeWord(hex, tupleStart + 4));
  const descOffset     = Number(decodeWord(hex, tupleStart + 5));
  const paymentMethod  = Number(decodeWord(hex, tupleStart + 6));
  const createdAt      = Number(decodeWord(hex, tupleStart + 7));
  const paymentClawd   = decodeWord(hex, tupleStart + 8).toString();
  const cvAmount       = decodeWord(hex, tupleStart + 9).toString();
  const stageOffset    = Number(decodeWord(hex, tupleStart + 10));
  const resultOffset   = Number(decodeWord(hex, tupleStart + 15));

  const description  = decodeString(hex, tupleStart, descOffset);
  const currentStage = stageOffset > 0 ? decodeString(hex, tupleStart, stageOffset) : '';
  const resultURL    = resultOffset > 0 ? decodeString(hex, tupleStart, resultOffset) : '';

  const job = {
    id,
    client: jobClient,
    serviceTypeId,
    description,
    status,
    currentStage,
    paymentMethod,
    paymentClawd,
    priceUsd,
    cvAmount,
    resultURL,
    createdAt,
  };

  log(`Job ${jobId}: serviceType=${job.serviceTypeId} status=${job.status} stage="${job.currentStage}" client=${job.client}`);
  return job;
}

export async function getJobMessages(jobId) {
  log(`Fetching messages for job ${jobId}...`);
  const res = await fetch(`${LEFTCLAW_API}/api/job/${jobId}/messages`);
  if (!res.ok) {
    throw new Error(`Failed to fetch messages for job ${jobId}: ${res.status}`);
  }
  const data = await res.json();
  const messages = data.messages || [];
  log(`Got ${messages.length} messages for job ${jobId}`);
  return messages;
}

// --- Write methods (stubbed for now) ---
// export async function acceptJob(jobId) { ... }
// export async function logWork(jobId, note, stage) { ... }
// export async function completeJob(jobId, resultURL) { ... }
