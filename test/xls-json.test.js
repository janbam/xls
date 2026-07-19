import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { runCli } from '../bin/xls.js';

/**
 * Run the CLI against in-memory output streams so tests verify the public boundary.
 * @param {string[]} args CLI arguments.
 * @returns {{code: number, stdout: string, stderr: string}} Captured CLI result.
 */
function runXls(args) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });

  return { code, stdout, stderr };
}

/**
 * Create a deterministic tree that exercises files, text line counts, and hidden summaries.
 * @returns {string} Temporary fixture root.
 */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'xls-json-'));
  const src = join(root, 'src');
  const nodeModules = join(root, 'node_modules');
  const packageDir = join(nodeModules, 'pkg');

  // Build a compact tree whose hidden summary has both file and directory counts.
  mkdirSync(src);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(src, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'z.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(nodeModules, 'cache.bin'), '12345');
  writeFileSync(join(packageDir, 'index.js'), 'x\n');

  // Pin mtimes after writes so JSON date fields stay deterministic across runs.
  const fixedTime = new Date('2026-07-03T10:00:00.000Z');
  for (const path of [
    join(src, 'a.txt'),
    join(root, 'z.bin'),
    join(nodeModules, 'cache.bin'),
    join(packageDir, 'index.js'),
    packageDir,
    src,
    nodeModules,
    root,
  ]) {
    utimesSync(path, fixedTime, fixedTime);
  }

  return root;
}

/**
 * Create a root whose only visible child is a hidden directory with a capped summary.
 * @returns {string} Temporary fixture root.
 */
function createHiddenOnlyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'xls-hidden-json-'));
  const nodeModules = join(root, 'node_modules');

  // Keep root traversal complete while forcing the hidden summary to hit its crawl cap.
  mkdirSync(nodeModules);
  writeFileSync(join(nodeModules, 'a.js'), 'a\n');
  writeFileSync(join(nodeModules, 'b.js'), 'b\n');
  writeFileSync(join(nodeModules, 'c.js'), 'c\n');

  const fixedTime = new Date('2026-07-03T10:00:00.000Z');
  for (const path of [
    join(nodeModules, 'a.js'),
    join(nodeModules, 'b.js'),
    join(nodeModules, 'c.js'),
    nodeModules,
    root,
  ]) {
    utimesSync(path, fixedTime, fixedTime);
  }

  return root;
}

/**
 * Create a root where display truncation happens below a root-level directory.
 * @returns {string} Temporary fixture root.
 */
function createNestedTruncationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'xls-nested-truncation-'));
  const crowded = join(root, 'a');
  const sibling = join(root, 'b');

  // Keep root-level entries below the cap while descendants exceed it.
  mkdirSync(crowded);
  mkdirSync(sibling);
  writeFileSync(join(crowded, 'one.txt'), 'one\n');
  writeFileSync(join(crowded, 'two.txt'), 'two\n');
  writeFileSync(join(crowded, 'three.txt'), 'three\n');

  const fixedTime = new Date('2026-07-03T10:00:00.000Z');
  for (const path of [
    join(crowded, 'one.txt'),
    join(crowded, 'two.txt'),
    join(crowded, 'three.txt'),
    crowded,
    sibling,
    root,
  ]) {
    utimesSync(path, fixedTime, fixedTime);
  }

  return root;
}

/**
 * Replace the intentionally time-varying generated field while preserving the rest of the payload.
 * @param {string} stdout CLI stdout containing one JSON document.
 * @returns {object} Parsed JSON with generated masked.
 */
function parseMaskedJson(stdout) {
  const parsed = JSON.parse(stdout);
  parsed.generated = '<generated>';
  return parsed;
}

