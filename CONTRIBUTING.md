# Contributing

Thanks for your interest in contributing!

**All coding guidelines — conventions, commands, hard rules, tests, debugging
and the git workflow — live in [AGENTS.md](AGENTS.md).** They apply
exactly the same to human contributors and AI assistants (Claude Code,
opencode, Antigravity, ZCode, Junie…); the agent entry files (`CLAUDE.md`,
`GEMINI.md`) just import it, so the rules exist exactly once.

In short:

- **English** for all code, comments, explanations, commit messages, agent instructions,
  identifiers, logs, user-facing strings (gettext msgids) and documentation;
  only localizations (`po/`, `mo/`) and `README.cs.md` are exceptions
- `make check` and `make test` must pass (a new feature means a new test too)
- one logical change = one commit, format `area: what` in the imperative
- describe the PR's what and why; attach the test output
- be kind — we follow the [GNOME Code of Conduct](https://conduct.gnome.org/)

When adding support for a newer GNOME (45+ requires ESM), keep both variants
separate and list only versions you have actually tested.
