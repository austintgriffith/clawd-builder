import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { log } from './logger.js';

const KEYSTORE_NAME = 'agent-deployer';
const KEYSTORE_PASSWORD = 'agent';
const KEYSTORE_PATH = join(process.env.HOME, '.foundry', 'keystores', KEYSTORE_NAME);
const ADDRESS_FILE = join(process.env.HOME, '.foundry', 'agent-deployer-address');
const MIN_BALANCE = parseEther('0.001');
const FUND_AMOUNT = parseEther('0.002');

function getBaseClients(agentKey) {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('BASE_RPC_URL not set');

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const account = privateKeyToAccount(agentKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  return { publicClient, walletClient };
}

/**
 * Ensure a persistent deployer key exists in the Foundry keystore,
 * and that it has enough Base ETH to deploy contracts.
 *
 * - First call: generates a key, imports to keystore, funds from agent wallet
 * - Subsequent calls: checks balance, tops up if low
 *
 * Sets ETH_KEYSTORE_ACCOUNT and FOUNDRY_PASSWORD in process.env.
 * Returns { address }.
 */
export async function ensureDeployer() {
  const agentKey = process.env.ETH_PRIVATE_KEY;
  if (!agentKey) throw new Error('ETH_PRIVATE_KEY not set');

  let deployerAddress;

  if (!existsSync(KEYSTORE_PATH)) {
    log('DEPLOYER: no keystore found, generating new deployer key...');
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    deployerAddress = account.address;

    // Import into Foundry keystore
    execSync(
      `cast wallet import --private-key ${privateKey} --unsafe-password ${KEYSTORE_PASSWORD} ${KEYSTORE_NAME}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Save the address so we can read it without the key
    writeFileSync(ADDRESS_FILE, deployerAddress);
    log(`DEPLOYER: created keystore "${KEYSTORE_NAME}" → ${deployerAddress}`);
  } else {
    if (!existsSync(ADDRESS_FILE)) {
      // Keystore exists but address file is missing -- recover via cast
      const output = execSync(
        `cast wallet address --account ${KEYSTORE_NAME} --password ${KEYSTORE_PASSWORD}`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      deployerAddress = output;
      writeFileSync(ADDRESS_FILE, deployerAddress);
    } else {
      deployerAddress = readFileSync(ADDRESS_FILE, 'utf-8').trim();
    }
    log(`DEPLOYER: using existing keystore "${KEYSTORE_NAME}" → ${deployerAddress}`);
  }

  // Check balance and fund if needed
  const { publicClient, walletClient } = getBaseClients(agentKey);
  const balance = await publicClient.getBalance({ address: deployerAddress });
  log(`DEPLOYER: balance = ${formatEther(balance)} ETH`);

  if (balance < MIN_BALANCE) {
    log(`DEPLOYER: balance below ${formatEther(MIN_BALANCE)} ETH, funding with ${formatEther(FUND_AMOUNT)} ETH from agent wallet...`);
    const agentAccount = privateKeyToAccount(agentKey);
    const agentBalance = await publicClient.getBalance({ address: agentAccount.address });
    log(`DEPLOYER: agent wallet ${agentAccount.address} balance = ${formatEther(agentBalance)} ETH`);

    if (agentBalance < FUND_AMOUNT + parseEther('0.0005')) {
      throw new Error(`Agent wallet has insufficient balance (${formatEther(agentBalance)} ETH) to fund deployer`);
    }

    const hash = await walletClient.sendTransaction({
      to: deployerAddress,
      value: FUND_AMOUNT,
    });
    log(`DEPLOYER: funding tx sent: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`DEPLOYER: funding confirmed in block ${receipt.blockNumber}`);
  }

  // Don't set ETH_KEYSTORE_ACCOUNT globally -- it breaks localhost deploys.
  // The executor passes these only to mainnet forge commands.

  return { address: deployerAddress, keystoreName: KEYSTORE_NAME, keystorePassword: KEYSTORE_PASSWORD };
}
