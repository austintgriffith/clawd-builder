import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { log } from './logger.js';

const FILE_EXT_RE = /\.\w{1,10}$/;

/**
 * Parse LLM output containing file blocks and write them to projectDir.
 *
 * Handles several output formats Sonnet/minimax produce:
 *   === packages/foundry/contracts/Foo.sol ===
 *   (contents)
 *   === END ===
 *
 *   === FILEPATH === packages/foundry/contracts/Foo.sol
 *   (contents)
 *   === END ===
 *
 *   ```solidity:packages/foundry/contracts/Foo.sol
 *   (contents)
 *   ```
 *
 *   // File: packages/foundry/contracts/Foo.sol
 *   ```solidity
 *   (contents)
 *   ```
 */
export function writeFilesFromOutput(output, projectDir) {
  let written = [];

  // Strategy 1: === path/to/file === ... === END ===
  written = tryFormat_FencePathFence(output, projectDir);

  // Strategy 2: === FILEPATH === path/to/file ... === END ===
  if (written.length === 0) {
    written = tryFormat_FilepathMarker(output, projectDir);
  }

  // Strategy 3: ```lang:path/to/file ... ```
  if (written.length === 0) {
    written = tryFormat_MarkdownWithPath(output, projectDir);
  }

  // Strategy 4: // File: path ... ```lang ... ```
  if (written.length === 0) {
    written = tryFormat_CommentThenCodeBlock(output, projectDir);
  }

  if (written.length > 0) {
    log(`FILE-WRITER: wrote ${written.length} file(s) to ${projectDir}`);
    for (const f of written) {
      log(`  ${f.relativePath} (${f.size} bytes)`);
    }
  }

  return written;
}

// === path/to/file.ext === ... === END ===
function tryFormat_FencePathFence(output, projectDir) {
  const written = [];
  const re = /^===\s+([^\n]+?)\s+===\s*$([\s\S]*?)^===\s*END\s*===\s*$/gm;
  let match;
  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (!isFilePath(rawPath)) continue;
    const content = trimContent(match[2]);
    const result = writeSingleFile(projectDir, rawPath, content);
    if (result) written.push(result);
  }
  return written;
}

// === FILEPATH === path/to/file.ext  (or === FILE === path, === FILE: path ===)
// content until next === marker or end
function tryFormat_FilepathMarker(output, projectDir) {
  const written = [];
  const re = /^===\s*(?:FILEPATH|FILE):?\s*===?\s*(.+?)\s*$/gm;
  const markers = [];
  let match;

  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (isFilePath(rawPath)) {
      markers.push({ path: rawPath, endIndex: match.index + match[0].length });
    }
  }

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].endIndex;
    let end;

    // Content runs until next === marker, next FILEPATH marker, or === END ===
    const rest = output.slice(start);
    const endMatch = rest.match(/^===\s*(END|FILEPATH|FILE)\b/m);
    if (endMatch) {
      end = start + endMatch.index;
    } else if (i + 1 < markers.length) {
      // Find the start of the next marker line
      const nextMarkerLine = output.lastIndexOf('\n', markers[i + 1].endIndex - markers[i + 1].path.length - 20);
      end = nextMarkerLine > start ? nextMarkerLine : markers[i + 1].endIndex;
    } else {
      end = output.length;
    }

    const content = trimContent(output.slice(start, end));
    if (content.length > 0) {
      const result = writeSingleFile(projectDir, markers[i].path, content);
      if (result) written.push(result);
    }
  }

  return written;
}

// ```lang:path/to/file.ext ... ```
function tryFormat_MarkdownWithPath(output, projectDir) {
  const written = [];
  const re = /```[\w]*:([^\n]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (!isFilePath(rawPath)) continue;
    const content = trimContent(match[2]);
    const result = writeSingleFile(projectDir, rawPath, content);
    if (result) written.push(result);
  }
  return written;
}

// Looks for patterns like:
//   **`path/to/file.ext`** or // File: path/to/file.ext or ### path/to/file.ext
// followed by a ```lang ... ``` block
function tryFormat_CommentThenCodeBlock(output, projectDir) {
  const written = [];
  // Match a filepath reference followed (within ~3 lines) by a code block
  const re = /(?:(?:^|\n)(?:#{1,4}\s+|(?:\/\/|#)\s*(?:File:?\s*)?|\*\*`?|`))([a-zA-Z][\w./\-]*\.\w{1,10})`?\*?\*?[^\n]*\n(?:[^\n]*\n){0,3}```\w*\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const rawPath = match[1].trim();
    if (!isFilePath(rawPath)) continue;
    const content = trimContent(match[2]);
    if (content.length > 10) {
      const result = writeSingleFile(projectDir, rawPath, content);
      if (result) written.push(result);
    }
  }
  return written;
}

function isFilePath(str) {
  if (!str || str.length > 200) return false;
  if (str.includes('..')) return false;
  // Must contain a file extension
  if (!FILE_EXT_RE.test(str)) return false;
  // Must look like a path (has / or is a simple filename)
  return str.includes('/') || /^\w[\w.\-]+$/.test(str);
}

function trimContent(str) {
  return str.replace(/^\n+/, '').replace(/\n+$/, '');
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
