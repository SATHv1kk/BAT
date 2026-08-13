# BAT workspace folder

This is the suggested default location for BAT's **Workspace folder** (Settings ⚙ →
Workspace folder → Choose folder). Point the picker here once and BAT will save notes,
collected TSV/CSV files, and progress checkpoints from then on.

## Where the data goes

Collected output lands in the **`data/` subfolder** of this directory
(`workspace/data/`), never at the folder root:

```
workspace/
├── README.md          this file
├── log/               extension/runtime log files (gitignored)
└── data/              all agent output — TSV/CSV files, notes, checkpoints, …
```

That separation keeps this human-authored file apart from machine-generated data, so a
`git status` never surprises you with a huge `.tsv` diff.

## Why you still have to pick it once

Chrome's File System Access API deliberately does not let any extension or web page pick
a folder on disk for itself, silently or by path — the browser always requires you to
choose it yourself through the native OS picker, at least the first time. This is a
security boundary Chrome enforces, not something BAT's code can bypass or shortcut.

The good news: it really is one-time. Once you grant this folder, BAT stores the handle
in its own IndexedDB and re-requests permission silently on every later launch — you
won't see the picker again unless you revoke access or move the folder.

> **Embedded storage fallback.** Before a folder is ever pinned, BAT writes to embedded
> storage (IndexedDB inside the extension) so files work with zero setup. Once you pin
> this folder, writes go to `data/` on disk. If you ever see Settings report a folder is
> pinned but disconnected (Chrome drops the grant on restart/extension reload), press
> **Reconnect folder** — your data is safe either way.

## Everything in here except this file is gitignored

Anything BAT writes to this folder (`*.tsv`, `*.csv`, notes, etc.) is your collected data,
not project source — `.gitignore` excludes it so it can never end up committed to this
repository by an unrelated `git add -A`. This `README.md` is tracked on purpose. If you'd
rather keep your data somewhere outside the repo entirely, that's equally supported — this
folder is a convenience default, not a requirement.
