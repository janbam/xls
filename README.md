# xls

`xls` prints a compact, truthful map of one or more directories. It is meant for
quick codebase orientation, filesystem inspection, and scriptable directory
summaries without the visual noise of common project clutter.

By default, `xls` shows directories first, files after, symlinks as stored,
executable files marked with `*asterisks*`, file sizes, text line counts,
modification dates, skipped clutter, and summary statistics.

## Installation

Run it directly from this checkout:

```sh
./bin/xls.js .
```

Or link it as a local package:

```sh
pnpm link --global .
xls .
```

## Usage

```sh
xls [options] <path...>
```

Examples:

```sh
xls .
xls --max-depth 2 src test
xls --all --max-items 1000 .
xls --files-only --no-dates .
xls --json --absolute .
```

Options:

| Option | Description |
| --- | --- |
| `-a`, `--all` | Include hidden and clutter directories such as `.git` and `node_modules`. |
| `--max-depth <n>` | Limit traversal to `n` path levels below each root. |
| `--max-items <n>` | Limit displayed entries per root. Default: `500`. |
| `--max-crawl <n>` | Limit examined entries per root. Default: `1000`. |
| `--dirs-only` | Show directories only. |
| `--files-only` | Show files only, with parent folders kept for context. |
| `--no-sizes` | Hide file sizes. |
| `--no-lines` | Skip text line counts. |
| `--no-dates` | Hide modification dates. |
| `--absolute` | Use absolute entry paths in JSON output. |
| `--json` | Print structured JSON instead of the rendered tree. |
| `-h`, `--help` | Show help. |
| `--version` | Show the version. |

## Defaults

`xls` hides common noisy directories by default, including hidden paths,
`node_modules`, `.git`, build outputs, coverage directories, Python virtual
environments, cache directories, and similar generated folders. Hidden and
clutter directories are still shown as `[SKIPPED]` so their presence is visible.

Use `--all` when you really want to traverse everything.

## License

MIT
