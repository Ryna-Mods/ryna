# Releasing the bundle

A release of this repository is two things made together:

- **`Ryna-<version>-forever.zip`**: every addon's folder side by side, for an addon manager.
- **`addons.json`** and **`addons.json.sig`**: the index the Ryna app reads at
  `releases/latest/download/addons.json`, to update each addon on its own between app releases
  (the design is section 6.2 of
  [ryna_agent's design note](https://github.com/MaddisonM79/ryna_agent/blob/main/docs/ryna-agent-cores-mods.md)).

The bundle has a version of its own, on the 0.5 line, one patch up each
release, starting at `0.5.1` (0.5.0 was the last release every addon shared, from ryna_agent). It is the tag (`v0.5.1`), and it gives the index its `serial` (0.5.1 is 5001): the app
refuses an index numbered lower than the last one it took, so a bundle's version only ever goes up.
It says nothing about the versions of the addons inside, which each have their own.

## What a release holds

[`bundle.json`](bundle.json) says which release of each addon goes in:

```json
{ "folder": "Ryna_Meter", "repo": "Ryna-Mods/meter", "tag": "v0.5.1", "sha256": "…", "minApp": "0.5.1" }
```

- `repo` and `tag` name the addon's release. Its zip is `<Folder>-<version>.zip` unless `asset` says
  otherwise.
- `sha256` pins that zip. The build stops if the file on GitHub is any other.
- `minApp` (optional) is the oldest Ryna app that can read what this version writes; an older app
  keeps the copy it carries.
- Every addon is in a repository of its own (`Ryna-Mods/…`) and gets an index entry, so the app can
  fetch it. (The build still takes an addon out of ryna_agent's combined zip, `MaddisonM79/ryna_agent`
  with `asset` `Ryna-<version>.zip`, and leaves it out of the index; none comes that way any more.)

The build ([`scripts/publish.mjs`](scripts/publish.mjs)) refuses a release that couldn't work: a TOC
whose version isn't its tag's, a mod that needs an API level the bundle's core doesn't serve, a zip
holding anything but its one folder, an addon that would go back a version or drop out of the index.

## Steps

1. Edit `bundle.json`: the addon's new `tag` (and `minApp` if it needs one).
2. `node scripts/publish.mjs pin` fills in the `sha256`. Read the diff: one addon changed.
3. `node --test scripts/publish.test.mjs`, then commit (signed) and push to `main`.
4. Tag the next version, signed and annotated, on that commit, and push the tag:

   ```bash
   git tag -s v0.5.2 -m "v0.5.2"
   ```

   ```bash
   git push origin v0.5.2
   ```

The `release` workflow does the rest: it builds, signs the index with the addons key (which lives
only in the `release` environment, open to `v*` tags alone), checks the signature against
[`addons.pub`](addons.pub), the key the app carries, and publishes. A published release is never
changed; a mistake is fixed by the next version.

To see what a release would hold without publishing, run the workflow by hand from `main`: the
files are kept as a workflow artifact, unsigned.

## The key

`addons.pub` is the public half of the addons key. It signs this index and nothing else: it can't
sign an app update, and the app's update key can't sign an index. The app holds its own copy
(`agent/app/addons.pub` in ryna_agent); the two must be the same file.
