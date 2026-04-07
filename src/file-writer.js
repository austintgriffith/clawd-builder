import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { log } from './logger.js';

const FILE_EXT_RE = /\.\w{1,10}$/;

/**
 * Parse LLM output containing file blocks and write them to projectDir.
 *
 * Handles all observed output formats from Sonnet/minimax:
 *
 *   Format A: === path/to/file === ... === END ===
 *   Format B: === FILEPATH === path/to/file ... === END ===
 *   Format C: === FILEPATH ===\npath/to/file\n===\n ... === END ===
 *   Format D: ```lang:path/to/file ... ```
 *   Format E: // File: path  or  ### path  above a ``` block
 */
export function writeFilesFromOutput(output, projectDir) {
  let written = extractAllFiles(output);

  const results = [];
  for (const { path: relativePath, content } of written) {
    const result = writeSingleFile(projectDir, relativePath, content);
    if (result) results.push(result);
  }

  if (results.length > 0) {
    log(`FILE-WRITER: wrote ${results.length} file(s) to ${projectDir}`);
    for (const f of results) {
      log(`  ${f.relativePath} (${f.size} bytes)`);
    }
  }

  return results;
}

/**
 * Core extraction: try each strategy in order, return first that finds files.
 */
function extractAllFiles(output) {
  let files;

  files = extractFormat_FencePathFence(output);
  if (files.length > 0) return files;

  files = extractFormat_FilepathMultiline(output);
  if (files.length > 0) return files;

  files = extractFormat_MarkdownWithPath(output);
  if (files.length > 0) return files;

  files = extractFormat_PathAboveCodeBlock(output);
  if (files.length > 0) return files;

  return [];
}

/**
 * Format A: === path/to/file.ext === ... === END ===
 * The path is inline between === fences on the same line.
 */
function extractFormat_FencePathFence(output) {
  const files = [];
  const re = /^===\s+([^\n]+?)\s+===\s*$([\s\S]*?)^===\s*END\s*===\s*$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (!isFilePath(rawPath)) continue;
    files.push({ path: rawPath, content: cleanContent(match[2]) });
  }
  return files;
}

/**
 * Formats B+C: FILEPATH marker with path on same or next line.
 *
 * B: === FILEPATH === path/to/file.ext
 *    (content)
 *    === END ===
 *
 * C: === FILEPATH ===
 *    path/to/file.ext
 *    ===
 *    (content)
 *    === END ===
 */
function extractFormat_FilepathMultiline(output) {
  const files = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for "=== FILEPATH ===" or "=== FILEPATH === path" or "=== FILE === path"
    const inlineMatch = line.match(/^===\s*(?:FILEPATH|FILE):?\s*===?\s*(.*)$/i);
    if (!inlineMatch) continue;

    let filePath = inlineMatch[1].trim();
    let contentStart = i + 1;

    // If path wasn't inline, look at the next line
    if (!filePath || !isFilePath(filePath)) {
      if (i + 1 < lines.length) {
        filePath = lines[i + 1].trim();
        contentStart = i + 2;
      }
    }

    if (!isFilePath(filePath)) continue;

    // Skip optional bare === separator line after the path
    if (contentStart < lines.length && /^===\s*$/.test(lines[contentStart].trim())) {
      contentStart++;
    }

    // Gather content until === END === or next === FILEPATH/FILE marker
    const contentLines = [];
    for (let j = contentStart; j < lines.length; j++) {
      const cl = lines[j].trim();
      if (/^===\s*END\s*===/.test(cl)) break;
      if (/^===\s*(?:FILEPATH|FILE)\b/i.test(cl)) break;
      contentLines.push(lines[j]);
    }

    const content = cleanContent(contentLines.join('\n'));
    if (content.length > 0) {
      files.push({ path: filePath, content });
    }
  }

  return files;
}

/**
 * Format D: ```lang:path/to/file.ext ... ```
 */
function extractFormat_MarkdownWithPath(output) {
  const files = [];
  const re = /```[\w]*:([^\n]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (!isFilePath(rawPath)) continue;
    files.push({ path: rawPath, content: cleanContent(match[2]) });
  }
  return files;
}

/**
 * Format E: File path in a heading, comment, or bold text above a code block.
 *
 *   ### packages/nextjs/components/Foo.tsx
 *   ```tsx
 *   (content)
 *   ```
 *
 *   **`packages/nextjs/components/Foo.tsx`**
 *   ```tsx
 *   (content)
 *   ```
 *
 *   // File: packages/nextjs/components/Foo.tsx
 *   ```tsx
 *   (content)
 *   ```
 */
function extractFormat_PathAboveCodeBlock(output) {
  const files = [];
  const re = /(?:^|\n)(?:#{1,4}\s+|(?:\/\/|#)\s*(?:File:?\s*)?|\*\*`?|`)([a-zA-Z][\w./\-]*\.\w{1,10})`?\*?\*?[^\n]*\n(?:[^\n]*\n){0,2}```\w*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (!isFilePath(rawPath)) continue;
    const content = cleanContent(match[2]);
    if (content.length > 10) {
      files.push({ path: rawPath, content });
    }
  }
  return files;
}

function isFilePath(str) {
  if (!str || str.length > 200) return false;
  if (str.includes('..')) return false;
  if (!FILE_EXT_RE.test(str)) return false;
  return str.includes('/') || /^\w[\w.\-]+$/.test(str);
}

/**
 * Strip leading/trailing whitespace and any stray === fence lines
 * that leaked into the content.
 */
function cleanContent(str) {
  return str
    .replace(/^\s*===\s*\n/, '')   // stray === at start
    .replace(/\n\s*===\s*$/, '')   // stray === at end
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function writeSingleFile(projectDir, relativePath, content) {
  try {
    if (relativePath.includes('..')) {
      log(`FILE-WRITER: skipping suspicious path: ${relativePath}`);
      return null;
    }
    const absPath = join(projectDir, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
    return {
      relativePath,
      absolutePath: absPath,
      size: Buffer.byteLength(content),
    };
  } catch (err) {
    log(`FILE-WRITER: error writing ${relativePath}: ${err.message}`);
    return null;
  }
}

/**
 * Write a single file from raw content when the path is known.
 */
export function writeSingleOutput(projectDir, relativePath, content) {
  return writeSingleFile(projectDir, relativePath, content);
}
