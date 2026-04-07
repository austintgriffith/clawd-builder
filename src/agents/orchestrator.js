import { cheap } from '../llm.js';
import { logDecision } from '../logger.js';

const SYSTEM = `You are an orchestrator for a LeftClaw Services builder bot. Your job is to analyze build jobs and determine the right approach.

You are the cheapest model in the pipeline. Your role:
1. Analyze job descriptions and client messages
2. Determine what kind of build this is (contract complexity, frontend needs, integrations)
3. Decide which skills are most relevant
4. Write focused prompts for the more expensive models (sonnet/opus)

Be concise. No fluff. Output structured decisions.`;

export async function analyzeJob(job, messages) {
  const clientMessages = messages
    .filter(m => m.type === 'client_message' || m.type === 'ai_response')
    .map(m => `[${m.type}] ${m.content}`)
    .join('\n\n');

  const prompt = `Analyze this LeftClaw Services build job and output a structured analysis.

## Job Data
- Job ID: ${job.id}
- Service Type: ${job.serviceTypeId} (6 = Build)
- Client: ${job.client}
- Status: ${job.status}
- Stage: ${job.currentStage || 'none'}

## Job Description
${job.description}

## Client Messages
${clientMessages || '(none)'}

## Required Output (JSON)
{
  "summary": "one-line summary of what to build",
  "contractComplexity": "simple|medium|complex",
  "contractCount": number,
  "frontendComplexity": "simple|medium|complex",
  "chain": "base|mainnet|etc",
  "relevantSkills": ["ethskills-ship", "ethskills-orchestration", ...],
  "keyRequirements": ["requirement1", "requirement2", ...],
  "clientPreferences": ["preference from chat", ...],
  "plannerContext": "condensed context string to pass to the smart planner — include ONLY what it needs to write the build plan"
}

Output ONLY valid JSON, no markdown fences.`;

  const result = await cheap(SYSTEM, prompt, { role: 'orchestrator', maxTokens: 2048 });

  let parsed;
  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    logDecision('orchestrator', 'parse_failed', 'Could not parse orchestrator response as JSON, using raw text');
    parsed = { raw: result, relevantSkills: ['ethskills-ship', 'ethskills-orchestration', 'ethskills-concepts'] };
  }

  logDecision('orchestrator', 'job_analyzed', parsed.summary || 'analysis complete');
  return parsed;
}
