# Ryna

Ryna's addons for World of Warcraft: Forever, in one download: the Ryna addon and every mod that
builds on it. One window (`/ryna`), one settings panel, one look, in place of several separate addons.

This repository is where releases for addon managers will be published; it has none yet. The source,
the issues and the desktop app are at [MaddisonM79/ryna_agent](https://github.com/MaddisonM79/ryna_agent).

## What's in it

| Folder | What it does | Without the Ryna app |
|---|---|---|
| `Ryna` | The window, the settings panel, the minimap button and the plumbing every mod uses. | Works |
| `Ryna_Meter` | A live meter (damage, DPS, healing, HPS, damage taken, absorbs, interrupts, dispels) and a threat bar for your group. | Works fully |
| `Ryna_Automation` | Does the chores you tick: quests, vendors, trainers, mail, loot rolls, invites, resurrections, dialogs and cinematics. Does nothing until you turn each one on; hold Shift to pause it. | Works fully |
| `Ryna_Prices` | What a vendor pays for an item and what the auction house asks, on every item tooltip. | Limited: everyone's pooled prices come through the app |
| `Ryna_Chronicle` | Records your characters, bags, bank, quests, kills and loot, and shows your tallies on tooltips. | Records and shows in game |
| `Ryna_Fights` | Your recent fights in Ryna's window: who struck first, who died when, damage over the fight. | Shows nothing |

Every mod needs `Ryna`. To leave a mod out, untick it in the game's AddOns list on the
character select screen.

## What the Ryna app adds

Ryna is two halves. These addons are the half in the game. The other is a small desktop app
([download](https://github.com/MaddisonM79/ryna_agent/releases/latest)) that reads what the addons
record and the game's combat log. With it, signed in at [ryna.io](https://ryna.io/wow):

- Chronicle's record shows on ryna.io: characters, gear, bags, quests, played time, a guild roster.
- Prices gains everyone's pooled vendor and auction prices.
- Fights has something to show: the app builds each fight from your combat log.

You don't need the app, or an account, to use the addons.

## What leaves your computer

Nothing, from the addons alone. An addon can't reach the network; it can only write its saved file
on your disk. Data goes anywhere only if you install the app and sign in, and
[ryna.io/wow/guide](https://ryna.io/wow/guide) says exactly what is sent.

## Installing

There is no release here yet, and Ryna isn't listed in an addon manager yet. Today the addons come
one of two ways:

- **With the Ryna app**, which installs them and keeps them up to date.
- **By hand:** take `Ryna-<version>.zip` from
  [ryna_agent's latest release](https://github.com/MaddisonM79/ryna_agent/releases/latest) and unzip
  it into `Interface/AddOns`. The `SHA256SUMS` file on the release lets you check the download.

## Licence

MIT. Bugs and requests go to [ryna_agent's issues](https://github.com/MaddisonM79/ryna_agent/issues).
