import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

let buildDir = null;
let traceEntries = [];

// Approximate pricing per 1M tokens (input / output) via Bankr Gateway.
// Bankr uses credit-based billing; these are estimates based on upstream provider rates.
const PRICING = {
  'minimax-m2.7':      { input: 0.10, output: 0.30 },
  'claude-sonnet-4.6': { input: 3.00, output: 15.00 },
  'claude-opus-4.6':   { input: 15.00, output: 75.00 },
  'claude-haiku-4.5':  { input: 0.80, output: 4.00 },
  'gemini-3-flash':    { input: 0.10, output: 0.40 },
  'gemini-2.5-flash':  { input: 0.10, output: 0.40 },
  'gpt-5-nano':        { input: 0.10, output: 0.40 },
  'gpt-5-mini':        { input: 0.40, output: 1.60 },
};

export function initLogger(dir) {
  buildDir = dir;
  traceEntries = [];
  writeFileSync(join(buildDir, 'build.log'), `=== Build started ${new Date().toISOString()} ===\n\n`);
  writeFileSync(join(buildDir, 'trace.json'), '[]');
}

export function log(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  if (buildDir) {
    appendFileSync(join(buildDir, 'build.log'), line);
  }
  console.log(line.trimEnd());
}

export function logLLM({ model, role, promptChars, responseChars, tokens, latencyMs }) {
  const entry = {
    type: 'llm_call',
    timestamp: new Date().toISOString(),
    model,
    role,
    promptChars,
    responseChars,
    tokens,
    latencyMs,
  };
  traceEntries.push(entry);

  log(`LLM [${model}] role=${role} prompt=${promptChars}ch response=${responseChars}ch tokens=${JSON.stringify(tokens)} ${latencyMs}ms`);

  if (buildDir) {
    writeFileSync(join(buildDir, 'trace.json'), JSON.stringify(traceEntries, null, 2));
  }
}

export function logStep(step, detail) {
  const entry = {
    type: 'step',
    timestamp: new Date().toISOString(),
    step,
    detail,
  };
  traceEntries.push(entry);

  log(`STEP [${step}] ${detail}`);

  if (buildDir) {
    writeFileSync(join(buildDir, 'trace.json'), JSON.stringify(traceEntries, null, 2));
  }
}

export function logDecision(agent, decision, reason) {
  const entry = {
    type: 'decision',
    timestamp: new Date().toISOString(),
    agent,
    decision,
    reason,
  };
  traceEntries.push(entry);

  log(`DECISION [${agent}] ${decision} — ${reason}`);

  if (buildDir) {
    writeFileSync(join(buildDir, 'trace.json'), JSON.stringify(traceEntries, null, 2));
  }
}

function estimateCost(model, promptTokens, completionTokens) {
  const rates = PRICING[model] || { input: 1.00, output: 5.00 };
  const inputCost = (promptTokens / 1_000_000) * rates.input;
  const outputCost = (completionTokens / 1_000_000) * rates.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

export function writeLLMAudit() {
  if (!buildDir) return;

  const llmCalls = traceEntries.filter(e => e.type === 'llm_call');
  if (llmCalls.length === 0) {
    writeFileSync(join(buildDir, 'llm-audit.md'), '# LLM Audit\n\nNo LLM calls were made.\n');
    return;
  }

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let totalLatency = 0;
  const byModel = {};

  const rows = llmCalls.map((call, i) => {
    const pt = call.tokens?.prompt || 0;
    const ct = call.tokens?.completion || 0;
    const tt = call.tokens?.total || (pt + ct);
    const cost = estimateCost(call.model, pt, ct);

    totalPromptTokens += pt;
    totalCompletionTokens += ct;
    totalTokens += tt;
    totalCost += cost.totalCost;
    totalLatency += call.latencyMs;

    if (!byModel[call.model]) {
      byModel[call.model] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latency: 0 };
    }
    byModel[call.model].calls++;
    byModel[call.model].promptTokens += pt;
    byModel[call.model].completionTokens += ct;
    byModel[call.model].totalTokens += tt;
    byModel[call.model].cost += cost.totalCost;
    byModel[call.model].latency += call.latencyMs;

    return `| ${i + 1} | ${call.role} | \`${call.model}\` | ${pt.toLocaleString()} | ${ct.toLocaleString()} | ${tt.toLocaleString()} | $${cost.totalCost.toFixed(4)} | ${(call.latencyMs / 1000).toFixed(1)}s |`;
  });

  const modelRows = Object.entries(byModel).map(([model, m]) => {
    return `| \`${model}\` | ${m.calls} | ${m.promptTokens.toLocaleString()} | ${m.completionTokens.toLocaleString()} | ${m.totalTokens.toLocaleString()} | $${m.cost.toFixed(4)} | ${(m.latency / 1000).toFixed(1)}s |`;
  });

  const md = `# LLM Audit

Generated: ${new Date().toISOString()}

## Summary

| Metric | Value |
|---|---|
| Total LLM calls | ${llmCalls.length} |
| Total prompt tokens | ${totalPromptTokens.toLocaleString()} |
| Total completion tokens | ${totalCompletionTokens.toLocaleString()} |
| Total tokens | ${totalTokens.toLocaleString()} |
| **Estimated total cost** | **$${totalCost.toFixed(4)}** |
| Total latency | ${(totalLatency / 1000).toFixed(1)}s |

## Cost by Model

| Model | Calls | Prompt Tokens | Completion Tokens | Total Tokens | Est. Cost | Latency |
|---|---|---|---|---|---|---|
${modelRows.join('\n')}

## Call-by-Call Detail

| # | Role | Model | Prompt Tokens | Completion Tokens | Total Tokens | Est. Cost | Latency |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Pricing Assumptions

Approximate per-1M-token rates used for cost estimates (via Bankr LLM Gateway):

| Model | Input $/1M | Output $/1M |
|---|---|---|
${Object.entries(PRICING).map(([m, r]) => `| \`${m}\` | $${r.input.toFixed(2)} | $${r.output.toFixed(2)} |`).join('\n')}

> These are estimates based on upstream provider rates. Actual Bankr credit costs may differ.
> Check your usage at [bankr.bot/llm](https://bankr.bot/llm).
`;

  writeFileSync(join(buildDir, 'llm-audit.md'), md);
  log(`LLM audit written to llm-audit.md (${llmCalls.length} calls, ~$${totalCost.toFixed(4)} est.)`);
}
