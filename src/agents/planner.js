import { cheap, medium } from '../llm.js';
import { logDecision } from '../logger.js';
import { buildSkillContext } from '../skills.js';

const SE2_COMMAND_RULES = `
## CRITICAL SE2 COMMAND RULES — NEVER VIOLATE THESE

These are the ONLY valid commands. Use them exactly as shown.

- SCAFFOLD:      npx create-eth@latest -s foundry <name>
- COMPILE:       yarn compile                        (NEVER "forge build")
- TESTS:         yarn test                           (NEVER "forge test" directly)
- LOCAL NODE:    yarn chain                          (NEVER "anvil" directly)
- FORK:          yarn fork --network base            (NEVER "anvil --fork-url ...")
- DEPLOY LOCAL:  yarn deploy                         (NEVER "forge script ...")
- DEPLOY LIVE:   yarn deploy --network base          (NEVER "forge script ...")
- VERIFY:        yarn verify --network base
- DEV SERVER:    yarn start
- BUILD:         yarn next:build                     (NEVER "yarn build" — does not exist)
- IPFS DEPLOY:   yarn ipfs
- VERCEL:        yarn vercel:yolo --prod

"forge script" is FORBIDDEN in all steps. It bypasses SE2's key management and ABI generation.
All deployment goes through "yarn deploy" which handles everything correctly.

NEVER write or generate "packages/nextjs/contracts/deployedContracts.ts" — it is AUTO-GENERATED
by "yarn deploy" and will be overwritten. Any step that writes it manually produces fake data.
`;

export async function simplePlan(job, messages, analysis, skills) {
  const orchestrationContext = buildSkillContext(skills, ['ethskills-orchestration'], 6000);
  // Pass scaffold-eth skills in full — these are the source of truth for all commands
  const se2Context = buildSkillContext(skills, ['scaffold-eth', 'scaffold-eth-agents'], 20000);

  const prompt = `You are a build planner for Scaffold-ETH 2 dApps. You MUST follow the three-phase build system below exactly.
${SE2_COMMAND_RULES}
## THREE-PHASE BUILD SYSTEM (THIS IS YOUR FRAMEWORK — FOLLOW IT)
${orchestrationContext}

## SE2 Project Structure & Commands (SOURCE OF TRUTH — read in full)
${se2Context}

## Job Analysis
${JSON.stringify(analysis, null, 2)}

## Job Description (first 500 chars)
${(job.description || '').slice(0, 500)}

## YOUR TASK

Output a numbered list of build steps organized into THREE PHASES. Every build follows this structure — no exceptions:

### PHASE 1: LOCAL (contracts + UI on localhost)
Steps in this phase:
1. Scaffold: \`npx create-eth@latest -s foundry <name>\`
2. Write contracts in packages/foundry/contracts/
3. Write deploy script in packages/foundry/script/
4. Write tests in packages/foundry/test/ (≥90% coverage)
5. Run \`yarn fork --network base\` + \`yarn deploy\` — validate deployedContracts.ts generated
6. Build frontend pages in packages/nextjs/app/, components in packages/nextjs/components/
7. Use SE2 hooks: useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory
8. Validate: full user journey works on localhost with forked chain

### PHASE 2: LIVE CONTRACTS + LOCAL UI
Steps in this phase:
1. Update scaffold.config.ts targetNetworks
2. \`yarn deploy --network base\` + \`yarn verify --network base\`
3. Test with real wallet against live contracts
4. Polish UI, remove SE2 branding, apply custom theme
5. Validate: contracts verified on Blockscout, full journey works with live contracts

### PHASE 3: PRODUCTION
Steps in this phase:
1. Set burnerWalletMode: "localNetworksOnly"
2. Update metadata (title, description, OG image)
3. Build + deploy to BGIPFS: \`yarn ipfs\`
4. Production QA: wallet connect, read/write ops, no console errors, mobile responsive

For each step, note:
- What to do (exact SE2 paths and commands)
- Which model tier: cheap (minimax-m2.7), medium (claude-sonnet-4.6), or expensive (claude-opus-4.6)
- What inputs/context it needs
- Validation gate (how to confirm the step succeeded before moving on)

Be brief but specific. This guides the smart planner.`;

  const result = await cheap(
    'You are a build step planner for Scaffold-ETH 2 dApps. You follow the three-phase build system (Phase 1 local, Phase 2 live contracts, Phase 3 production) exactly. Output concise numbered steps organized by phase.',
    prompt,
    { role: 'simple-planner', maxTokens: 2048 }
  );

  logDecision('simple-planner', 'steps_outlined', `Generated step outline`);
  return result;
}

