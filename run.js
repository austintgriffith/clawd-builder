import 'dotenv/config';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { initLogger, log, logStep, writeLLMAudit } from './src/logger.js';
import { getJobOnChain, getJobMessages } from './src/leftclaw.js';
import { fetchAllSkills } from './src/skills.js';
import { analyzeJob } from './src/agents/orchestrator.js';
import { simplePlan, smartPlan, generateSteps } from './src/agents/planner.js';
import { evaluatePlan } from './src/agents/evaluator.js';
import { executeAllSteps } from './src/executor.js';

const DEFAULT_JOB_ID = 39;

function parseArgs() {
  const args = process.argv.slice(2);
  let jobId = DEFAULT_JOB_ID;
  let executeBuildDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--job' && args[i + 1]) {
      jobId = parseInt(args[i + 1], 10);
    }
    if (args[i] === '--execute' && args[i + 1]) {
      executeBuildDir = args[i + 1];
    }
  }
  return { jobId, executeBuildDir };
}

function createBuildDir(jobId) {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dirName = `job-${jobId}-${ts}`;
  const buildDir = join(process.cwd(), 'builds', dirName);
  mkdirSync(buildDir, { recursive: true });
  return buildDir;
}

function loadJSON(filepath) {
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

function loadText(filepath) {
  return readFileSync(filepath, 'utf-8');
}

/**
 * Execute-only mode: skip planning, use existing build artifacts.
 * Usage: node run.js --execute builds/job-39-20260407-001148
 */
async function runExecuteOnly(buildDir) {
  initLogger(buildDir);

  log('=== LeftClaw Builder Agent (execute-only mode) ===');
  log(`Build dir: ${buildDir}`);
  log('');

  const stepsPath = join(buildDir, 'steps.json');
  const planPath = join(buildDir, 'plan.md');
  const analysisPath = join(buildDir, 'analysis.json');
  const jobPath = join(buildDir, 'job.json');
  const messagesPath = join(buildDir, 'messages.json');

  if (!existsSync(stepsPath)) {
    throw new Error(`No steps.json found in ${buildDir}. Run full pipeline first.`);
  }

  const steps = loadJSON(stepsPath);
  const plan = existsSync(planPath) ? loadText(planPath) : '';
  const analysis = existsSync(analysisPath) ? loadJSON(analysisPath) : {};
  const job = existsSync(jobPath) ? loadJSON(jobPath) : {};
  const messages = existsSync(messagesPath) ? loadJSON(messagesPath) : [];

  logStep('load_skills', 'Loading cached skills...');
  const skills = {};
  const skillsDir = join(buildDir, 'skills');
  if (existsSync(skillsDir)) {
    const { readdirSync } = await import('fs');
    for (const file of readdirSync(skillsDir)) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '');
        skills[name] = readFileSync(join(skillsDir, file), 'utf-8');
      }
    }
  }
  logStep('load_skills', `Loaded ${Object.keys(skills).length} cached skills`);

  log(`Loaded ${steps.length} steps from steps.json`);
  logStep('execute', `Starting step execution (${steps.length} steps)...`);

  const execResult = await executeAllSteps(steps, buildDir, {
    skills,
    plan,
    analysis,
    job,
    messages,
  });

  logStep('execute', `Execution complete. ${Object.keys(execResult.completedSteps).length}/${steps.length} steps succeeded.`);

  writeLLMAudit();

  log('');
  log('=== Execution Complete ===');
  log(`Build dir: ${buildDir}`);
}

/**
 * Full pipeline: plan + evaluate + execute.
 */
