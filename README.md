# mend — one tool for every AI patch format

[![bounty on make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![current rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/heruruben-hub/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![prize pool](https://make.fun/badge/hidden-spec-cli-01-run-20261122/heruruben-hub/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

This repository is my entry to the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) (hidden-spec-cli-01-run-20261122).

AI models write down code changes in whatever format they happen to pick, and **mend** accepts every one of
them. Give it a unified diff, a SEARCH/REPLACE block, a V4A patch (`*** Begin Patch` … `*** End Patch`) or a
JSON list of edit objects: it recognises the format on its own, applies the edits to the file tree rooted at
the current directory, and reports what changed. The patch's own line numbers do not have to be right for the
target lines to be found — matching runs through three tiers of increasing looseness: exact first, then
ignoring trailing whitespace, then ignoring indentation too, with replacement lines re-indented to suit the
file at that loosest tier. And application is all-or-nothing: when any edit in the patch fails, no file is
touched, and every failure is reported with its reason.

One report row is printed for every file whose state changed — `A` for added, `D` for deleted, `M` for
modified, and `R <old> -> <new>` when an edit moved a file — followed by a summary line, `ok: n files`.

The contract mend implements is written down in [`SPEC.md`](SPEC.md).

## Running it

Node 22 or later is all you need. mend depends on nothing beyond the standard library, so there is nothing
to install.

```
node main.ts [options] [PATCH]
```

`PATCH` is the file the patch is read from; omit it (or pass `-`) and the patch comes from standard input
instead. The working directory is the root of the tree being patched.

Options:

- `--check` — print the report a real run would print, but write nothing.
- `--strict` — switch the looser matching tiers off; patch lines must match exactly.
- `--format=unified`, `--format=search-replace`, `--format=v4a` or `--format=json` — take the patch in
  that format instead of detecting it.

The exit code says how the run went: 0 when the whole patch applied, 1 when at least one edit failed (with
nothing written), and 2 for a usage error, an unreadable patch file, an undetectable format, or a patch
that does not parse.

## What's in the repo

- `main.ts` — mend itself, all of it.
- `runner.ts` — the trial runner supplied by the kit, unmodified; when a graded trial runs `main.ts`,
  control passes to it.
- `check.ts` — runs the kit's public practice set against `main.ts`:

  ```
  node check.ts <path-to-practice.json>
  ```

- `SPEC.md` — the specification mend is written to.
- `LICENSE` — MIT.

Built with an AI agent for make.fun — https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122
