import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { cheap, medium } from './llm.js';
import { log, logStepExecution } from './logger.js';
import { writeFilesFromOutput, writeSingleOutput } from './file-writer.js';

/**
 * Parse a compiler/runtime error, identify the broken file(s),
 * call an LLM to fix them, and write the fixes to disk.
 *
 * Returns an array of { path, error, fixed } or null if nothing could be fixed.
 */
export async function fixCodeFromError(errorOutput, projectDir, step, context) {
  const errors = parseErrors(errorOutput);
  if (errors.length === 0) {
    log(`FIXER: could not parse any file-level errors from output`);
    return null;
  }

  log(`FIXER: found ${errors.length} error(s) in ${[...new Set(errors.map(e => e.file))].join(', ')}`);

  // Group errors by file
  const byFile = new Map();
  for (const err of errors) {
    if (!byFile.has(err.file)) byFile.set(err.file, []);
    byFile.get(err.file).push(err);
  }

  const fixes = [];

  for (const [relPath, fileErrors] of byFile) {
    // Resolve path: try as-is first, then under common subdirs (forge reports relative to packages/foundry/)
    const resolvedPath = resolveProjectPath(relPath, projectDir);
    if (!resolvedPath) {
      log(`FIXER: file not found: ${relPath}, skipping`);
      continue;
    }
    const absPath = join(projectDir, resolvedPath);

    const brokenCode = readFileSync(absPath, 'utf-8');
    const errorSummary = fileErrors
      .map(e => `Line ${e.line}: ${e.message}`)
      .join('\n');

    // Gather related files for context (e.g., if test imports contract, include it)
    const relatedContext = gatherRelatedFiles(brokenCode, relPath, projectDir);

    const isSolidity = resolvedPath.endsWith('.sol');
    const isTestFailure = fileErrors.some(e => e.type === 'test_failure');
    const callFn = isSolidity ? medium : cheap;
    const modelLabel = isSolidity ? 'sonnet (solidity fix)' : 'cheap (fix)';

    const systemPrompt = isTestFailure
      ? `You are a test fixer. Tests are failing because they make incorrect assumptions about the contract. The CONTRACT is correct — fix the TESTS to match the contract's actual behavior. Return ONLY the corrected test file contents. No explanations, no markdown fences.`
      : `You are a code fixer. You receive a file with compiler errors and must return ONLY the corrected file contents. No explanations, no markdown fences, no === markers. Output the raw file contents and nothing else.`;

    log(`FIXER: fixing ${resolvedPath} (${fileErrors.length} ${isTestFailure ? 'test failures' : 'errors'}) with ${modelLabel}`);

    try {
      const fixedCode = await callFn(
        systemPrompt,
        `## File: ${resolvedPath}
## ${isTestFailure ? 'Test Failures' : 'Errors'}
${errorSummary}

## Full Error Output
${errorOutput.slice(0, 4000)}

## Current File Contents
${brokenCode}

${relatedContext}

Fix ALL the ${isTestFailure ? 'failing tests' : 'errors'} listed above. ${isTestFailure ? 'The contract is correct — fix the test expectations to match actual behavior.' : ''} Return ONLY the corrected file contents. Do not wrap in code fences or markers.`,
        { role: `fixer-${basename(relPath)}`, maxTokens: 8192 }
      );

      // Strip any accidental fences the model might add
      const cleaned = fixedCode
        .replace(/^```\w*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();

      writeSingleOutput(projectDir, resolvedPath, cleaned);
      fixes.push({ path: resolvedPath, errors: fileErrors.length, fixed: true });
      log(`FIXER: wrote fixed ${resolvedPath} (${Buffer.byteLength(cleaned)} bytes)`);
    } catch (err) {
      log(`FIXER: failed to fix ${resolvedPath}: ${err.message}`);
      fixes.push({ path: resolvedPath, errors: fileErrors.length, fixed: false });
    }
  }

  return fixes.length > 0 ? fixes : null;
}

/**
 * Parse compiler errors from stderr/stdout output.
 * Handles Solidity (forge) and TypeScript error formats.
 */
function parseErrors(output) {
  const errors = [];

  // Solidity: Error (CODE): message\n --> file:line:col:
  const solRe = /Error\s*\(\d+\):\s*(.+)\n\s*-->\s*([^:]+):(\d+):\d+/g;
  let match;
  while ((match = solRe.exec(output)) !== null) {
    errors.push({
      message: match[1].trim(),
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'solidity',
    });
  }

  // Also catch "Error:" without code
  const solRe2 = /Error:\s*(.+)\n\s*-->\s*([^:]+):(\d+):\d+/g;
  while ((match = solRe2.exec(output)) !== null) {
    const msg = match[1].trim();
    if (msg === 'Compiler run failed:') continue;
    errors.push({
      message: msg,
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'solidity',
    });
  }

  // TypeScript: error TS2304: message\n  file(line,col)
  const tsRe = /error\s+TS\d+:\s*(.+)\n\s*(\S+)\((\d+),\d+\)/g;
  while ((match = tsRe.exec(output)) !== null) {
    errors.push({
      message: match[1].trim(),
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'typescript',
    });
  }

  // Next.js / generic: Error: message in file:line
  const genericRe = /Error:\s*(.+?)\s+in\s+(\S+):(\d+)/g;
  while ((match = genericRe.exec(output)) !== null) {
    errors.push({
      message: match[1].trim(),
      file: match[2].trim(),
      line: parseInt(match[3], 10),
      type: 'generic',
    });
  }

  // Forge test failures — use the "Failing tests:" section which attributes each failure to its file:
  //   "Encountered N failing test in test/BurnBoard.t.sol:BurnBoardTest"
  //   "[FAIL: reason] test_name()"
  const failingSectionRe = /failing tests? in ([^:]+):\w+\s*\n([\s\S]*?)(?=\n\n|Encountered a total)/g;
  while ((match = failingSectionRe.exec(output)) !== null) {
    const file = match[1].trim();
    const block = match[2];
    const failRe2 = /\[FAIL[:\s]*([^\]]*)\]\s*(\w+)\(\)/g;
    let fmatch;
    while ((fmatch = failRe2.exec(block)) !== null) {
      errors.push({
        message: `Test ${fmatch[2]}() failed: ${fmatch[1].trim()}`,
        file,
        line: 0,
        type: 'test_failure',
      });
    }
  }

  return deduplicateErrors(errors);
}

/**
 * Resolve a file path from an error message to its actual location in the project.
 * Forge reports paths relative to packages/foundry/, TypeScript relative to packages/nextjs/.
 */
function resolveProjectPath(errorPath, projectDir) {
  const candidates = [
    errorPath,
    `packages/foundry/${errorPath}`,
    `packages/nextjs/${errorPath}`,
    `packages/foundry/src/${errorPath}`,
    `packages/nextjs/src/${errorPath}`,
  ];

  for (const candidate of candidates) {
    if (existsSync(join(projectDir, candidate))) {
      return candidate;
    }
  }
  return null;
}

function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter(e => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * If the broken file imports other project files, read them for context.
 * Helps the fixer understand the interfaces the code is supposed to use.
 */
function gatherRelatedFiles(brokenCode, brokenPath, projectDir) {
  const parts = [];

  // Solidity: import "./Contract.sol" or import "../contracts/Contract.sol"
  const solImports = [...brokenCode.matchAll(/import\s+["']([^"']+)["']/g)];
  for (const m of solImports) {
    const importPath = m[1];
    // Resolve relative to the broken file's directory
    const resolved = join(dirname(brokenPath), importPath);
    const absPath = join(projectDir, resolved);
    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath, 'utf-8');
        parts.push(`## Related: ${resolved}\n${content.slice(0, 4000)}`);
      } catch { /* skip */ }
    }
  }

  // TypeScript/JS: import from "~~/something" or from "./something"
  const tsImports = [...brokenCode.matchAll(/from\s+["'](~~\/|\.\.?\/)[^"']+["']/g)];
  for (const m of tsImports) {
    const raw = m[0].match(/["']([^"']+)["']/)?.[1];
    if (!raw) continue;
    const resolved = raw.replace('~~/', '');
    const candidates = [resolved, resolved + '.tsx', resolved + '.ts', resolved + '/index.tsx'];
    for (const c of candidates) {
      const absPath = join(projectDir, c);
      if (existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, 'utf-8');
          parts.push(`## Related: ${c}\n${content.slice(0, 3000)}`);
        } catch { /* skip */ }
        break;
      }
    }
  }

  return parts.length > 0
    ? `\n## Related Files (for interface reference)\n${parts.join('\n\n')}`
    : '';
}
