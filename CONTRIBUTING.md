# Contributing to BAT

## Getting set up

```bash
npm install
npm run check    # lint + offline tests + build — run this before every commit
```

`npm run check` is exactly what CI runs. If it passes locally it passes there.

## Invariants

These are the properties the codebase is built around. Breaking one is usually a bug even
when the tests still pass, so each has a note on *why*.

### The store is the authority; the file is a projection

Collected rows live in IndexedDB (`lib/state-store.js`). The TSV/CSV file is a rendering
of the store, written append-only. Deduplication happens **before** any write, because an
append-only text file cannot merge duplicates after the fact.

Consequences: never report a total from the model's memory — read it back with
`data_report` / `getCounts`. Never treat a failed file write as data loss; the rows are
safe and `export_rows` reconciles.

### The allowlist fails closed

An empty allowlist permits **nothing** that changes a page or runs code. If you add a tool
that clicks, types, injects, or evaluates, add it to `SITE_GUARDED_TOOLS` in
`sidepanel/app.js`. Non-`http(s)` schemes are refused unconditionally.

This was once the other way round (empty = allow everything). Please don't reintroduce a
convenience default that turns the boundary off.

### An extractor is a pure, synchronous DOM reader

Model-authored extractor source is screened by `lib/extractor-screen.js` before it runs or
is cached. If you widen what extractors may do, widen the screen deliberately and add
assertions to `test/extractor-screen.test.mjs` — do not remove the check because a
legitimate extractor tripped it. The correct fix for a false positive is a narrower rule,
not no rule.

### Nothing sensitive leaves the browser

`lib/redaction.js` is the single policy. Any new path that uploads page content to a model
must run through `redactMarkup` first. The content script carries a mirrored copy because
it cannot import ESM; `test/redaction.test.mjs` asserts the mirror has not drifted, so
update both sides together.

### IndexedDB: one transaction per read-modify-write

Do a `get`, mutate, and `put` in the **same** transaction, and `await` its `oncomplete`
(`txDone`) — not just the last request. Two transactions means two concurrent callers can
both read the old value and the second write wins. Do not `await` anything unrelated
between requests inside a transaction; it will auto-commit under you.

When batching genuinely needs two phases (`addRows` in `state-store.js` reads N point
lookups in one transaction, computes in memory, then writes in a second — issuing N gets
one at a time in a single read-modify-write transaction would `await` between requests and
auto-commit under you), the two-transaction split is unavoidable, and the fallback is to
serialize same-process callers around it instead: a per-key lock (`withCollectionLock` /
`withFileLock`), same idea in both `state-store.js` and `workspace.js`. Know its limit —
it only serializes callers in the SAME script context. The side panel and the background
service worker each load their own instance of a module with their own lock, so it does not
stop a panel call and a worker call racing on the same key from different contexts. Closing
that fully needs the read and write folded into one transaction (`recordNotFound` shows the
pattern) — don't attempt that blind; verify it against a live extension, since getting IDB
transaction lifetime wrong (auto-commit mid-`await`) is worse than the race it would fix.

### Budgets are phase-aware

`background/runner.js` gives navigation+extraction one budget and extractor synthesis
(a model call) a much larger one, via a re-armable deadline. If you add a phase whose
honest cost differs by an order of magnitude, re-arm rather than inherit — a single flat
timer is what once made synthesis impossible to complete.

A timed-out phase does not stop `processPage` — it only makes `Promise.race` return early;
the abandoned call keeps running in the background against a tab the loop has already
moved on to navigating elsewhere. The `stop()` checkpoints exist to bail out of THAT
call before it mutates shared state on a page it no longer belongs to. Every write to
`Store.putExtractor` — cache a fresh extractor, retire or halt a stale one — needs a
`stop()` immediately before it, same as the row-write path already had. Synthesis is the
one deliberate exception: its commit is intentionally NOT gated the same way, so a slow
model call still banks the (expensive, already-validated) result instead of throwing it
away — see the comment at its call site before "fixing" that one.

### Errors get breadcrumbs

An empty `catch {}` is occasionally right (a cosmetic overlay failing on `chrome://`), but
the default is `debugEntry('what_failed', { … })`. "Copy debug log" is this project's
entire support story; an error that reaches nobody costs a user an unexplainable failure.

## Layout

`sidepanel/app.js` is still the largest file: it holds the chat UI, the agent loop, and
tool dispatch. Cohesive pieces have been pulled out (`prompt.js`, `tool-defs.js`,
`deepseek.js`) and more should follow — the course/SCORM heuristics are the obvious next
candidate. Prefer extracting a module with an explicit dependency object (see `apiCtx`)
over reaching for module-level mutable state, which is what made the old code
un-extractable.

Pure logic belongs in `src/lib/` and must be importable by `node` with no browser globals,
so it can be tested. That is why `plan.js`, `extractors.js`, `allowlist.js`,
`site-verification.js` and the pure core of `output-writer.js` look the way they do.

## Tests

```bash
npm test           # offline, deterministic — gates CI
npm run test:live  # live ATS endpoints only
npm run test:all
```

The runner is `test/run-tests.mjs`. Per-module suites export a single function:

```js
// test/my-thing.test.mjs
export default function run(t) {
  t('what it should do', actual === expected);
}
```

Register the filename in the module loop in `run-tests.mjs`. Do not print totals or call
`process.exit` from a module — the runner owns that.

**Keep the offline suite offline.** The live section is separate precisely so a
third-party endpoint change cannot make an unrelated PR red. Anything requiring the
network, a real folder, or a real site goes in `test:live` or in README's manual
verification section.

Write the assertion name as the claim being made (`'empty allowlist DENIES'`), not as the
function being called. When you fix a bug, add the assertion that would have caught it and
say so in a comment — several tests here exist because the behaviour was once wrong.

## Adding a tool

1. Schema in `sidepanel/tool-defs.js`. Descriptions are prompt text: say when to use it
   and what *not* to do with it.
2. Handler in `runTool` in `sidepanel/app.js`.
3. If it changes a page or runs code → `SITE_GUARDED_TOOLS`.
4. If it can run without a live tab → add it to the `allowDeadTab` list.
5. If it takes a page action → add it to `PAGE_ACTION_TOOLS` so only the last one in a
   batch pays for a snapshot.

## Adding a site

Add the template to `src/shared/site-configs.js` with `verified: false` and a `note`
saying what you know. Do **not** hand-edit it to `verified: true` — verification is
per-installation empirical state and belongs in storage, via
`run_control {action:"verify"}` then `mark_verified`. Otherwise the next `git pull`
silently discards what someone learned.

## Commits

Conventional prefixes (`fix:`, `feat:`, `docs:`, `test:`, `refactor:`, `chore:`) with the
subsystem in parentheses where it helps: `fix(runner): …`.

Explain *why* in the body when the change is not obvious. The comment density in this
codebase is deliberate: comments say why, not what. Please match it.