test('prints xls/1 JSON for a deterministic fixture', () => {
  const root = createFixture();
  try {
    const result = runXls(['--json', root]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(parseMaskedJson(result.stdout), {
      schema: 'xls/1',
      root,
      generated: '<generated>',
      entries: [
        {
          path: 'node_modules',
          type: 'dir',
          summarized: true,
          files: 2,
          dirs: 1,
          bytes: 7,
          mtime: '2026-07-03',
        },
        {
          path: 'src',
          type: 'dir',
          mtime: '2026-07-03',
        },
        {
          path: 'src/a.txt',
          type: 'file',
          bytes: 8,
          lines: 2,
          mtime: '2026-07-03',
        },
        {
          path: 'z.bin',
          type: 'file',
          bytes: 3,
          mtime: '2026-07-03',
        },
      ],
      stats: {
        files: 2,
        dirs: 1,
        hidden: 1,
        maxDepth: 2,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('is deterministic modulo generated timestamp', () => {
  const root = createFixture();
  try {
    const first = runXls(['--json', root]);
    const second = runXls(['--json', root]);

    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.deepEqual(parseMaskedJson(first.stdout), parseMaskedJson(second.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('omits JSON mtimes when date collection is disabled', () => {
  const root = createFixture();
  try {
    const result = runXls(['--json', '--no-dates', root]);
    const output = parseMaskedJson(result.stdout);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    for (const entry of output.entries) {
      assert.equal(Object.hasOwn(entry, 'mtime'), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports depth-limited directories as skipped JSON entries', () => {
  const root = createFixture();
  try {
    const result = runXls(['--json', '--max-depth', '1', root]);
    const output = parseMaskedJson(result.stdout);
    const src = output.entries.find((entry) => entry.path === 'src');

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(src, {
      path: 'src',
      type: 'dir',
      mtime: '2026-07-03',
      error: 'skipped',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports incomplete hidden summaries on the summarized JSON entry', () => {
  const root = createHiddenOnlyFixture();
  try {
    const result = runXls(['--json', '--max-crawl', '2', root]);
    const output = parseMaskedJson(result.stdout);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(output.entries, [
      {
        path: 'node_modules',
        type: 'dir',
        summarized: true,
        files: 2,
        dirs: 0,
        bytes: 4,
        mtime: '2026-07-03',
        error: 'incomplete',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects JSON when root-level entries are omitted by the display cap', () => {
  const root = createFixture();
  try {
    const result = runXls(['--json', '--max-items', '1', root]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /cannot represent display-limit omissions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects JSON when nested entries are omitted by the display cap', () => {
  const root = createNestedTruncationFixture();
  try {
    const result = runXls(['--json', '--max-items', '4', root]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /cannot represent display-limit omissions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects JSON when crawl limits omit unknown entries', () => {
  const root = createFixture();
  try {
    const result = runXls(['--json', '--max-crawl', '2', root]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /cannot represent crawl-limit omissions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects absolute JSON paths because xls/1 requires relative entry paths', () => {
  const root = createFixture();
  try {
    const result = runXls(['--json', '--absolute', root]);

    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--absolute cannot be combined with --json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('documents embeddable output constraints in help output', () => {
  const result = runXls(['--help']);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /--json\s+Print one xls\/1 JSON document for exactly one root path/);
  assert.match(result.stdout, /--tree-only\s+Print only the relative descendant tree for exactly one root path/);
  assert.match(result.stdout, /--absolute\s+Compatibility flag; cannot be combined with --json or --tree-only/);
});

test('prints only the normal descendant tree with one trailing newline', () => {
  const root = createFixture();
  try {
    const result = runXls(['--tree-only', '--no-dates', root]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `├── node_modules/ [HIDDEN]\t(7B / 2 files / 1 dirs)
├── src/
│   └── a.txt\t(8B, 2L)
└── z.bin\t(3B)
`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves nested connectors and ordering in tree-only output', () => {
  const root = createNestedTruncationFixture();
  try {
    const result = runXls(['--tree-only', '--no-dates', root]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `├── a/
│   ├── one.txt\t(4B, 1L)
│   ├── three.txt\t(6B, 1L)
│   └── two.txt\t(4B, 1L)
└── b/
`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prints nothing for an empty tree-only directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'xls-empty-tree-'));
  try {
    const result = runXls(['--tree-only', root]);

    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('omits every human report wrapper while retaining hidden and skipped markers', () => {
  const root = createFixture();
  try {
    const result = runXls(['--tree-only', '--no-dates', '--max-depth', '1', root]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /node_modules\/ \[HIDDEN\]/);
    assert.match(result.stdout, /src\/ \[SKIPPED\]/);
    assert.doesNotMatch(result.stdout, /Showing contents of:|Modification dates shown/);
    assert.equal(result.stdout.includes(`${basename(root)}/`), false);
    assert.doesNotMatch(result.stdout, /Statistics:|Crawled:|Displayed:/);
    assert.doesNotMatch(result.stdout, /🚨|TRUNCATED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires exactly one path in tree-only mode', () => {
  for (const args of [
    ['--tree-only'],
    ['--tree-only', '/first', '/second'],
  ]) {
    const result = runXls(args);

    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--tree-only requires exactly one path/);
  }
});

test('rejects incompatible tree-only output options', () => {
  for (const option of ['--json', '--absolute']) {
    const result = runXls(['--tree-only', option, '.']);

    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`--tree-only cannot be combined with ${option}`));
  }
});

test('rejects tree-only output before stdout when display limits omit entries', () => {
  const root = createNestedTruncationFixture();
  try {
    const result = runXls(['--tree-only', '--max-items', '4', root]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--tree-only cannot represent display-limit omissions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects tree-only output before stdout when crawl limits omit entries', () => {
  const root = createFixture();
  try {
    const result = runXls(['--tree-only', '--max-crawl', '2', root]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--tree-only cannot represent crawl-limit omissions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps human-readable output unchanged when JSON mode is absent', () => {
  const root = createFixture();
  try {
    const result = runXls(['--no-dates', root]);
    const rootName = basename(root);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `Showing contents of: ${root}

${rootName}/
├── node_modules/ [HIDDEN]\t(7B / 2 files / 1 dirs)
├── src/
│   └── a.txt\t(8B, 2L)
└── z.bin\t(3B)

Statistics: 4 total items (2 files, 1 directories, 0 errors, 1 hidden, 0 skipped) | Max depth: 2 | Accessible: 3
`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prints only the JSON schema in schema mode', () => {
  const result = runXls(['--show-json-schema', '/definitely/not/used']);
  const schema = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(schema.$id, 'xls/1');
  assert.equal(schema.properties.schema.const, 'xls/1');
  assert.equal(schema.additionalProperties, false);
});
