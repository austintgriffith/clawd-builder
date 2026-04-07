import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { cheap, medium, expensive } from './llm.js';
import { log, logStepExecution } from './logger.js';
import { assembleContext, classifyStep } from './context-assembler.js';
import { writeFilesFromOutput } from './file-writer.js';
import { validateStep } from './step-validator.js';

const MAX_RETRIES = 2;
const SHELL_TIMEOUT_MS = 180_000;
const LONG_RUNNING_PATTERNS = /\b(fork|start|dev|serve|watch)\b/i;
const BACKGROUND_READY_TIMEOUT_MS = 30_000;

const backgroundProcesses = [];

function cleanupBackgroundProcesses() {
  for (const proc of backgroundProcesses) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
      log(`EXECUTOR: killed background process ${proc.pid} (${proc.label})`);
    } catch { /* already dead */ }
  }
  backgroundProcesses.length = 0;
}

process.on('exit', cleanupBackgroundProcesses);
process.on('SIGINT', () => { cleanupBackgroundProcesses(); process.exit(1); });
process.on('SIGTERM', () => { cleanupBackgroundProcesses(); process.exit(1); });

/**
 * Execute all steps from steps.json in topological order.
 *
 * After the first shell step that scaffolds a project (creates a new subdirectory),
 * all subsequent steps use that subdirectory as the effective project root.
 */
export async function executeAllSteps(steps, buildDir, context) {
  const baseProjectDir = join(buildDir, 'project');
  mkdirSync(baseProjectDir, { recursive: true });

  let projectDir = baseProjectDir;

  const sorted = topologicalSort(steps);
  const stepMap = new Map(steps.map(s => [s.id, s]));

  const state = {};
  for (const s of steps) {
    state[s.id] = { status: 'pending', attempts: 0 };
  }

  const completedSteps = {};
  const executionLog = [];

  log(`EXECUTOR: ${sorted.length} steps to execute in topological order`);
  log(`EXECUTOR: project dir → ${projectDir}`);

  for (const stepId of sorted) {
    const step = stepMap.get(stepId);
    if (!step) {
      log(`EXECUTOR: step ${stepId} not found in step map, skipping`);
      continue;
    }

    const depsOk = (step.dependencies || []).every(d => state[d]?.status === 'completed');
    if (!depsOk) {
      const missing = (step.dependencies || []).filter(d => state[d]?.status !== 'completed');
      logStepExecution(stepId, 'skipped', `Dependencies not met: ${missing.join(', ')}`);
      state[stepId].status = 'skipped';
      executionLog.push({ stepId, status: 'skipped', reason: `Unmet deps: ${missing.join(', ')}` });
      continue;
    }

    state[stepId].status = 'running';
    logStepExecution(stepId, 'started', `"${step.name}" (${step.model})`);

    let lastFeedback = null;
    let success = false;

    // Snapshot project dir contents before shell steps so we can clean up on retry
    const dirSnapshotBefore = classifyStep(step) === 'shell_cmd'
      ? snapshotDir(projectDir) : null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      state[stepId].attempts = attempt + 1;
      if (attempt > 0) {
        logStepExecution(stepId, 'retry', `Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${lastFeedback?.slice(0, 100)}`);
        // Clean up directories created by the previous failed attempt
        if (dirSnapshotBefore) {
          cleanupNewDirs(projectDir, dirSnapshotBefore);
        }
      }

      try {
        const result = await executeStep(step, {
          projectDir,
          buildDir,
          completedSteps,
          skills: context.skills,
          plan: context.plan,
          analysis: context.analysis,
          previousAttemptFeedback: lastFeedback,
        });

        // After a scaffold-like shell step, detect the new project root
        if (result.stepType === 'shell_cmd' && result.exitCode === 0) {
          const detected = detectScaffoldedDir(baseProjectDir, projectDir);
          if (detected) {
            projectDir = detected;
            log(`EXECUTOR: detected scaffolded project → ${projectDir}`);
          }
        }

        const validation = await validateStep(step, result);

        if (validation.passed) {
          state[stepId].status = 'completed';
          completedSteps[stepId] = {
            name: step.name,
            outputSummary: result.outputSummary || '',
            filesWritten: result.filesWritten || [],
          };
          logStepExecution(stepId, 'completed', validation.reason);
          executionLog.push({
            stepId,
            status: 'completed',
            attempts: attempt + 1,
            filesWritten: (result.filesWritten || []).map(f => f.relativePath),
            validation,
          });
          success = true;
          break;
        }

        lastFeedback = `${validation.reason}. Suggestions: ${validation.suggestions.join('; ')}`;
      } catch (err) {
        lastFeedback = `Error: ${err.message}`;
        logStepExecution(stepId, 'error', `Attempt ${attempt + 1}: ${err.message.slice(0, 200)}`);
      }
    }

    if (!success) {
      state[stepId].status = 'failed';
      logStepExecution(stepId, 'failed', `After ${state[stepId].attempts} attempts: ${lastFeedback?.slice(0, 200)}`);
      executionLog.push({
        stepId,
        status: 'failed',
        attempts: state[stepId].attempts,
        lastFeedback,
      });
    }

    writeFileSync(join(buildDir, 'execution-log.json'), JSON.stringify(executionLog, null, 2));
  }

  cleanupBackgroundProcesses();

  const summary = summarizeExecution(state);
  log(`EXECUTOR: ${summary}`);

  return { completedSteps, state, executionLog };
}

