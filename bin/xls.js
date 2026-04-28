#!/usr/bin/env node
import {
  readdirSync,
  statSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, join, relative, sep, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 500;
const MAX_FILES_CRAWL = 1000;
const TRUNCATED_MESSAGE = `This directory contains more than ${MAX_FILES} entries when explored recursively. ALL root-level entries are shown below, but subdirectories are not fully explored. Use xls on specific subdirectories to see their complete contents.\n\n`;
const ROOT_TRUNCATED_MESSAGE = `This directory has more than ${MAX_FILES} root-level entries, which exceeds the display limit. Showing only the first ${MAX_FILES} root-level entries below. Use xls on specific subdirectories to explore deeper content.\n\n`;

const HELP_TEXT = `Usage: xls [options] <path>

Professional directory exploration tool that shows a clean recursive tree with
file sizes, line counts for text files, symlink targets, executable markers,
modification dates, skipped clutter, and summary statistics.

Options:
  -a, --include-clutter   Include hidden and clutter directories such as .git and node_modules
      --json              Print structured JSON instead of the rendered tree
  -h, --help              Show this help text
      --version           Show the version
`;

const textExtensions = new Map([
  ['txt', true], ['text', true], ['md', true], ['markdown', true],
  ['json', true], ['json5', true], ['jsonml', true], ['xml', true], ['html', true], ['htm', true],
  ['js', true], ['mjs', true], ['ts', true], ['tsx', true], ['jsx', true],
  ['py', true], ['php', true], ['rb', true], ['pl', true], ['pm', true],
  ['sh', true], ['bash', true], ['c', true], ['cpp', true], ['cc', true], ['cxx', true],
  ['h', true], ['hpp', true], ['hh', true], ['java', true], ['rs', true], ['go', true],
  ['swift', true], ['kt', true], ['scala', true], ['lua', true],
  ['css', true], ['scss', true], ['sass', true], ['less', true], ['stylus', true], ['styl', true],
  ['shtml', true], ['jade', true], ['slim', true], ['slm', true],
  ['yaml', true], ['yml', true], ['toml', true], ['ini', true], ['conf', true], ['cfg', true],
  ['csv', true], ['tsv', true], ['sql', true], ['dockerfile', true], ['makefile', true],
  ['rst', true], ['asciidoc', true], ['adoc', true], ['tex', true], ['latex', true],
  ['rtf', true], ['rtx', true], ['vcard', true], ['ics', true], ['ifb', true],
  ['log', true], ['gitignore', true], ['gitattributes', true], ['editorconfig', true],
  ['npmignore', true], ['dockerignore', true], ['env', true], ['example', true],
  ['sample', true], ['template', true], ['spec', true], ['test', true],
]);

/**
 * Expand a leading home-directory marker without invoking a shell.
 * @param {string} path User-provided path.
 * @returns {string} Path with a leading `~` resolved to the current user's home directory.
 */
export function expandHomeDirectory(path) {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith(`~${sep}`)) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

/**
 * Pick a stable base directory for resolving relative paths.
 * @returns {string} Current working directory when available, otherwise the user's home directory.
 */
export function getResolutionBasePath() {
  try {
    return process.cwd();
  } catch {
    return homedir();
  }
}

/**
 * Resolve a path without shelling out, preserving relative-path semantics and symlink resolution.
 * @param {string} path Path to resolve.
 * @returns {string} Resolved absolute path.
 */
export function resolvePath(path) {
  try {
    // Normalize user input before choosing between absolute and cwd-relative resolution.
    const expandedPath = expandHomeDirectory(path);

    // Resolve against the live cwd when possible, with a home-directory fallback if cwd vanished.
    const absolutePath = isAbsolute(expandedPath)
      ? expandedPath
      : resolve(getResolutionBasePath(), expandedPath);

    // Canonicalize symlinks so CLI output matches the original tool's realpath behavior.
    return realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`Cannot resolve path: ${path} - ${error.message}`);
  }
}

/**
 * Decide whether a path should be displayed as present but intentionally not traversed.
 * @param {string} path Absolute or relative filesystem path.
 * @param {boolean} includeClutter Whether hidden and clutter paths should be traversed normally.
 * @returns {boolean} True when the entry should be marked `[SKIPPED]`.
 */
