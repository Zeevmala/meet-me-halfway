# Project brain

What this project has learned, kept next to its code.

- `DECISIONS.md`: project decisions, dated, append-only.
- `lessons/`: one file per lesson, named `YYYY-MM-DD-issue-N.md`. Build runs add one inside their pull request when they learned something the next run should know. You approve it when you merge.

Every week the factory's curate run reads the lessons added here, together with run results and reviews, and proposes updates to the shared playbooks in the factory repository's `brain/`.

A lesson file:

```markdown
---
date: YYYY-MM-DD
ticket: N
tags: [gate, crs]
---
# <one-line rule the next run should follow>

**What happened:** what was tried, what failed or surprised, with the command or error.

**Rule:** what to do next time, specific enough to act on.
```

The frontmatter is plain YAML between two `---` lines, with exactly these three keys: `date` (ISO date), `ticket` (issue number, no `#`), `tags` (one to four lowercase words naming the area, such as `gate`, `crs`, `tests`, `deps`, `i18n`). It makes lessons searchable by tag here and in Obsidian, and lets the curate run group them.
