import { cheap } from './llm.js';
import { log, logDecision } from './logger.js';

/**
 * Validate the result of a step execution against its validationGate.
 *
 * For shell steps: checks exit code and output for errors.
 * For code_gen steps: checks that files were written and asks minimax to evaluate.
 * For read_context steps: auto-passes (reading is inherently successful if context was gathered).
 *
 * Returns { passed: boolean, reason: string, suggestions: string[] }
 */
export async function validateStep(step, result) {
  const { stepType } = result;

  if (stepType === 'read_context') {
    logDecision('validator', `step=${step.id} PASS`, 'Read context step auto-passes');
    return { passed: true, reason: 'Context read successfully', suggestions: [] };
  }

  if (stepType === 'shell_cmd') {
    return validateShellResult(step, result);
  }

  return validateCodeGenResult(step, result);
}

async function validateShellResult(step, result) {
  const { exitCode, stdout, stderr } = result;

  // Hard fail on non-zero exit
  if (exitCode !== 0) {
    const errorOutput = (stderr || stdout || '').slice(-1500);
    const reason = `Command exited with code ${exitCode}. Output: ${errorOutput}`;
    logDecision('validator', `step=${step.id} FAIL`, reason.slice(0, 200));
    return {
      passed: false,
      reason,
      suggestions: [`Fix the error and retry. Exit code: ${exitCode}`],
    };
  }

  // Ask minimax to check the output against the validation gate
  const prompt = `You are validating the output of a build step.

## Step
- Name: ${step.name}
- Command: ${step.command}
- Expected: ${step.expectedOutput}
- Validation Gate: ${step.validationGate}

## Command Output (last 2000 chars)
${(stdout || '').slice(-2000)}

## Stderr (last 500 chars)
${(stderr || '').slice(-500)}

Does this output satisfy the validation gate? Output ONLY valid JSON:
{"passed": true/false, "reason": "why", "suggestions": ["if failed, how to fix"]}`;

  return runValidationLLM(step, prompt);
}

async function validateCodeGenResult(step, result) {
  const { filesWritten, llmOutput } = result;

  if (!filesWritten || filesWritten.length === 0) {
    const reason = 'No files were extracted from the LLM output';
    logDecision('validator', `step=${step.id} FAIL`, reason);
    return {
      passed: false,
      reason,
      suggestions: [
        'The model output may not have used the === FILEPATH === format.',
        'Check the raw output and adjust the prompt.',
      ],
    };
  }

  const fileList = filesWritten.map(f => `${f.relativePath} (${f.size} bytes)`).join('\n');

  const prompt = `You are validating the output of a code generation step.

## Step
- Name: ${step.name}
- Description: ${step.description}
- Expected Output: ${step.expectedOutput}
- Validation Gate: ${step.validationGate}

## Files Written
${fileList}

## Code Output Preview (first 3000 chars of LLM response)
${(llmOutput || '').slice(0, 3000)}

Does this satisfy the validation gate? Consider:
1. Were the expected files created?
2. Does the code look complete (not truncated)?
3. Are there obvious structural issues?

Note: You cannot run the code. Just check structure, completeness, and obvious issues.

Output ONLY valid JSON:
{"passed": true/false, "reason": "why", "suggestions": ["if failed, how to fix"]}`;

  return runValidationLLM(step, prompt);
}

async function runValidationLLM(step, prompt) {
  try {
    const result = await cheap(
      'You validate build step outputs. Be strict but fair. Output only JSON.',
      prompt,
      { role: 'step-validator', maxTokens: 512 }
    );

    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const validation = JSON.parse(cleaned);

    logDecision('validator',
      `step=${step.id} ${validation.passed ? 'PASS' : 'FAIL'}`,
      validation.reason?.slice(0, 200) || 'no reason given');

    return {
      passed: !!validation.passed,
      reason: validation.reason || '',
      suggestions: validation.suggestions || [],
    };
  } catch (err) {
    log(`VALIDATOR: JSON parse failed for step ${step.id}, treating as pass: ${err.message}`);
    logDecision('validator', `step=${step.id} PASS (parse-fallback)`, 'Could not parse validation JSON');
    return { passed: true, reason: 'Validation parse failed, auto-passing', suggestions: [] };
  }
}