async function runFull() {
  const { jobId } = parseArgs();

  const buildDir = createBuildDir(jobId);
  initLogger(buildDir);

  log(`=== LeftClaw Builder Agent ===`);
  log(`Job ID: ${jobId}`);
  log(`Build dir: ${buildDir}`);
  log('');

  logStep('read_job', 'Fetching job data from Base...');
  const job = await getJobOnChain(jobId);
  writeFileSync(join(buildDir, 'job.json'), JSON.stringify(job, null, 2));
  logStep('read_job', `Done. Service type: ${job.serviceTypeId}, client: ${job.client}`);

  logStep('read_messages', 'Fetching job messages from LeftClaw API...');
  const messages = await getJobMessages(jobId);
  writeFileSync(join(buildDir, 'messages.json'), JSON.stringify(messages, null, 2));
  logStep('read_messages', `Done. ${messages.length} messages`);

  logStep('fetch_skills', 'Fetching SKILL.md files...');
  const skills = await fetchAllSkills(buildDir);
  logStep('fetch_skills', `Done. ${Object.keys(skills).length} skills fetched`);

  logStep('orchestrate', 'Orchestrator analyzing job...');
  const analysis = await analyzeJob(job, messages);
  writeFileSync(join(buildDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  logStep('orchestrate', `Done. Summary: ${analysis.summary || 'see analysis.json'}`);

  logStep('simple_plan', 'Simple planner outlining build steps...');
  const stepOutline = await simplePlan(job, messages, analysis, skills);
  writeFileSync(join(buildDir, 'step-outline.md'), stepOutline);
  logStep('simple_plan', 'Done. Step outline written.');

  logStep('smart_plan', 'Smart planner writing detailed build plan...');
  const plan = await smartPlan(job, messages, analysis, skills, stepOutline);
  writeFileSync(join(buildDir, 'plan.md'), plan);
  logStep('smart_plan', 'Done. Detailed plan written.');

  logStep('extract_steps', 'Extracting executable steps from plan...');
  const steps = await generateSteps(plan, analysis);
  writeFileSync(join(buildDir, 'steps.json'), JSON.stringify(steps, null, 2));
  logStep('extract_steps', `Done. ${Array.isArray(steps) ? steps.length : '?'} steps extracted.`);

  logStep('evaluate', 'Evaluator reviewing plan...');
  const evaluation = await evaluatePlan(plan, job, analysis);
  writeFileSync(join(buildDir, 'evaluation.json'), JSON.stringify(evaluation, null, 2));
  logStep('evaluate', `Done. Score: ${evaluation.overallScore || '?'}/10, Approved: ${evaluation.approved}`);

  if (Array.isArray(steps) && steps.length > 0) {
    logStep('execute', `Plan score: ${evaluation.overallScore}/10. Starting step execution...`);
    const execResult = await executeAllSteps(steps, buildDir, {
      skills,
      plan,
      analysis,
      job,
      messages,
    });
    logStep('execute', `Execution complete. ${Object.keys(execResult.completedSteps).length}/${steps.length} steps succeeded.`);

    if (evaluation.approved === false) {
      log('');
      log(`NOTE: Evaluator had concerns (score ${evaluation.overallScore}/10):`);
      log(`  Weaknesses: ${(evaluation.weaknesses || []).join(', ')}`);
    }
  } else {
    log('');
    log('WARNING: No valid steps extracted. Skipping execution.');
  }

  writeLLMAudit();

  log('');
  log('=== Build Complete ===');
  log(`Build dir: ${buildDir}`);
  log('Files produced:');
  log('  job.json           - On-chain job data');
  log('  messages.json      - Client messages');
  log('  skills/            - All SKILL.md reference files');
  log('  analysis.json      - Orchestrator analysis');
  log('  step-outline.md    - Simple planner outline');
  log('  plan.md            - Detailed build plan');
  log('  steps.json         - Executable step definitions');
  log('  evaluation.json    - Plan evaluation');
  log('  execution-log.json - Step-by-step execution results');
  log('  project/           - Scaffolded project output');
  log('  llm-audit.md       - LLM cost/token audit');
  log('  build.log          - Full run log');
  log('  trace.json         - Machine-parseable trace');
}

async function run() {
  const { executeBuildDir } = parseArgs();

  if (executeBuildDir) {
    const absDir = join(process.cwd(), executeBuildDir);
    if (!existsSync(absDir)) {
      throw new Error(`Build directory not found: ${absDir}`);
    }
    return runExecuteOnly(absDir);
  }

  return runFull();
}

run().catch(err => {
  // Write the crash to build.log so it's visible in the tail output
  try { log(`FATAL ERROR: ${err.message}\n${err.stack}`); } catch { /* logger may not be init */ }
  console.error('FATAL:', err);
  process.exit(1);
});