/**
 * After a shell command runs in baseProjectDir, check if a single new
 * subdirectory appeared that looks like a scaffolded project (has package.json).
 * If projectDir hasn't been updated yet (still equals baseProjectDir), return it.
 */
function detectScaffoldedDir(baseProjectDir, currentProjectDir) {
  if (currentProjectDir !== baseProjectDir) return null;

  try {
    const entries = readdirSync(baseProjectDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));

    for (const entry of entries) {
      const candidate = join(baseProjectDir, entry.name);
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate;
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function executeStep(step, assemblyContext) {
  const assembled = await assembleContext(step, assemblyContext);
  const { stepType } = assembled;

  if (stepType === 'read_context') {
    return executeReadContext(step, assembled, assemblyContext);
  }

  if (stepType === 'shell_cmd') {
    return executeShellCmd(step, assembled, assemblyContext);
  }

  return executeCodeGen(step, assembled, assemblyContext);
}

async function executeReadContext(step, assembled, ctx) {
  const { gatheredContext } = assembled;

  const contextFile = `step-${step.id}-context.md`;
  writeFileSync(join(ctx.buildDir, contextFile), gatheredContext);

  return {
    stepType: 'read_context',
    outputSummary: `Read context: ${gatheredContext.length} chars gathered`,
    filesWritten: [],
  };
}

async function executeShellCmd(step, assembled, ctx) {
  const command = preprocessCommand(assembled.command, ctx.projectDir);
  const { projectDir, buildDir } = ctx;

  const isLongRunning = LONG_RUNNING_PATTERNS.test(command);

  if (isLongRunning) {
    return executeLongRunningCmd(step, command, projectDir, buildDir);
  }

  return executeBlockingCmd(step, command, projectDir, buildDir);
}

/**
 * Transform known problematic commands before execution.
 * - create-eth: add --skip-install, then install with immutable installs disabled
 * - Strip redundant `cd <project>` prefixes (projectDir is already set)
 * - yarn install: disable immutable installs
 */
function preprocessCommand(command, projectDir) {
  if (/create-eth/.test(command)) {
    const projectName = command.match(/create-eth@\S+\s+(?:-\w\s+\w+\s+)?(\w+)/)?.[1] || 'project';
    const skipInstall = command.includes('--skip-install') ? '' : ' --skip-install';
    const scaffoldPart = command.replace(/(create-eth@\S+)/, `$1${skipInstall}`)
      .replace(/&&\s*cd\s+\S+\s*&&\s*yarn\s+install.*$/, '');
    return `${scaffoldPart} && cd ${projectName} && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`;
  }

  // Strip "cd <dir> &&" prefixes since projectDir is already the project root
  let cmd = command.replace(/^cd\s+\S+\s*&&\s*/, '');

  if (/yarn\s+install/.test(cmd) && !cmd.includes('YARN_ENABLE_IMMUTABLE_INSTALLS')) {
    cmd = cmd.replace(/yarn\s+install/, 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install');
  }

  return cmd;
}

function executeBlockingCmd(step, command, projectDir, buildDir) {
  log(`EXECUTOR: running command: ${command}`);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(command, {
      cwd: projectDir,
      timeout: SHELL_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME },
    });
  } catch (err) {
    exitCode = err.status || 1;
    stdout = err.stdout || '';
    stderr = err.stderr || '';
  }

  const outputFile = `step-${step.id}-shell.log`;
  writeFileSync(join(buildDir, outputFile),
    `$ ${command}\n\nEXIT CODE: ${exitCode}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);

  return {
    stepType: 'shell_cmd',
    exitCode,
    stdout,
    stderr,
    outputSummary: exitCode === 0
      ? `Command succeeded (${stdout.length} chars output)`
      : `Command failed with exit code ${exitCode}`,
    filesWritten: [],
  };
}

/**
 * Spawn a long-running process (e.g. yarn fork, yarn start) in the background.
 * Wait for a readiness signal in stdout/stderr, then return success.
 * The process keeps running; it will be killed when execution finishes.
 */
function executeLongRunningCmd(step, command, projectDir, buildDir) {
  return new Promise((resolve) => {
    log(`EXECUTOR: spawning background process: ${command}`);

    const outputFile = join(buildDir, `step-${step.id}-shell.log`);
    let allOutput = `$ ${command} (background)\n\n`;

    const child = spawn('sh', ['-c', command], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME },
    });

    backgroundProcesses.push({ pid: child.pid, label: `step-${step.id}: ${command}` });

    let settled = false;
    const readyPatterns = [
      /listening/i,
      /ready/i,
      /started/i,
      /running at/i,
      /localhost:\d+/i,
      /anvil/i,
      /forked/i,
      /block number/i,
    ];

    function checkReady(data) {
      const text = data.toString();
      allOutput += text;
      if (settled) return;
      if (readyPatterns.some(p => p.test(text))) {
        settled = true;
        writeFileSync(outputFile, allOutput);
        resolve({
          stepType: 'shell_cmd',
          exitCode: 0,
          stdout: allOutput,
          stderr: '',
          outputSummary: `Background process started (pid ${child.pid})`,
          filesWritten: [],
        });
      }
    }

    child.stdout.on('data', checkReady);
    child.stderr.on('data', checkReady);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      allOutput += `\nERROR: ${err.message}\n`;
      writeFileSync(outputFile, allOutput);
      resolve({
        stepType: 'shell_cmd',
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        outputSummary: `Background process failed to start: ${err.message}`,
        filesWritten: [],
      });
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      allOutput += `\nEXIT CODE: ${code}\n`;
      writeFileSync(outputFile, allOutput);
      resolve({
        stepType: 'shell_cmd',
        exitCode: code || 1,
        stdout: allOutput,
        stderr: '',
        outputSummary: `Process exited with code ${code}`,
        filesWritten: [],
      });
    });

    // Timeout: if no readiness signal after BACKGROUND_READY_TIMEOUT_MS, assume it's running
    setTimeout(() => {
      if (settled) return;
      settled = true;
      writeFileSync(outputFile, allOutput + '\n(timed out waiting for ready signal, assuming running)\n');
      log(`EXECUTOR: background process ${child.pid} -- no ready signal after ${BACKGROUND_READY_TIMEOUT_MS}ms, assuming running`);
      resolve({
        stepType: 'shell_cmd',
        exitCode: 0,
        stdout: allOutput,
        stderr: '',
        outputSummary: `Background process running (pid ${child.pid}, assumed ready after timeout)`,
        filesWritten: [],
      });
    }, BACKGROUND_READY_TIMEOUT_MS);
  });
}

async function executeCodeGen(step, assembled, ctx) {
  const { systemPrompt, userPrompt, targetModel } = assembled;
  const { projectDir, buildDir } = ctx;

  const callFn = pickModelFn(targetModel);
  const llmOutput = await callFn(systemPrompt, userPrompt, {
    role: `exec-${step.id}`,
    maxTokens: 8192,
  });

  writeFileSync(join(buildDir, `step-${step.id}-output.md`), llmOutput);

  const filesWritten = writeFilesFromOutput(llmOutput, projectDir);

  return {
    stepType: 'code_gen',
    llmOutput,
    filesWritten,
    outputSummary: `Generated ${filesWritten.length} file(s): ${filesWritten.map(f => f.relativePath).join(', ')}`,
  };
}

function pickModelFn(targetModel) {
  if (targetModel.includes('opus')) return expensive;
  if (targetModel.includes('sonnet')) return medium;
  return cheap;
}

/**
 * Topological sort using Kahn's algorithm. Stable: among nodes with
 * equal in-degree, preserves the original array order.
 */
function topologicalSort(steps) {
  const graph = new Map();
  const inDegree = new Map();

  for (const s of steps) {
    graph.set(s.id, []);
    inDegree.set(s.id, 0);
  }

  for (const s of steps) {
    for (const dep of (s.dependencies || [])) {
      if (graph.has(dep)) {
        graph.get(dep).push(s.id);
        inDegree.set(s.id, (inDegree.get(s.id) || 0) + 1);
      }
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const stepOrder = new Map(steps.map((s, i) => [s.id, i]));
  queue.sort((a, b) => (stepOrder.get(a) || 0) - (stepOrder.get(b) || 0));

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const neighbor of graph.get(current) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
        queue.sort((a, b) => (stepOrder.get(a) || 0) - (stepOrder.get(b) || 0));
      }
    }
  }

  if (sorted.length !== steps.length) {
    const missing = steps.filter(s => !sorted.includes(s.id)).map(s => s.id);
    log(`EXECUTOR: WARNING - circular dependency detected. Unreachable steps: ${missing.join(', ')}`);
    for (const id of missing) sorted.push(id);
  }

  return sorted;
}

/**
 * Take a snapshot of top-level directory entries in a dir (for retry cleanup).
 */
function snapshotDir(dir) {
  try {
    if (!existsSync(dir)) return new Set();
    return new Set(readdirSync(dir));
  } catch { return new Set(); }
}

/**
 * Remove directories that appeared after the snapshot (created by a failed attempt).
 */
function cleanupNewDirs(dir, snapshotBefore) {
  try {
    const current = readdirSync(dir);
    for (const entry of current) {
      if (!snapshotBefore.has(entry)) {
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
          log(`EXECUTOR: cleaning up directory from failed attempt: ${entry}`);
          rmSync(fullPath, { recursive: true, force: true });
        }
      }
    }
  } catch { /* ignore cleanup errors */ }
}

function summarizeExecution(state) {
  const counts = { completed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const s of Object.values(state)) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }
  return `Done. completed=${counts.completed} failed=${counts.failed} skipped=${counts.skipped} pending=${counts.pending}`;
}
