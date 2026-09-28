# Changelog

All notable changes to Hooks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Group marketplace listings by category, sort results, switch between card and list views, and browse catalog banners.
- Report anonymous install counts for the BB Hooks Marketplace catalog, once the user agrees. BB asks on the first install from it and sends only the template id and version, with a proof-of-work challenge that makes fake counts expensive. No other catalog is ever reported. Change the answer with `bb hooks marketplace stats` or the `shareInstalls` setting.

### Changed

- Sync the Plugin SDK declarations and preserve dispatch payload compatibility across SDK context versions.

## 0.3.0 - 2026-09-19

### Added

- Open a new thread from the Hooks page or composer to create a hook with agent guidance.
- Configure template parameters as fields in the Hooks settings page.
- Choose whether follow-up and review threads inherit the triggering agent or use a selected provider.
- Show template authors, versions and homepages in the marketplace.