export function shouldShowAsSkipped(path, includeClutter = false) {
  if (includeClutter) {
    return false;
  }

  const pathName = basename(path);

  if (pathName.startsWith('.')) {
    return true;
  }

  return pathName === 'node_modules'
    || pathName === '.git'
    || pathName === 'dist'
    || pathName === 'build'
    || pathName === '.next'
    || pathName === '.nuxt'
    || pathName === 'coverage'
    || pathName === '.nyc_output'
    || pathName === '.venv'
    || pathName === 'venv'
    || pathName === '.env'
    || pathName === 'pyenvenv'
    || pathName === '.cache'
    || pathName === '.pytest_cache'
    || pathName === '.mypy_cache'
    || pathName === '.tox'
    || pathName === 'htmlcov'
    || pathName === 'target'
    || pathName === '.gradle'
    || pathName === 'pyenv'
    || pathName === '.idea';
}

/**
 * Decide whether a path should be omitted entirely from traversal.
 * @param {string} path Absolute or relative filesystem path.
 * @param {boolean} includeClutter Whether hidden and clutter paths should be traversed normally.
 * @returns {boolean} True when the entry should be omitted.
 */
export function skip(path, includeClutter = false) {
  if (path === '.') {
    return true;
  }

  if (includeClutter) {
    return false;
  }

  return path.includes(`__pycache__${sep}`);
}

/**
 * Recursively list directory entries using breadth-first traversal with display and crawl limits.
 * @param {string} initialPath Directory to list.
 * @param {string} basePath Directory used to produce relative result paths.
 * @param {boolean} includeClutter Whether hidden and clutter paths should be included.
 * @param {AbortSignal | undefined} abortSignal Optional signal for embedding callers.
 * @returns {{results: object[], fullStats: object, truncated: boolean, crawlHitLimit: boolean}} Listing data and aggregate crawl metadata.
 */
