import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { cheap } from './llm.js';
import { buildSkillContext } from './skills.js';
import { log, logDecision } from './logger.js';

const MODEL_MAP = {
  cheap: 'minimax-m2.7',
  medium: 'claude-sonnet-4.6',
  expensive: 'claude-opus-4.6',
};

/**
 * Gather context files from the project directory that match the step's contextNeeded list.
 * Returns an object mapping relative paths to their contents (truncated if huge).
 */
function gatherFileContext(projectDir, contextNeeded) {
  const gathered = {};
  if (!contextNeeded || !existsSync(projectDir)) return gathered;

  for (const needed of contextNeeded) {
    const fullPath = join(projectDir, needed);
    if (!existsSync(fullPath)) continue;

    const stat = statSync(fullPath);
    if (stat.isFile()) {
      const content = readFileSync(fullPath, 'utf-8');
      gathered[needed] = content.length > 8000
        ? content.slice(0, 8000) + '\n\n[... truncated at 8000 chars]'
        : content;
    } else if (stat.isDirectory()) {
      // List files in directory for orientation, read small ones
      try {
        const files = readdirSync(fullPath, { recursive: true })
          .filter(f => {
            const fp = join(fullPath, f);
            return existsSync(fp) && statSync(fp).isFile();
          })
          .slice(0, 20);
        gathered[needed + '/'] = `Directory listing:\n${files.join('\n')}`;
        for (const f of files.slice(0, 5)) {
          const fp = join(fullPath, f);
          const content = readFileSync(fp, 'utf-8');
          const relPath = relative(projectDir, fp);
          gathered[relPath] = content.length > 4000
            ? content.slice(0, 4000) + '\n\n[... truncated]'
            : content;
        }
      } catch { /* skip unreadable dirs */ }
    }
  }
  return gathered;
}

/**
 * Build a summary of completed dependency steps -- what they produced and where.
 */
function buildDependencyContext(step, completedSteps) {
  const parts = [];
  for (const depId of (step.dependencies || [])) {
    const dep = completedSteps[depId];
    if (!dep) continue;
    parts.push(`## Completed: ${dep.name} (${depId})
Output summary: ${dep.outputSummary || 'completed successfully'}
Files written: ${(dep.filesWritten || []).map(f => f.relativePath).join(', ') || 'none'}`);
  }
  return parts.join('\n\n');
}

/**
 * Classify a step into one of the three execution types.
 */
export function classifyStep(step) {
  if (step.command) return 'shell_cmd';
  const nameLower = (step.name || '').toLowerCase();
  const descLower = (step.description || '').toLowerCase();
  if (nameLower.includes('read') || descLower.startsWith('read ')) return 'read_context';
  return 'code_gen';
}

/**
 * Use minimax to prepare a focused prompt for the target model.
 *
 * Returns { systemPrompt, userPrompt, targetModel, stepType }
 */
