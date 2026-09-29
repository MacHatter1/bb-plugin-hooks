# Changelog

All notable changes to Hooks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.4.0 - 2026-09-29

### Added

- Browse templates by category, with the author and a performance and security score out of 100 (with a letter grade) taken from what each template runs.
- Group marketplace listings by category, sort results, switch between card and list views, and browse catalog banners.
- Report anonymous install counts for the BB Hooks Marketplace catalog, once the user agrees. BB asks on the first install from it and sends only the template id and version, with a proof-of-work challenge that makes fake counts expensive. No other catalog is ever reported. Change the answer with `bb hooks marketplace stats` or the `shareInstalls` setting.
- Pass `BB_CLI` to command hooks when the server can resolve the `bb` binary.

### Changed

- The plugin no longer ships its own hooks. Templates come from the marketplace catalog, which a new install subscribes to.
- The run log is paged, 25 runs at a time, including when filtered by hook or failure.
- Sync the Plugin SDK declarations and preserve dispatch payload compatibility across SDK context versions.

### Fixed

- A gate hook that exits with an unexpected code now names that code in the reason.
- Adding or editing a hook leaves an unreadable hooks setting unchanged, and overlapping edits no longer drop a hook.
- Webhook requests do not follow redirects, so a payload is not sent on to another host.
- Run history and test output redact stored secret values.
- A gate hook skipped because the dispatch budget ran out is written to the run history.

## 0.3.0 - 2026-09-19

### Added

- Open a new thread from the Hooks page or composer to create a hook with agent guidance.
- Configure template parameters as fields in the Hooks settings page.
- Choose whether follow-up and review threads inherit the triggering agent or use a selected provider.
- Show template authors, versions and homepages in the marketplace.
