import { expensive } from '../llm.js';
import { logDecision } from '../logger.js';

export async function writeContract(spec, securityContext) {
  const result = await expensive(
    `You are a senior Solidity developer. Write production-quality smart contracts.

Rules:
- Use OpenZeppelin contracts as base where applicable
- Follow Checks-Effects-Interactions pattern
- Use SafeERC20 for all token operations
- Emit events for every state change
- USDC has 6 decimals, not 18
- Never use infinite approvals
- No reentrancy vulnerabilities
- Add NatSpec comments for all public functions
- Follow ethskills.com security patterns exactly`,
    `${spec}\n\n## Security Context\n${securityContext}`,
    { role: 'senior-dev', maxTokens: 8192 }
  );

  logDecision('senior-dev', 'contract_written', spec.slice(0, 80));
  return result;
}

export async function reviewAndFix(code, auditFindings) {
  const result = await expensive(
    'You are a senior Solidity auditor. Fix the issues found in this code. Explain each fix.',
    `## Code\n${code}\n\n## Audit Findings\n${auditFindings}`,
    { role: 'senior-dev', maxTokens: 8192 }
  );

  logDecision('senior-dev', 'fixes_applied', `Applied fixes for audit findings`);
  return result;
}

export async function writeComplexCode(task, context) {
  const result = await expensive(
    'You are a senior full-stack developer specializing in Ethereum dApps. Write production-quality code following ethskills.com and Scaffold-ETH 2 patterns exactly.',
    `${task}\n\n## Context\n${context}`,
    { role: 'senior-dev', maxTokens: 8192 }
  );

  logDecision('senior-dev', 'complex_code_written', task.slice(0, 80));
  return result;
}
