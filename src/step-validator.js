import { log, logDecision } from './logger.js';

/**
 * Validate step results. Simple and deterministic -- no LLM calls.
 *
 * The compiler/runtime is the real validator:
 * - Shell: exit 0 = pass, exit != 0 = fail
 * - Code gen: files written = pass, no files = fail
 * - Read context: always pass
 *
 * Returns { passed: boolean, reason: string, suggestions: string[] }
 */
export async function validateStep(step, result) {
  const { stepType } = result;

  if (stepType === 'read_context') {
    logDecision('validator', `step=${step.id} PASS`, 'Read context auto-pass');
    return { passed: true, reason: 'Context read successfully', suggestions: [] };
  }

  if (stepType === 'shell_cmd') {
    return validateShellResult(step, result);
  }

  return validateCodeGenResult(step, result);
}

function validateShellResult(step, result) {
  const { exitCode, stdout, stderr } = result;

  if (exitCode === 0) {
    logDecision('validator', `step=${step.id} PASS`, 'Exit code 0');
    return { passed: true, reason: 'Command completed successfully', suggestions: [] };
  }

  const errorOutput = (stderr || stdout || '').slice(-2000);
  const reason = `Exit code ${exitCode}: ${errorOutput.slice(0, 300)}`;
  logDecision('validator', `step=${step.id} FAIL`, reason.slice(0, 200));
  return {
    passed: false,
    reason,
    suggestions: [],
  };
}

function validateCodeGenResult(step, result) {
  const { filesWritten } = result;

  if (filesWritten && filesWritten.length > 0) {
    const fileList = filesWritten.map(f => f.relativePath).join(', ');
    logDecision('validator', `step=${step.id} PASS`, `${filesWritten.length} file(s): ${fileList.slice(0, 150)}`);
    return {
      passed: true,
      reason: `Wrote ${filesWritten.length} file(s)`,
      suggestions: [],
    };
  }

  logDecision('validator', `step=${step.id} FAIL`, 'No files extracted from LLM output');
  return {
    passed: false,
    reason: 'No files were extracted from the LLM output',
    suggestions: ['Model may not have used the === FILEPATH === format'],
  };
}