export function listDirectory(initialPath, basePath, includeClutter, abortSignal) {
  const results = [];
  const fullStats = {
    totalItems: 0,
    fileCount: 0,
    dirCount: 0,
    errorCount: 0,
    skippedCount: 0,
    maxDepth: 0,
  };
  let truncated = false;
  let crawlHitLimit = false;

  const queue = [initialPath];
  while (queue.length > 0) {
    if (abortSignal?.aborted) {
      return { results, fullStats, truncated, crawlHitLimit };
    }

    // Keep pathological trees bounded so the CLI remains responsive.
    if (fullStats.totalItems >= MAX_FILES_CRAWL) {
      crawlHitLimit = true;
      break;
    }

    const path = queue.shift();
    if (skip(path, includeClutter)) {
      continue;
    }

    if (path !== initialPath && shouldShowAsSkipped(path, includeClutter)) {
      continue;
    }

    let children;
    try {
      // Preserve the original tool's stable directory-first, alphabetical per-depth order.
      children = readdirSync(path, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      // Surface unreadable directories in-place instead of silently dropping them.
      recordDirectoryError(results, fullStats, basePath, path, error, () => {
        truncated = true;
      });
      continue;
    }

    for (const child of children) {
      if (fullStats.totalItems >= MAX_FILES_CRAWL) {
        crawlHitLimit = true;
        break;
      }

      const childPath = join(path, child.name);
      if (skip(childPath, includeClutter)) {
        continue;
      }

      if (child.isDirectory()) {
        // Show noisy directories as known-but-unexplored unless the caller asks for clutter.
        if (shouldShowAsSkipped(childPath, includeClutter)) {
          recordSkippedDirectory(results, fullStats, basePath, childPath, () => {
            truncated = true;
          });
          continue;
        }

        // Add traversable directories immediately so the rendered tree keeps sorted sibling order.
        recordDirectory(results, fullStats, basePath, childPath, () => {
          truncated = true;
        });
        queue.push(childPath);
        continue;
      }

      // Files and symlinks carry display metadata but are never traversed here.
      recordFile(results, fullStats, basePath, childPath, () => {
        truncated = true;
      });
    }

    if (crawlHitLimit) {
      break;
    }
  }

  return { results, fullStats, truncated, crawlHitLimit };
}

/**
 * Convert flat listing results into a printable directory tree.
 * @param {Array<object|string>} resultObjects Flat result objects or legacy string paths.
 * @returns {object[]} Root tree nodes.
 */
export function createFileTree(resultObjects) {
  const root = [];

  for (const resultObj of resultObjects) {
    const path = typeof resultObj === 'string' ? resultObj : resultObj.path;
    const isSymlink = typeof resultObj === 'string' ? false : resultObj.isSymlink;
    const symlinkTarget = typeof resultObj === 'string' ? null : resultObj.symlinkTarget;
    const isDirectory = typeof resultObj === 'string' ? path.endsWith(sep) : resultObj.isDirectory;
    const isExecutable = typeof resultObj === 'string' ? false : resultObj.isExecutable;
    const isSkipped = typeof resultObj === 'string' ? false : resultObj.isSkipped;
    const isError = typeof resultObj === 'string' ? false : resultObj.isError;
    const errorMessage = typeof resultObj === 'string' ? null : resultObj.errorMessage;
    const fileSize = typeof resultObj === 'string' ? null : resultObj.fileSize;
    const lineCount = typeof resultObj === 'string' ? null : resultObj.lineCount;
    const modificationTime = typeof resultObj === 'string' ? null : resultObj.modificationTime;

    // Walk path components, creating missing ancestors as directory nodes.
    const parts = path.split(sep).filter((part) => part !== '');
    let currentLevel = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}${sep}${part}` : part;
      const isLastPart = i === parts.length - 1;
      const existingNode = currentLevel.find((node) => node.name === part);

      if (existingNode) {
        // Merge final metadata into an ancestor placeholder created by an earlier child path.
        if (isLastPart) {
          existingNode.isSkipped = isSkipped;
          existingNode.isError = isError;
          existingNode.errorMessage = errorMessage;
          existingNode.modificationTime = modificationTime;
        }
        currentLevel = existingNode.children || [];
        continue;
      }

      const newNode = {
        name: part,
        path: currentPath,
        type: isLastPart && !isDirectory ? 'file' : 'directory',
        isSymlink: isLastPart ? isSymlink : false,
        symlinkTarget: isLastPart ? symlinkTarget : null,
        isExecutable: isLastPart ? isExecutable : false,
        isSkipped: isLastPart ? isSkipped : false,
        isError: isLastPart ? isError : false,
        errorMessage: isLastPart ? errorMessage : null,
        fileSize: isLastPart ? fileSize : null,
        lineCount: isLastPart ? lineCount : null,
        modificationTime: isLastPart ? modificationTime : null,
      };

      if (!isLastPart || isDirectory) {
        newNode.children = [];
      }

      currentLevel.push(newNode);
      currentLevel = newNode.children || [];
    }
  }

  return root;
}

/**
 * Render a directory tree using box-drawing characters and per-node metadata.
 * @param {object[]} tree Tree nodes from createFileTree.
 * @param {number} level Current recursion depth.
 * @param {string} prefix Prefix inherited from parent branches.
 * @param {string} rootPath Absolute root path shown in the heading.
 * @returns {string} Human-readable tree output.
 */
export function printTree(tree, level = 0, prefix = '', rootPath = '') {
  let result = '';

  if (level === 0) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    result += `Showing contents of: ${rootPath}\nModification dates shown in [YYYY/MM/DD - HH:MM:SS] format (${timeZone} timezone)\n\n`;
    prefix = '';
  }

  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    const isLast = i === tree.length - 1;
    let displayName = node.name;

    // Build the visible node label from structural and permission metadata.
    if (node.type === 'directory') {
      displayName += sep;
    }

    if (node.isSkipped) {
      displayName += ' [SKIPPED]';
    } else if (node.isError && node.errorMessage) {
      displayName += ` [ERROR: ${node.errorMessage}]`;
    } else if (node.type === 'file' && node.isExecutable) {
      displayName = `*${displayName}*`;
    }

    // Attach compact file metadata only when the entry was actually inspected.
    let fileSizeInfo = '';
    if (!node.isSkipped && !node.isError && node.type === 'file' && node.fileSize !== null) {
      const sizeStr = formatFileSize(node.fileSize);
      fileSizeInfo = node.lineCount !== null
        ? `\t(${sizeStr} / ${node.lineCount} lines)`
        : `\t(${sizeStr})`;
    }

    // Preserve raw symlink targets so users see the link exactly as stored.
    let symlinkInfo = '';
    if (!node.isSkipped && !node.isError && node.isSymlink && node.symlinkTarget) {
      symlinkInfo = ` -> ${node.symlinkTarget}`;
    } else if (!node.isSkipped && !node.isError && node.isSymlink) {
      symlinkInfo = ' -> ';
    }

    // Keep timestamps visually aligned for quick scanning in terminal output.
    let modificationDateInfo = '';
    if (!node.isSkipped && !node.isError && node.modificationTime) {
      const formattedDate = formatModificationDate(node.modificationTime);
      if (formattedDate) {
        modificationDateInfo = node.type === 'directory'
          ? `\t\t${formattedDate}`
          : `\t${formattedDate}`;
      }
    }

    const treeSymbol = isLast ? '└── ' : '├── ';
    result += `${prefix}${treeSymbol}${displayName}${fileSizeInfo}${symlinkInfo}${modificationDateInfo}\n`;

    // Recurse only into nodes that were traversed successfully.
    if (!node.isSkipped && !node.isError && node.children?.length > 0) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      result += printTree(node.children, level + 1, childPrefix, rootPath);
    }
  }

  return result;
}

/**
 * Check if a file is likely a text file based on its name or extension.
 * @param {string} filePath Path to the file.
 * @returns {boolean} True if file appears to be text.
 */
export function isTextFile(filePath) {
  if (typeof filePath !== 'string') {
    return false;
  }

  const fileName = filePath.replace(/^.*[/\\]/s, '').toLowerCase();
  const specialTextFiles = [
    'readme',
    'license',
    'changelog',
    'makefile',
    'dockerfile',
    'gemfile',
    'rakefile',
    'vagrantfile',
  ];

  if (specialTextFiles.includes(fileName)) {
    return true;
  }

  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1) {
    return false;
  }

  return textExtensions.has(fileName.slice(lastDot + 1));
}

/**
 * Format file size in human-readable binary units.
 * @param {number} bytes File size in bytes.
 * @returns {string} Human-readable size such as `1.5KB`.
 */
export function formatFileSize(bytes) {
  if (bytes === 0) {
    return '0B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))}${units[i]}`;
}

/**
 * Format modification date in `[YYYY/MM/DD - HH:MM:SS]` local-time format.
 * @param {Date|number|string} modificationTime Modification time accepted by Date.
 * @returns {string} Formatted date, or an empty string if invalid.
 */
export function formatModificationDate(modificationTime) {
  try {
    const date = modificationTime instanceof Date ? modificationTime : new Date(modificationTime);

    if (Number.isNaN(date.getTime())) {
      return '';
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `[${year}/${month}/${day} - ${hours}:${minutes}:${seconds}]`;
  } catch {
    return '';
  }
}

/**
 * Count lines in a text file.
 * @param {string} filePath Path to the file.
 * @returns {number|null} Number of lines, or null when the file cannot be read as text.
 */
export function countFileLines(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');

    // Match common editor semantics: empty files have 0 lines, unterminated text has 1 line.
    if (content.length === 0) {
      return 0;
    }

    const lines = content.split('\n').length;
    return content.endsWith('\n') ? lines - 1 : lines;
  } catch {
    return null;
  }
}

/**
 * Calculate statistics from listing results for validation and display.
 * @param {Array<object|string>} resultObjects Flat listing result objects.
 * @returns {{totalItems: number, fileCount: number, dirCount: number, errorCount: number, skippedCount: number, maxDepth: number, accessibleItems: number}} Summary counts.
 */
export function calculateStatistics(resultObjects) {
  let totalItems = 0;
  let fileCount = 0;
  let dirCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let maxDepth = 0;

  for (const resultObj of resultObjects) {
    totalItems++;

    // Keep support for the original string-result shape while emitting object results in the CLI.
    const isDirectory = typeof resultObj === 'string' ? resultObj.endsWith(sep) : resultObj.isDirectory;
    const isError = typeof resultObj === 'string' ? false : resultObj.isError;
    const isSkipped = typeof resultObj === 'string' ? false : resultObj.isSkipped;
    const path = typeof resultObj === 'string' ? resultObj : resultObj.path;

    if (isError) {
      errorCount++;
    } else if (isSkipped) {
      skippedCount++;
    } else if (isDirectory) {
      dirCount++;
    } else {
      fileCount++;
    }

    const pathDepth = path.split(sep).filter((part) => part !== '').length;
    maxDepth = Math.max(maxDepth, pathDepth);
  }

  return {
    totalItems,
    fileCount,
    dirCount,
    errorCount,
    skippedCount,
    maxDepth,
    accessibleItems: totalItems - errorCount - skippedCount,
  };
}

/**
 * List a directory and prepare both structured and rendered output.
 * @param {{path: string, includeClutter?: boolean, abortSignal?: AbortSignal}} options Listing options.
 * @returns {object} Complete listing payload for CLI rendering or JSON output.
 */
export function inspectDirectory({ path, includeClutter = false, abortSignal } = {}) {
  if (!path) {
    throw new CliError('Missing required path argument.', 2);
  }

  const fullFilePath = resolvePath(path);
  const stats = statSync(fullFilePath);
  if (!stats.isDirectory()) {
    throw new CliError(`Path is not a directory: ${fullFilePath}`, 1);
  }

  const listResult = listDirectory(fullFilePath, fullFilePath, includeClutter, abortSignal);
  let result = listResult.results;

  // When display truncates, retain all root-level entries where possible.
  let isRootLevelTruncation = false;
  if (listResult.truncated) {
    const rootLevelItems = result.filter((item) => item.depth === 1);
    isRootLevelTruncation = rootLevelItems.length === MAX_FILES;
    result = rootLevelItems;
  }

  const displayedStats = calculateStatistics(result);
  const tree = printTree(createFileTree(result), 0, '', fullFilePath);
  const crawlLimitNote = listResult.crawlHitLimit ? ` (crawl stopped at ${MAX_FILES_CRAWL} items)` : '';
  let statsMessage;

  if (listResult.truncated) {
    const foundStats = listResult.fullStats;
    statsMessage = `\nCrawled: ${foundStats.totalItems} total items (${foundStats.fileCount} files, ${foundStats.dirCount} directories, ${foundStats.errorCount} errors, ${foundStats.skippedCount} skipped) | Max depth: ${foundStats.maxDepth}\nDisplayed: ${displayedStats.totalItems} total items (${displayedStats.fileCount} files, ${displayedStats.dirCount} directories, ${displayedStats.errorCount} errors, ${displayedStats.skippedCount} skipped) | Max depth: ${displayedStats.maxDepth}`;
  } else {
    statsMessage = `\nStatistics: ${displayedStats.totalItems} total items (${displayedStats.fileCount} files, ${displayedStats.dirCount} directories, ${displayedStats.errorCount} errors, ${displayedStats.skippedCount} skipped) | Max depth: ${displayedStats.maxDepth} | Accessible: ${displayedStats.accessibleItems}${crawlLimitNote}`;
  }

  const rendered = listResult.truncated
    ? `${isRootLevelTruncation ? ROOT_TRUNCATED_MESSAGE : TRUNCATED_MESSAGE}${tree}${isRootLevelTruncation ? '[TRUNCATED!]\n' : ''}${statsMessage}`
    : tree + statsMessage;

  return {
    path: fullFilePath,
    includeClutter,
    truncated: listResult.truncated,
    isRootLevelTruncation,
    crawlHitLimit: listResult.crawlHitLimit,
    result,
    statistics: displayedStats,
    fullStatistics: listResult.fullStats,
    rendered,
  };
}

/**
 * Parse command-line arguments for the standalone CLI.
 * @param {string[]} argv Process argument vector without node and script.
 * @returns {{path: string | undefined, includeClutter: boolean, json: boolean, help: boolean, version: boolean}} Parsed options.
 */
export function parseArgs(argv) {
  const parsed = {
    path: undefined,
    includeClutter: false,
    json: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    // Support a conventional option terminator so paths beginning with dashes remain usable.
    if (arg === '--') {
      const rest = argv.slice(index + 1);
      if (rest.length > 1) {
        throw new CliError(`Unexpected extra arguments: ${rest.slice(1).join(' ')}`, 2);
      }
      parsed.path = rest[0] ?? parsed.path;
      break;
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (arg === '--version') {
      parsed.version = true;
      continue;
    }

    if (arg === '-a' || arg === '--include-clutter') {
      parsed.includeClutter = true;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new CliError(`Unknown option: ${arg}`, 2);
    }

    if (parsed.path !== undefined) {
      throw new CliError(`Unexpected extra argument: ${arg}`, 2);
    }

    parsed.path = arg;
  }

  return parsed;
}

/**
 * Run the CLI and return a process exit code.
 * @param {string[]} argv Process argument vector without node and script.
 * @param {{stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream}} io Output streams.
 * @returns {number} Exit code.
 */
export function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArgs(argv);

    if (options.help) {
      io.stdout.write(HELP_TEXT);
      return 0;
    }

    if (options.version) {
      io.stdout.write('xls 0.1.0\n');
      return 0;
    }

    const output = inspectDirectory({
      path: options.path,
      includeClutter: options.includeClutter,
    });

    if (options.json) {
      io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }

    io.stdout.write(`${output.rendered}\n`);
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    io.stderr.write(`xls: ${error.message}\n`);
    return exitCode;
  }
}

