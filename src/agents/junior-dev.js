import { cheap } from '../llm.js';
import { logDecision } from '../logger.js';

export async function generateBoilerplate(task, context) {
  const result = await cheap(
    'You are a junior developer. Write clean, simple code. Follow the patterns and conventions given to you exactly. No unnecessary complexity.',
    `${task}\n\n## Context\n${context}`,
    { role: 'junior-dev', maxTokens: 4096 }
  );

  logDecision('junior-dev', 'code_generated', task.slice(0, 80));
  return result;
}

export async function scaffoldFiles(fileList, projectContext) {
  const prompt = `Generate the file contents for each of these files. Follow the project conventions exactly.

## Files to create
${fileList}

## Project Context
${projectContext}

For each file, output:
=== FILEPATH ===
(file contents)
=== END ===`;

  const result = await cheap(
    'You are a junior developer. Generate clean boilerplate files. Follow conventions exactly.',
    prompt,
    { role: 'junior-dev', maxTokens: 8192 }
  );

  logDecision('junior-dev', 'files_scaffolded', `Scaffolded files`);
  return result;
}
