import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { initLogger, log, logStep, writeLLMAudit } from './src/logger.js';
import { getJobOnChain, getJobMessages } from './src/leftclaw.js';
import { fetchAllSkills } from './src/skills.js';
import { analyzeJob } from './src/agents/orchestrator.js';
import { simplePlan, smartPlan, generateSteps } from './src/agents/planner.js';
import { evaluatePlan } from './src/agents/evaluator.js';

const DEFAULT_JOB_ID = 39;

function parseArgs() {
  const args = process.argv.slice(2);
  let jobId = DEFAULT_JOB_ID;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--job' && args[i + 1]) {
      jobId = parseInt(args[i + 1], 10);
    }
  }
  return { jobId };
}

function createBuildDir(jobId) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dirName = `job-${jobId}-${ts}`;
  const buildDir = join(process.cwd(), 'builds', dirName);
  mkdirSync(buildDir, { recursive: true });
  return buildDir;
}

async function run() {
  const { jobId } = parseArgs();

  const buildDir = createBuildDir(jobId);
  initLogger(buildDir);

  log(`=== LeftClaw Builder Agent ===`);
  log(`Job ID: ${jobId}`);
  log(`Build dir: ${buildDir}`);
  log('');

  // Step 1: Read job data from on-chain
  logStep('read_job', 'Fetching job data from Base...');
  const job = await getJobOnChain(jobId);
  writeFileSync(join(buildDir, 'job.json'), JSON.stringify(job, null, 2));
  logStep('read_job', `Done. Service type: ${job.serviceTypeId}, client: ${job.client}`);

  // Step 2: Read job messages
  logStep('read_messages', 'Fetching job messages from LeftClaw API...');
  const messages = await getJobMessages(jobId);
  writeFileSync(join(buildDir, 'messages.json'), JSON.stringify(messages, null, 2));
  logStep('read_messages', `Done. ${messages.length} messages`);

  // Step 3: Fetch skill files
  logStep('fetch_skills', 'Fetching SKILL.md files...');
  const skills = await fetchAllSkills(buildDir);
  logStep('fetch_skills', `Done. ${Object.keys(skills).length} skills fetched`);

  // Step 4: Orchestrator analyzes the job (minimax-m2.7)
  logStep('orchestrate', 'Orchestrator analyzing job...');
  const analysis = await analyzeJob(job, messages);
  writeFileSync(join(buildDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  logStep('orchestrate', `Done. Summary: ${analysis.summary || 'see analysis.json'}`);

  // Step 5: Simple planner outlines steps (minimax-m2.7)
  logStep('simple_plan', 'Simple planner outlining build steps...');
  const stepOutline = await simplePlan(job, messages, analysis, skills);
  writeFileSync(join(buildDir, 'step-outline.md'), stepOutline);
  logStep('simple_plan', 'Done. Step outline written.');

  // Step 6: Smart planner writes detailed plan (claude-sonnet-4.6)
  logStep('smart_plan', 'Smart planner writing detailed build plan...');
  const plan = await smartPlan(job, messages, analysis, skills, stepOutline);
  writeFileSync(join(buildDir, 'plan.md'), plan);
  logStep('smart_plan', 'Done. Detailed plan written.');

  // Step 7: Extract executable steps as JSON
  logStep('extract_steps', 'Extracting executable steps from plan...');
  const steps = await generateSteps(plan, analysis);
  writeFileSync(join(buildDir, 'steps.json'), JSON.stringify(steps, null, 2));
  logStep('extract_steps', `Done. ${Array.isArray(steps) ? steps.length : '?'} steps extracted.`);

  // Step 8: Evaluator reviews the plan (claude-sonnet-4.6)
  logStep('evaluate', 'Evaluator reviewing plan...');
  const evaluation = await evaluatePlan(plan, job, analysis);
  writeFileSync(join(buildDir, 'evaluation.json'), JSON.stringify(evaluation, null, 2));
  logStep('evaluate', `Done. Score: ${evaluation.overallScore || '?'}/10, Approved: ${evaluation.approved}`);

  // Step 9: Generate LLM audit report
  writeLLMAudit();

  // Summary
  log('');
  log('=== Build Complete ===');
  log(`Build dir: ${buildDir}`);
  log('Files produced:');
  log('  job.json         - On-chain job data');
  log('  messages.json    - Client messages');
  log('  skills/          - All SKILL.md reference files');
  log('  analysis.json    - Orchestrator analysis');
  log('  step-outline.md  - Simple planner outline');
  log('  plan.md          - Detailed build plan');
  log('  steps.json       - Executable step definitions');
  log('  evaluation.json  - Plan evaluation');
  log('  llm-audit.md     - LLM cost/token audit');
  log('  build.log        - Full run log');
  log('  trace.json       - Machine-parseable trace');

  if (evaluation.approved === false) {
    log('');
    log('WARNING: Plan was NOT approved by evaluator.');
    log(`Weaknesses: ${(evaluation.weaknesses || []).join(', ')}`);
    log(`Missing: ${(evaluation.missingItems || []).join(', ')}`);
  }
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
