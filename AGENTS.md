# Repository rules

This repository contains one reviewed, redistributable skill package.

- Keep the installable package in `sell-to-facebook-marketplace/` with one `SKILL.md`.
- Do not add symlinks, credentials, browser profiles, screenshots, message logs, personal paths, or real Marketplace data.
- Keep public docs truthful about scope: item listings only unless other listing flows are actually implemented and tested.
- Keep install guidance truthful: a documented install path must leave the installed skill able to resolve its production dependencies.
- Treat every new example, fixture, and comment as public material.
- Run `python3 scripts/validate-skills.py .` before publishing changes.
- Run `npm test --prefix ./sell-to-facebook-marketplace` after changing package code or instructions.
- Use `python3 scripts/install-skill.py sell-to-facebook-marketplace --dest <directory>` for additive installs only.
