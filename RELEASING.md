# Releasing the bundle

A release of this repository is two things made together:

- **`Ryna-v<N>-forever.zip`**: every addon's folder side by side, for an addon manager.
- **`addons.json`** and **`addons.json.sig`**: the index the Ryna app reads at
  `releases/latest/download/addons.json`, to update each addon on its own between app releases
  (the design is section 6.2 of
  [ryna_agent's design note](https://github.com/MaddisonM79/ryna_agent/blob/main/docs/ryna-agent-cores-mods.md)).

`N` is a whole number that goes up by one each release. It is the tag (`v7`) and the index's
`serial`; the app refuses an index numbered lower than the last one it took.

## What a release holds

[`bundle.json`](bundle.json) says which release of each addon goes in:

```json
{ "folder": "Ryna_Meter", "repo": "Ryna-Mods/meter", "tag": "v1.0.1", "sha256": "…", "minApp": "0.5.1" }
```

- `repo` and `tag` name the addon's release. Its zip is `<Folder>-<version>.zip` unless `asset` says
  otherwise.
- `sha256` pins that zip. The build stops if the file on GitHub is any other.
- `minApp` (optional) is the oldest Ryna app that can read what this version writes; an older app
  keeps the copy it carries.
- An addon in a repository of its own (`Ryna-Mods/…`) gets an index entry, so the app can fetch it.
  One that still comes out of ryna_agent's combined zip (`MaddisonM79/ryna_agent`, `asset`
  `Ryna-<version>.zip`) is only in the bundle: the app already carries that version.

The build ([`scripts/publish.mjs`](scripts/publish.mjs)) refuses a release that couldn't work: a TOC
whose version isn't its tag's, a mod that needs an API level the bundle's core doesn't serve, a zip
holding anything but its one folder, an addon that would go back a version or drop out of the index.

## Steps

1. Edit `bundle.json`: the addon's new `tag` (and `minApp` if it needs one).
2. `node scripts/publish.mjs pin` fills in the `sha256`. Read the diff: one addon changed.
3. `node --test scripts/`, then commit (signed) and push to `main`.
4. Tag the next number, signed and annotated, on that commit, and push the tag:

   ```bash
   git tag -s v7 -m "v7"
   ```

   ```bash
   git push origin v7
   ```

The `release` workflow does the rest: it builds, signs the index with the addons key (which lives
only in the `release` environment, open to `v*` tags alone), checks the signature against
[`addons.pub`](addons.pub), the key the app carries, and publishes. A published release is never
changed; a mistake is fixed by the next number.

To see what a release would hold without publishing, run the workflow by hand from `main`: the
files are kept as a workflow artifact, unsigned.

## The key

`addons.pub` is the public half of the addons key. It signs this index and nothing else: it can't
sign an app update, and the app's update key can't sign an index. The app holds its own copy
(`agent/app/addons.pub` in ryna_agent); the two must be the same file.