export async function assembleContext(step, {
  projectDir,
  buildDir,
  completedSteps,
  skills,
  plan,
  analysis,
  previousAttemptFeedback,
}) {
  const stepType = classifyStep(step);
  const targetModel = MODEL_MAP[step.model] || MODEL_MAP.medium;

  const fileContext = gatherFileContext(projectDir, step.contextNeeded);
  const depContext = buildDependencyContext(step, completedSteps);

  const skillKeys = [];
  if (step.description?.toLowerCase().includes('contract') || step.stage === 'contract_audit') {
    skillKeys.push('ethskills-security', 'ethskills-standards');
  }
  if (step.description?.toLowerCase().includes('frontend') || step.description?.toLowerCase().includes('component')) {
    skillKeys.push('ethskills-frontend-ux', 'ethskills-frontend-playbook');
  }
  skillKeys.push('scaffold-eth-agents');
  const skillContext = skills ? buildSkillContext(skills, skillKeys, 3000) : '';

  const retrySection = previousAttemptFeedback
    ? `\n## PREVIOUS ATTEMPT FAILED\nFeedback: ${previousAttemptFeedback}\nFix the issues described above.\n`
    : '';

  // For read_context steps, no LLM prompt needed -- just return the gathered context
  if (stepType === 'read_context') {
    const summary = Object.entries(fileContext)
      .map(([path, content]) => `### ${path}\n${content}`)
      .join('\n\n');
    return {
      systemPrompt: null,
      userPrompt: null,
      targetModel,
      stepType,
      gatheredContext: summary || '(no files found yet -- project may not be scaffolded)',
    };
  }

  // For shell_cmd steps, no model prompt needed -- just run the command
  if (stepType === 'shell_cmd') {
    return {
      systemPrompt: null,
      userPrompt: null,
      targetModel,
      stepType,
      command: step.command,
    };
  }

  // For code_gen: minimax assembles a focused prompt for the target model
  const fileContextStr = Object.entries(fileContext).length > 0
    ? Object.entries(fileContext)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n')
    : '(project not yet scaffolded or files not yet created)';

  const metaPrompt = `You are a prompt engineer. Your job is to write a focused, efficient prompt for ${targetModel} to complete a specific build step.

## Step to Execute
- ID: ${step.id}
- Name: ${step.name}
- Phase: ${step.phase}
- Description: ${step.description}
- Expected Output: ${step.expectedOutput}
- Validation Gate: ${step.validationGate}
${retrySection}

## Available Context (files in the project so far)
${fileContextStr}

## Dependency Step Outputs
${depContext || '(none)'}

## Relevant Skills/Conventions
${skillContext || '(none loaded)'}

## Plan Excerpt
${extractPlanSection(plan, step)}

## YOUR TASK

Write TWO things:

1. A SYSTEM PROMPT (1-3 sentences) that tells the target model its role and constraints.
2. A USER PROMPT that includes ONLY the context the model needs to complete this step. Be specific about:
   - Exactly what file(s) to produce (with full paths)
   - The exact format: wrap each file in === path/to/file === ... === END ===
   - Any code conventions or patterns to follow
   - What NOT to do (common mistakes)

Keep the prompts as short as possible while being complete. Every token costs money on ${targetModel}.

Output format:
=== SYSTEM_PROMPT ===
(system prompt here)
=== END_SYSTEM ===

=== USER_PROMPT ===
(user prompt here)
=== END_USER ===`;

  const result = await cheap(
    'You are a prompt engineer. Write tight, focused prompts. No filler.',
    metaPrompt,
    { role: 'context-assembler', maxTokens: 3000 }
  );

  const systemPrompt = extractBlock(result, 'SYSTEM_PROMPT', 'END_SYSTEM')
    || `You are a senior developer building a Scaffold-ETH 2 dApp. Follow SE2 conventions exactly. Output files in === path === ... === END === format.`;

  const userPrompt = extractBlock(result, 'USER_PROMPT', 'END_USER')
    || result; // fallback: use the whole response as the user prompt

  logDecision('context-assembler', 'prompt_prepared',
    `Step ${step.id} "${step.name}" → ${targetModel} (system=${systemPrompt.length}ch, user=${userPrompt.length}ch)`);

  return { systemPrompt, userPrompt, targetModel, stepType };
}

function extractBlock(text, startMarker, endMarker) {
  const startRe = new RegExp(`===\\s*${startMarker}\\s*===\\s*\\n?`);
  const endRe = new RegExp(`\\n?===\\s*${endMarker}\\s*===`);
  const startMatch = startRe.exec(text);
  if (!startMatch) return null;
  const after = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = endRe.exec(after);
  if (!endMatch) return after.trim();
  return after.slice(0, endMatch.index).trim();
}

function extractPlanSection(plan, step) {
  if (!plan) return '(no plan available)';
  const lines = plan.split('\n');
  const relevant = [];
  let capturing = false;
  const phaseName = `Phase ${step.phase}`;
  const stepNameLower = step.name.toLowerCase();

  for (const line of lines) {
    if (line.includes(phaseName) || line.toLowerCase().includes(stepNameLower)) {
      capturing = true;
    }
    if (capturing) {
      relevant.push(line);
      if (relevant.length > 40) break;
      if (relevant.length > 5 && line.startsWith('###') && !line.includes(phaseName) && !line.toLowerCase().includes(stepNameLower)) {
        break;
      }
    }
  }
  return relevant.length > 0
    ? relevant.join('\n').slice(0, 2000)
    : plan.slice(0, 1500) + '\n[... see full plan]';
}
