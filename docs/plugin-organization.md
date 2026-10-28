# Organizing more dsh plugins

Keep three kinds of files separate: plugin source, the upstream host used for compatibility testing, and installed profiles. A production profile consumes a versioned package; it is not a source repository or a test fixture.

For independently maintained plugins, start with sibling repositories:

```text
dsh-plugins/
  dsh-focus-mode/             # This Git repository
  dsh-another-plugin/         # Another Git repository when needed
  upstream/
    deepseek-harness/         # Host checkout, not copied into plugins
  artifacts/                 # Local packages, ignored by Git
```

A single plugin needs only:

```text
plugin/
  src/                       # Runtime implementation
  tests/                     # Behavior, integration, snapshots
  examples/                  # Generic, optional profile patches
  scripts/                   # Reproducible build/dev helpers when needed
  docs/                      # Compatibility and non-obvious decisions
  .github/workflows/         # Automated checks
  cordis.patch.yml            # Bundle composition
  package.json
  package-lock.json
  tsconfig.build.json
  README.md
  LICENSE
```

Commit source, tests, declarations of compatibility, examples, and a dependency lockfile. Ignore dependencies, compiled output, archives, credentials, local logs, and production profile data. Use a development profile with isolated storage for experiments. Supply the host checkout through `DSH_SOURCE`; never hardcode a developer's filesystem layout.

Use one repository and package version per plugin while they have independent dependencies and release schedules. A Git worktree belongs to its own repository and provides an isolated checkout for a feature; it does not require putting plugin source back inside the host repository. Build an archive and install that exact archive for production. Keep deployment-specific quotas, providers, credentials, and user selections in the profile's own patch layer.

Move to a workspace monorepo when several plugins actually share test infrastructure or code and routinely change together:

```text
dsh-plugins/
  packages/
    focus-mode/
    another-plugin/
    shared-testkit/           # Add only after multiple consumers exist
  examples/
  scripts/
  pnpm-workspace.yaml
  pnpm-lock.yaml
```

Each plugin still owns its manifest, bundle patch, exports, tests, and version. Prefer small public interfaces at the host's plugin extension points; use `peerDependencies` for host capabilities. Keep ordinary runtime dependencies explicit and test against a pinned host revision. Shared helpers should remove repeated maintenance for existing consumers; avoid a generic plugin framework before that need exists.

Public repositories should contain synthetic fixture values and generic configuration examples only. Keep production backups, model/account settings, histories, tokens, hostnames, and personal paths outside them. Use a GitHub noreply email for commits when the normal local Git identity contains a private address.