/**
 * Error type carrying the intended CLI exit code.
 */
class CliError extends Error {
  /**
   * @param {string} message Human-readable error message.
   * @param {number} exitCode Process exit code.
   */
  constructor(message, exitCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * Record a traversable directory in result and aggregate statistics.
 * @param {object[]} results Mutable display result list.
 * @param {object} fullStats Mutable aggregate statistics.
 * @param {string} basePath Root path used for relative display paths.
 * @param {string} childPath Directory path to record.
 * @param {Function} onTruncated Callback invoked once the display limit is exceeded.
 */
function recordDirectory(results, fullStats, basePath, childPath, onTruncated) {
  fullStats.totalItems++;
  fullStats.dirCount++;

  const pathDepth = depthFromBase(basePath, childPath);
  fullStats.maxDepth = Math.max(fullStats.maxDepth, pathDepth);

  let modificationTime = null;
  try {
    modificationTime = lstatSync(childPath).mtime;
  } catch {
    // Missing stat data should not hide the directory itself.
  }

  pushResult(results, {
    path: `${relative(basePath, childPath)}${sep}`,
    isSymlink: false,
    symlinkTarget: null,
    isDirectory: true,
    isExecutable: false,
    isSkipped: false,
    depth: pathDepth,
    fileSize: null,
    lineCount: null,
    modificationTime,
  }, onTruncated);
}

/**
 * Record a skipped directory in result and aggregate statistics.
 * @param {object[]} results Mutable display result list.
 * @param {object} fullStats Mutable aggregate statistics.
 * @param {string} basePath Root path used for relative display paths.
 * @param {string} childPath Directory path to record.
 * @param {Function} onTruncated Callback invoked once the display limit is exceeded.
 */
function recordSkippedDirectory(results, fullStats, basePath, childPath, onTruncated) {
  fullStats.totalItems++;
  fullStats.skippedCount++;

  const pathDepth = depthFromBase(basePath, childPath);
  fullStats.maxDepth = Math.max(fullStats.maxDepth, pathDepth);

  let modificationTime = null;
  try {
    modificationTime = lstatSync(childPath).mtime;
  } catch {
    // Skipped directories can still be represented without timestamp metadata.
  }

  pushResult(results, {
    path: `${relative(basePath, childPath)}${sep}`,
    isSymlink: false,
    symlinkTarget: null,
    isDirectory: true,
    isExecutable: false,
    isSkipped: true,
    depth: pathDepth,
    fileSize: null,
    lineCount: null,
    modificationTime,
  }, onTruncated);
}

/**
 * Record an unreadable directory in result and aggregate statistics.
 * @param {object[]} results Mutable display result list.
 * @param {object} fullStats Mutable aggregate statistics.
 * @param {string} basePath Root path used for relative display paths.
 * @param {string} path Directory path that failed.
 * @param {Error & {code?: string}} error Read error.
 * @param {Function} onTruncated Callback invoked once the display limit is exceeded.
 */
function recordDirectoryError(results, fullStats, basePath, path, error, onTruncated) {
  const errorPath = relative(basePath, path);
  fullStats.totalItems++;
  fullStats.errorCount++;

  const pathDepth = errorPath.split(sep).filter((part) => part !== '').length;
  fullStats.maxDepth = Math.max(fullStats.maxDepth, pathDepth);

  const normalizedPath = errorPath + (errorPath.endsWith(sep) ? '' : sep);
  const existingEntry = results.find((entry) => entry.path === normalizedPath);
  if (existingEntry) {
    existingEntry.isError = true;
    existingEntry.errorMessage = error.code || error.message;
    return;
  }

  pushResult(results, {
    path: normalizedPath,
    isSymlink: false,
    symlinkTarget: null,
    isDirectory: true,
    isExecutable: false,
    isSkipped: false,
    isError: true,
    errorMessage: error.code || error.message,
    depth: pathDepth,
    fileSize: null,
    lineCount: null,
    modificationTime: null,
  }, onTruncated);
}

/**
 * Record a file or symlink in result and aggregate statistics.
 * @param {object[]} results Mutable display result list.
 * @param {object} fullStats Mutable aggregate statistics.
 * @param {string} basePath Root path used for relative display paths.
 * @param {string} childPath File path to record.
 * @param {Function} onTruncated Callback invoked once the display limit is exceeded.
 */
function recordFile(results, fullStats, basePath, childPath, onTruncated) {
  let isSymlink = false;
  let symlinkTarget = null;
  let isDirectory = false;
  let isExecutable = false;
  let fileSize = null;
  let lineCount = null;
  let modificationTime = null;

  try {
    // Use lstat first so symlink metadata and raw targets are preserved.
    const lstat = lstatSync(childPath);
    isSymlink = lstat.isSymbolicLink();
    fileSize = lstat.size;

    if (isSymlink) {
      try {
        symlinkTarget = readlinkSync(childPath);
        try {
          modificationTime = statSync(childPath).mtime;
        } catch {
          modificationTime = lstat.mtime;
        }
      } catch {
        symlinkTarget = '?';
        modificationTime = lstat.mtime;
      }
    } else {
      isDirectory = lstat.isDirectory();
      modificationTime = lstat.mtime;

      if (!isDirectory) {
        isExecutable = Boolean(lstat.mode & 0o111);
        if (isTextFile(childPath)) {
          lineCount = countFileLines(childPath);
        }
      }
    }
  } catch {
    // Preserve original behavior: stat failures still render as plain file-like entries.
  }

  fullStats.totalItems++;
  if (isDirectory) {
    fullStats.dirCount++;
  } else {
    fullStats.fileCount++;
  }

  const pathDepth = depthFromBase(basePath, childPath);
  fullStats.maxDepth = Math.max(fullStats.maxDepth, pathDepth);

  pushResult(results, {
    path: relative(basePath, childPath),
    isSymlink,
    symlinkTarget,
    isDirectory,
    isExecutable,
    isSkipped: false,
    depth: pathDepth,
    fileSize,
    lineCount,
    modificationTime,
  }, onTruncated);
}

/**
 * Append a display result while enforcing the visible output cap.
 * @param {object[]} results Mutable result list.
 * @param {object} entry Entry to append.
 * @param {Function} onTruncated Callback invoked once the display limit is exceeded.
 */
function pushResult(results, entry, onTruncated) {
  if (results.length < MAX_FILES) {
    results.push(entry);
    return;
  }

  onTruncated();
}

/**
 * Calculate relative path depth from the listed root.
 * @param {string} basePath Root path used for relative display paths.
 * @param {string} childPath Child path being recorded.
 * @returns {number} Number of relative path components.
 */
function depthFromBase(basePath, childPath) {
  return relative(basePath, childPath).split(sep).filter((part) => part !== '').length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