export async function smartPlan(job, messages, analysis, skills, stepOutline) {
  const orchestrationContext = buildSkillContext(skills, ['ethskills-orchestration'], 4000);
  const se2Context = buildSkillContext(skills, ['scaffold-eth', 'scaffold-eth-agents'], 8000);
  const extraSkills = (analysis.relevantSkills || [])
    .filter(s => s !== 'ethskills-orchestration')
    .slice(0, 2);
  const extraContext = buildSkillContext(skills, extraSkills, 800);

  const clientChat = messages
    .filter(m => m.type === 'client_message' || m.type === 'ai_response')
    .map(m => `[${m.type}] ${m.content}`)
    .join('\n\n');

  const prompt = `You are a senior architect writing a detailed build plan for a LeftClaw Services build job. You MUST follow the three-phase build system from ethskills.com/orchestration exactly.
${SE2_COMMAND_RULES}
## Job
- ID: ${job.id}
- Client: ${job.client}
- Service Type: ${job.serviceTypeId} (Build)

## Description
${(job.description || '').slice(0, 1500)}

## Client Chat
${clientChat.slice(0, 1500) || '(none)'}

## Orchestrator Analysis
${JSON.stringify(analysis, null, 2).slice(0, 1500)}

## Step Outline (from simple planner — already organized by phase)
${stepOutline.slice(0, 3000)}

## THREE-PHASE BUILD METHODOLOGY (MANDATORY — follow this exactly)
${orchestrationContext}

## SE2 Project Structure & Commands (SOURCE OF TRUTH — read in full)
${se2Context}

## Additional Skills
${extraContext}

## Your Task

Write a comprehensive build plan in markdown. Structure it around the THREE PHASES:

### 1. Architecture Overview
- What goes onchain vs offchain
- Contract design (functions, storage, events)
- Frontend pages and components
- Chain selection rationale

### 2. Smart Contract Plan
- Each contract: name, purpose, key functions, storage layout
- Security considerations
- Testing strategy (unit, fuzz, fork tests)

### 3. Frontend Plan
- Component hierarchy
- Hook usage (useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory — NOT raw wagmi)
- UX flows (three-button flow for token interactions, loading states, error handling)
- Theming/styling requirements from client chat
- DaisyUI classes where possible, custom CSS only when needed

### 4. Phase 1 Steps (LOCAL: fork + contracts + tests + frontend on localhost)
For each step: model tier, context needed, expected output, validation gate.
- Scaffold project
- Write contracts → deploy script → tests
- \`yarn fork --network base\` + \`yarn deploy\` → validate deployedContracts.ts
- Build frontend pages + components with SE2 hooks
- Validate full user journey on localhost

### 5. Phase 2 Steps (LIVE CONTRACTS + LOCAL UI)
- Update scaffold.config.ts targetNetworks
- \`yarn deploy --network base\` + \`yarn verify\`
- Test with real wallet, polish UI, apply final theme
- Validate contracts on Blockscout, full journey with live contracts

### 6. Phase 3 Steps (PRODUCTION)
- Pre-deploy checklist (burnerWalletMode, metadata, OG image)
- Build + deploy frontend to BGIPFS
- Production QA checklist

### 7. Phase Transition Rules
- Phase 3 bug → back to Phase 2
- Phase 2 contract bug → back to Phase 1 (fix, regression test, redeploy)
- Never hack around bugs in production

Follow ethskills.com guidance exactly. Use Scaffold-ETH 2 patterns. Deploy to Base.`;

  const result = await medium(
    'You are a senior Ethereum dApp architect. You follow the three-phase build system (Phase 1 local, Phase 2 live contracts, Phase 3 production) exactly. Write precise, actionable build plans.',
    prompt,
    { role: 'smart-planner', maxTokens: 8192 }
  );

  logDecision('smart-planner', 'plan_written', `Generated detailed build plan`);
  return result;
}

export async function generateSteps(plan, analysis) {
  const prompt = `Extract the executable build steps from this plan as a JSON array. The plan follows a three-phase structure — preserve the phase in each step.
${SE2_COMMAND_RULES}
IMPORTANT: If the plan mentions "forge script" anywhere, replace it with the correct "yarn deploy" (or "yarn deploy --network <network>") in the extracted step's command field.

## Plan
${plan}

## Analysis
${JSON.stringify(analysis, null, 2)}

For each step, output:
{
  "id": "step_number",
  "name": "step name",
  "phase": 1|2|3,
  "stage": "leftclaw pipeline stage if applicable (e.g. create_plan, prototype, contract_audit, deploy_contract, deploy_app) or 'internal'",
  "model": "cheap|medium|expensive",
  "description": "what this step does",
  "command": "exact shell command if applicable, or null",
  "contextNeeded": ["list of files or data this step needs"],
  "expectedOutput": "what this step produces",
  "validationGate": "how to confirm this step succeeded before moving to the next",
  "dependencies": ["ids of steps that must complete first"]
}

Output ONLY a valid JSON array. No markdown fences.`;

  const result = await cheap(
    'Extract build steps as a JSON array. Output ONLY valid JSON.',
    prompt,
    { role: 'step-extractor', maxTokens: 4096 }
  );

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    logDecision('step-extractor', 'parse_failed', 'Could not parse steps JSON, returning raw');
    return [{ raw: result }];
  }
}
