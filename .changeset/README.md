# Changesets

Every pull request that should release `@dalgo/core` must include a changeset:

```sh
pnpm changeset
```

Choose `patch`, `minor`, or `major` for `@dalgo/core` and describe the
user-visible change. Merging ordinary changesets updates the automated version
pull request; it does not publish directly.

Files below `.changeset/releases/` are generated release authorization
markers. Do not create or edit them by hand.
