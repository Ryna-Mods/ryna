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
- `mod` (optional, never on the core) says what the mod is: `{ "id", "name", "summary",
  "actsInGame" }`. It goes into the signed index as written, and it is what lets **a new mod reach
  people without a new Ryna app**: an app that has never heard of the folder lists the mod from these
  words, marked New and off until the person turns it on, and fetches its zip by the pinned hash like
  any update. Without `mod`, only an app built with that mod installs it. A new mod's entry should
  have it from its first release. The words are shown to people as they are, so write them as a
  mod's `mod.json` summary is written.
- Every addon is in a repository of its own (`Ryna-Mods/…`) and gets an index entry, so the app can
  fetch it. (The build still takes an addon out of ryna_agent's combined zip, `MaddisonM79/ryna_agent`
  with `asset` `Ryna-<version>.zip`, and leaves it out of the index; none comes that way any more.)

The build ([`scripts/publish.mjs`](scripts/publish.mjs)) refuses a release that couldn't work: a TOC
whose version isn't its tag's, a mod that needs an API level the bundle's core doesn't serve, a zip
holding anything but its one folder, an addon that would go back a version or drop out of the index.

## One addon, in one command

An addon change reaches a player only after two releases, the addon's own and then this
repository's. [`scripts/release-addon.mjs`](scripts/release-addon.mjs) runs both, and moves the
app's pin in ryna_agent, stopping at the first thing that isn't right:

```bash
node scripts/release-addon.mjs chronicle 0.7.2 "what changed, in a few words" --dry-run
```

Without `--dry-run` it sets the addon's TOC version, runs the addon's checks, commits, tags and waits
for its release; then sets this repository's `bundle.json`, pins it (refusing a diff of more than that
one addon), runs the tests, commits, tags the next bundle version and reads the published index back;
then moves the mod's pin in ryna_agent and runs its checks. It needs the addon's clone beside this
one, ryna_agent at `../../MaddisonM79/ryna_agent` (or `$RYNA_MODS_DIR`, `$RYNA_AGENT_DIR`), every
clone on a clean, pushed `main`, and the addon's check green on that commit. Both tags are signed with
the key git already uses, so nothing about who may publish changes. For Ryna Core it leaves the
app's pin to a person, since that pin moves with the API levels.

## Steps

1. Edit `bundle.json`: the addon's new `tag` (and `minApp` if it needs one).
2. `node scripts/publish.mjs pin` fills in the `sha256`. Read the diff: one addon changed.
3. `npm test`, then commit (signed) and push to `main`.
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
