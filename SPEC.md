# The Drowned Abbey — Onchain Dungeon Crawl (MVP Spec)

**Status:** Draft v0.4 · 2026-11-04
**Target:** A dedicated Canopy **nested chain** whose game logic runs as a state-machine plugin, plus a text-based web client
**Evidence base:** `canopy-network/canopy` @ `83af2a0` (2026-10-20), `@canopynetwork/canopy-ts` (verified snapshot 0.8.0; re-check before coding)

### Changes in v0.2
- **Multi-level by design** (§5). Levels are data packs. Adding a level means shipping a content pack plus a plugin release with an activation height, with no rules-engine changes for ordinary levels.
- **Gold is the chain's native token** (§6). Loot is paid from a genesis-funded treasury rather than minted, which keeps native supply accounting intact.
- **Commit-reveal dice** (§7.3) replace the beacon-only design, because gold now has real value. An action resolves in about 2 blocks.
- **6-second block target** (§7.2), which requires tuning consensus timeouts from the 20s default.
- Former open questions are now decisions (§11). The remaining questions are in §12.

### Changes in v0.3
- **Staking:** launch as a nested chain secured by CNPY validators on the root chain. Gold becomes the staking token later through a governance-approved graduation (§6.5).
- **Onboarding:** a free, unthrottled gold faucet with its own genesis allocation. Rate limits can be turned on later with a simple param change (§6.6).
- **Genesis:** 40% of gold supply goes to the Abbey Treasury (§6.7).
- **Treasury governance:** rules are fixed in the plugin. Changes require a chain-governance vote plus a release with an activation height. No admin key can move treasury funds (§6.8).

### Changes in v0.4 (spec review)
- **Roll IDs are deterministic** (`sha256(charId ‖ actionNonce)`), so the client can build the commitment before signing (§7.3).
- **Loot is reserved at commit**, not won by the first reveal. Under first-reveal-wins, the block proposer would decide every loot race through tx ordering (§7.3).
- **Fizzle rule:** if an action's target is gone by reveal time, the action does nothing and isn't treated as a forfeit (§7.3).
- **Reveal censorship** is listed as a griefing risk, with mitigations (§7.3).
- **Stairs up never seal.** Otherwise a level-1 reset would trap characters on level 2, which has no extraction point (§5.2).
- **Season rules restored** (§4.3). They were dropped in the v0.2 rewrite.
- **Consistency fixes:** where altar offerings go, a `shop_sell` tx for item sale prices, a level-1 budget that matches the loot tables (~700g), two tx fees per action, and correct odds in the sample session.
- **Verified in source:** the core skips its own fee check for plugin messages, so the plugin owns fees and a zero-fee `faucet_claim` works. The plugin must not register `send`, so core handles native transfers. Never enable the core's node-level faucet mode, which mints (§6.6, §7.6).

---

## 1. Pitch

A ruined abbey sank into a marsh three hundred years ago. Every season its bell tolls again and the waters recede just enough for treasure hunters to slip inside. Each level below is older and deeper than the last.

**The Drowned Abbey** is a classic text dungeon crawl that runs on its own Canopy chain. All players share one dungeon. If you clear the rubble, it stays cleared for everyone. If you kill the skeletons in the Ossuary, the next party walks through an empty hall. If you fall in the Choir, the Ferryman drags you back to camp, but your gear stays where you fell for whoever finds it next, and half your gold goes to the other delvers on that level.

Every meaningful choice is a d20 roll. The roll comes from chain-derived randomness, gets resolved by consensus, and anyone can verify it afterward. **Gold is the chain's native currency.** You earn it in the dungeon, it pays transaction fees, and it can be staked, but it only counts once you **get it out alive**.

### Design pillars

1. **Classic tabletop feel.** You read a room description, pick an option, roll, and read the outcome. Ability checks, AC, HP, advantage, and saving throws work the way they do in D&D (rules adapted from SRD 5.1, CC-BY-4.0).
2. **One shared, persistent world.** Each level has one canonical state per season. Every action writes to it, and other players can see, inherit, and exploit those changes.
3. **Fair, verifiable dice.** Nobody can choose an outcome: not the player, not a validator, not the frontend. Every roll shows its inputs.
4. **Push-your-luck extraction.** Gold you carry can be lost. Gold you extract is real, spendable, stakeable chain currency.
5. **Async-friendly multiplayer.** There's no turn order to wait on. Players act whenever they want, and the chain orders everything deterministically.
6. **Content is data.** New levels, monsters, and items ship as content packs on a shared rules engine.

---

## 2. Core loop

```
Create character ─► Roll stats ─► Enter Abbey ─► [Read room → Choose action → Roll → Outcome]* ─► Extract (gold to wallet) or get Ferried (lose loot + half your gold)
        ▲                                                │                                                    │
        │                                    descend stairs to deeper levels                                   │
        └──────────────────────── Spend gold at the Lychgate camp (shop) ◄────────────────────────────────────┘
```

**Sample session** (what the client renders):

```
═══ OSSUARY HALL · Level 1 ═══════════════════════════════════════
Bones are stacked to the vaulted ceiling in neat, terrible rows.
Three SKELETONS turn their skulls toward your torchlight.
  • Skeleton A  [■■■■■■■□□□]  (wounded by Brannoc, 2 blocks ago)
  • Skeleton B  [■■■■■■■■■■]
  • Skeleton C  [■■■■■■■■■■]
Also here: Brannoc (Fighter, 11/24 HP)

  1) Attack Skeleton A          (d20+5 vs AC 13 · 65%)
  2) Attack Skeleton B          (d20+5 vs AC 13 · 65%)
  3) Sneak past to the Scriptorium   (DEX DC 14, disadvantage · 23%)
  4) Flee back to the Narthex   (DEX DC 16 · 35%)
  5) Drink Healing Potion       (2d4+2)

> 1
⧗ Action sealed at block 18,402 · revealing at block 18,403…

🎲 d20 = 17 (+5) = 22 vs AC 13 — HIT
🎲 1d6+3 = 8 damage. Skeleton A collapses into a pile of bones.
🎲 Skeleton B swings: d20 = 6 (+4) = 10 vs your AC 14 — MISS
[verify roll ▸]
```

---

## 3. Rules (MVP subset of classic D&D)

All math is integer-only. Rules are adapted from SRD 5.1 (CC-BY-4.0, attribution in client credits). No proprietary setting, monsters, or adventure text are used. The dungeon is original.

### 3.1 Abilities & checks

- Six abilities: STR, DEX, CON, INT, WIS, CHA. Modifier = `floor((score − 10) / 2)`.
- **Stat generation:** the chain rolls 4d6-drop-lowest six times. The player then assigns the six results to abilities in a follow-up `assign_stats` tx. The rolls are fixed before assignment, so assigning gives players no way to reroll.
- **Check:** `d20 + modifier (+ proficiency 2 if the class is proficient) ≥ DC`. Natural 20 always succeeds and natural 1 always fails on attacks; on checks they're flavor only.
- **Advantage/disadvantage:** roll 2d20 and keep the higher or lower. They don't stack, and having both cancels out.
- **DC ladder:** Easy 10 · Medium 13 · Hard 16 · Very Hard 19. Room DCs may sit between the anchors (e.g. 12, 14, 15); the content linter enforces 10–19.

### 3.2 Classes (all start at "level 3" power so a solo player can survive the early rooms)

| Class | HP | AC | Attack | Proficient checks | Signature ability (per delve) |
|---|---|---|---|---|---|
| **Fighter** | 24 + CON | 16 | +5, 1d8+3 | STR, CON | *Second Wind* (1×): heal 1d10+3 |
| **Rogue** | 20 + CON | 15 | +5, 1d8+3 | DEX, INT | *Sneak Attack*: +2d6 if an ally is in the room or the target is unaware; advantage on locks/traps |
| **Cleric** | 22 + CON | 15 | +5, 1d8+2 | WIS, CHA | *Heal* (3×): 2d4+2 to self or an ally in the room; *Turn Undead* (1×): undead in the room make a WIS save DC 13 or flee |
| **Wizard** | 18 + CON | 13 | Fire Bolt +5, 1d10+2 | INT, WIS | *Magic Missile* (3×): 3×(1d4+1), never misses |

Class numbers were tuned in M1 with the balance simulator (§9.3; `rules/M1-REPORT.md`). Signature uses refresh when you extract or rest at camp. Character progression (XP/levels) is out of scope for the MVP. Deeper dungeon levels will need it, so the character record reserves fields for it (§5.4).

### 3.3 Combat (async "exchange" model)

Multiplayer onchain combat can't wait on initiative order, so each **action resolves as one exchange**:

1. The acting character resolves their action (attack, spell, item, check).
2. If hostile monsters are alive in the room, **one** of them counterattacks the acting character. The target is picked by a deterministic rule: the monster that was just attacked, otherwise the lowest-index living monster.
3. Doing a non-combat action (search, loot, pick a lock) in a room with living hostiles also gets you one counterattack, so looting mid-fight is a gamble.

Monster HP lives in **shared room state**. If two players attack the same skeleton in the same block, the damage stacks in resolution order.

**Who strikes first** (two switches in `content.variants`, both on; see `rules/INITIATIVE-PROTOTYPE.md`):
- **Ambush:** walking into a room with hostiles rolls initiative: your d20 + DEX against the first hostile's d20 + its `initiative` bonus. If it wins (strictly higher; ties go to you), it strikes as you arrive. That makes such a move a roll (commit-reveal). Actions that carry you elsewhere (wading out) don't trigger it.
- **Quick monsters** (the `quick` trait: giant rats) answer *before* your action instead of after it. If that blow downs you, your action is lost.
- Either way it is still one answer per exchange: a monster that struck first doesn't strike again. Per-round initiative was tried and left off (too punishing solo).

**Lying low:** an effect that hits the whole room (the Abbot's *Tide Wail*, presenting the signet) reaches the acting character and everyone standing there who has acted (committed or resolved an exchange, or entered the dungeon) within the last **2 minutes**. At most the **32** most recently active of those are reached (plus the actor), so a room-wide exchange costs the same however crowded the room. Anyone idle longer is hidden in the shadows and is passed over, for better (no Wail damage) and worse (no signet blessing). They're still in the room: they count as present for everything else and can be targeted directly (a potion, *Heal*, stabilizing). This keeps a crowd of AFK characters from changing a fight, and keeps the cost of a room-wide exchange bounded by the players actually in it.

**Fleeing:** a DEX check at DC `10 + 2 × living hostiles`. On success you move to the room you came from. On failure you take a counterattack and stay put.

### 3.4 Downed and the Ferryman

- At 0 HP a character is **Downed** and can't act. They have **2 minutes** to be stabilized: an ally in the room passes a WIS DC 10 check, or a Cleric uses *Heal*, or an ally feeds them a potion.
- **No permanent death.** If nobody saves them in time, `EndBlock` hands them to **the Ferryman**. They wake at the Lychgate (L1 room 0) at 1 HP, still delving, and can extract normally.
  - **Items:** every item they carried stays behind as a **cache** in the room where they fell. Any player can `take` it, including the same character on a later trip.
  - **The toll:** half their carried gold is lost, rounded against the player. They keep `floor(carried / 2)`.
  - **Who gets the toll:** it's split equally among the **other accounts** that have a standing character on the **same level** which acted (committed or resolved an exchange) in the last **10 minutes**. Each account gets one share, credited to its most recently active character there. At most the **10** most recently active accounts are paid, ties broken by address. Shares are paid into those characters' carried gold, so they still have to survive and extract it. The rounding remainder returns to the treasury.
  - **If nobody qualifies,** the toll stays in the room's cache for whoever finds it.
  - **Sybil resistance:** "online" is defined by chain state. Your own account never qualifies, and a recipient has to be standing in the dungeon on that level, exposed to its danger. Alts can still collect, but only by actually delving.
- Wallet gold and stash items are never touched. The toll only applies to gold carried in the dungeon (escrow, §6.3).
- There's no PvP. Characters can't attack or steal from each other. They interact only through the shared world: loot races, shared monster HP, picking up dropped and offered gold, looting caches, and side effects like desecrating the altar or ringing the bell. With the toll, other players now gain from your misfortune, which gives those side effects a small griefing incentive. Watch for it in the playtest (M4).

### 3.5 Resting

- **Short rest** (once per delve, only in rooms with no hostiles): spend 1 Hit Die and heal 1d8 + CON. There's a 1-in-4 chance of a wandering monster encounter from the level's wandering table.
- Leaving through the Lychgate fully heals the character and refreshes all abilities.

---
### 3.6 Parties

Players travel together by joining a **party**. A party is named after a character (its leader); a character's own owner
puts it in a party with `party_set`, and nobody else can. Joining is consent to be moved along.

- **Joining:** name a character standing in the same place (both at camp, or in the same room) and join its party; name
  yourself to lead your own. Your own characters can join each other's party from anywhere (a party played from one
  account). A party holds at most **6**.
- **Moving together:** when a member moves to another room of the level, every other member standing in that room comes
  along in the same exchange: one tx, one set of arrivals. Members who are downed, locked by a sealed roll of their own,
  or elsewhere are left behind, as is anyone who couldn't take that exit themselves. Stairs to another level are not a
  group move.
- **Arriving together:** walking into a room with hostiles (the ambush variant, §3.3) rolls initiative **once**, for the
  mover at the front. If the monsters win, the first blow lands on the mover; nobody walks in alone.
- **Fleeing** a fight is not a group move: everyone flees on their own DEX check.
- **Leaving:** `party_set` with no party. A leader who hasn't joined their own party takes the joiners along when they
  move, but isn't taken along by them.

Everything else is unchanged: allies are whoever stands in the room, party or not (Sneak Attack, Heal, stabilizing), and
the Ferryman's toll still goes to other accounts only (§3.4).

## 4. Level 1: The Drowned Abbey of Saint Vael

Level 1 has 13 rooms. Room 0 is the safe camp and the only extraction point for the whole dungeon. Room 12 holds the stairs down to level 2, which is a future content pack. All text below is original and lives in the client content pack. The chain stores only IDs and numbers (§5).

```
                      [10 Hidden Sacristy]
                              ┆ (secret door)
 [0 Lychgate]─[1 Narthex]─[3 Chapel]─[6 Bell Stair]─[7 Reliquary]─[9 Cistern Bridge]─[11 Drowned Choir]─[12 Sepulchre]═▶ stairs to L2
                  │                                                    │
             [2 Ossuary]─[4 Scriptorium]                        [8 Kitchens]
                  │                                                    │
             [5 Cloister]────────── (rubble) ──────────────────────────┘
```

| # | Room | Encounter | Choices (check, DC) → outcome | Shared-world effect |
|---|---|---|---|---|
| 0 | **Collapsed Lychgate** | Safe camp. Shop and stash. | Extract, Shop, Stash, Enter | — |
| 1 | **Flooded Narthex** | Waist-deep water | Wade carefully back to camp (DEX 10; fail: drop 1d4 carried gold into the silt; this is the only way from room 1 to room 0) · Search silt (WIS 12: claim the silt pool, plus a 15g seed purse once per season) | Lost gold accumulates in the silt, so other players can find it |
| 2 | **Ossuary Hall** | 3× Skeleton | Fight · Sneak past (DEX 14, disadv.) · Cleric: Turn Undead | Skeletons stay dead all season |
| 3 | **Chapel of Drowned Saints** | Altar | Pray (WIS 13: *Blessed*, +1 to the next 3 rolls; fail: *Chilled*, −1 to the next 3) · Offer 10 carried gold (auto-bless) | Offerings accumulate in the altar pool. Desecrating it (STR 12) gives the pool to the desecrator and spawns 1 Ghoul for **everyone**. Anything left in the pool returns to the treasury at season reset |
| 4 | **Scriptorium** | Iron-bound chest, rotting tome | Pick lock (DEX 14, Rogue adv.) · Smash (STR 16; noise: a rat spawns in room 5 and a skeleton in room 2, success or not) · Read tome (INT 12: learn the secret door in room 7) | The chest (40g + *Silvered Dagger*) empties once per season. The tome lore is learned per character |
| 5 | **Collapsed Cloister** | 2× Giant Rat | Fight · Clear rubble toward 8 (STR 12; two successes from any players) | **Rubble cleared opens a shortcut for everyone** |
| 6 | **Bell Tower Stair** | Pressure-plate trap (falling bell) | Spot (WIS 13) → Disarm (DEX 13) · Walk through blind (DEX save DC 13 or 2d6 damage) | Once disarmed, safe for all. Once triggered, the bell tolls and wakes room 11's ghouls (they gain advantage on their first attack) |
| 7 | **Reliquary** | Gilded coffer (**Mimic**) | Investigate (INT 14: reveal the mimic, gain advantage) · Open it (mimic gets a surprise attack) · Search walls (WIS 15, or auto-success if the tome was read) → secret door to 10 | Secret door marked with chalk once found, so it's visible to all |
| 8 | **Kitchens & Cellar** | 3× Goblin scavengers (start *wary*: no counterattacks until provoked) | Parley (CHA 12: they sell 1 potion for 20g and warn you about the bridge) · Intimidate (STR or CHA 14: they flee and drop 2d6 gold) · Fight | Goblin disposition is shared: hostile, friendly, or fled |
| 9 | **Cistern Bridge** | Narrow, slick bridge | Cross (DEX 12; fail: 1d6 damage and swept back to room 1) · Use rope (auto-success) · Tie rope (STR 10, then permanent for all) | A tied rope makes the bridge safe for everyone |
| 10 | **Hidden Sacristy** | None | Loot: *Abbot's Signet* (rare), 120 gold | One-time treasure per season |
| 11 | **The Drowned Choir** | 2× Ghoul | Fight · Sneak (DEX 15) · Turn Undead | — |
| 12 | **Abbot's Sepulchre** | **The Drowned Abbot** (boss) | Fight · Present the *Abbot's Signet* (CHA 15: the Abbot hesitates, and the party gets advantage on the next 2 attacks) | Boss death drops the hoard pile (300g + *Abbot's Crozier*), unseals the **stairs to level 2** for this season, and starts the level-1 reset countdown |

**Level-1 gold budget per season** (the sum of its loot tables' maximum payouts, checked by the linter): silt purse 15 + chest 40 + mimic 60 + goblins 12 + sacristy 120 + hoard 300 = **547g**, plus item sale value (Signet 150) = **~700g**. Gold dropped into the silt or offered at the altar is recycled player gold and doesn't count against the budget.

### 4.1 Monsters (SRD-inspired, tuned for this dungeon)

| Monster | HP | AC | Attack | Notes |
|---|---|---|---|---|
| Skeleton | 13 | 13 | +4, 1d6+2 | Undead |
| Giant Rat | 7 | 12 | +4, 1d4+2 | Pack: +1 to hit per other living rat |
| Goblin | 7 | 15 | +4, 1d6+2 | Can be parleyed with |
| Mimic ("Gilded Coffer") | 24 | 12 | +4, 1d8+2 | Surprise attack if opened uninspected. Drops 60g |
| Ghoul | 18 | 12 | +4, 2d4+2 | Undead. On hit: CON save DC 10 or *Slowed* (disadvantage on the next roll) |
| **The Drowned Abbot** | 48 | 14 | +4, 1d8 | Undead boss, immune to Turn Undead. **Recovers** to full HP if nobody has fought him for a minute, so he has to be beaten in one push (you can't wear him down across trips now that nobody dies). Every 3rd exchange in his room: *Tide Wail* hits every character in the room for 2d8 (WIS save DC 13 for half). Damage is weighted toward the Wail on purpose: it hits each character the same however big the party, while counterattacks are split across party members, so this keeps parties from trivializing him |

### 4.2 Items (MVP set)

| Item | Rarity | Effect | Source |
|---|---|---|---|
| Healing Potion | common | Heal 2d4+2 (self or downed ally) | Shop 25g, goblins 20g, loot |
| Rope | common | Auto-cross room 9, or tie it for everyone | Shop 10g |
| Lockpicks | common | Advantage on room 4 chest | Shop 15g |
| Silvered Dagger | uncommon | Weapon: +5, 1d6+3, +1d4 vs undead | Scriptorium chest |
| Saint's Ward | uncommon | +1 AC (worn) | Chapel (desecration) / Choir |
| Abbot's Signet | rare | Advantage on CHA checks; sells to the camp shop for 150g (`shop_sell`) | Hidden Sacristy |
| Abbot's Crozier | rare | Weapon: +6, 1d8+3; *Turn Undead* 1×/delve for any class | Boss hoard |

Items are unique instances (`itemId`) of a template (`templateId`). Each character carries up to 8 slots, and the account stash holds up to 32. Gold prices are shown in whole gold (§6.1). Only items with a listed sale price can be sold. Each sale is paid from the treasury and counted against the budget of the level the item came from.

### 4.3 Seasons (per level)

- A season is one fresh copy of a level. Monsters respawn, loot refills, and rubble, ropes, traps, chalk marks, and goblin disposition reset.
- A level's season ends **30 minutes after its boss dies**, or at a hard cap of about 3.5 days. The bell tolls 10 minutes before the end as a warning.
- At season end, characters still **on that level** are washed out through the Lychgate by the flood: they come round at camp (out of the dungeon, healed, as if they'd left), keep their items, but **lose their carried gold**, which returns to the treasury. On a busy level this takes a few blocks, and the level is closed until it's done (§7.4). That level's corpse caches, room gold, and altar pool also return to the treasury, and the unspent budget is released and re-reserved for the new season.
- Characters on other levels aren't affected. Levels reset independently (§5.3).
- Season number, start height, and boss-killer are recorded per level for the leaderboard.

---

## 5. Levels & content extensibility

Goal: **adding level 2 should be a content-pack PR plus a plugin release, with no rules-engine changes.** New code is only needed when a level introduces a genuinely new mechanic, and then it lands as a new effect or condition type that any later level can reuse.

### 5.1 Layering

```
@abbey/rules (pure, deterministic, shared by plugin + client)
├── engine/        dice, checks, combat exchange, effect interpreter, condition evaluator   ← code, changes rarely
├── registry/      classes, monsters, items, status effects (global, append-only IDs)       ← data
└── levels/
    ├── 01-drowned-abbey/   level.json  (rooms, edges, encounters, actions, loot, treasury budget)
    └── 02-<next>/          level.json
client content pack: levels/<id>/text.<locale>.json   (room prose and outcome flavor, keyed by IDs)
```

### 5.2 Rooms are data, not code

Every room action is declared in `level.json` using a small, closed vocabulary that the engine interprets:

```jsonc
{
  "id": "scriptorium.pick_lock",
  "room": 4,
  "when":   [{ "roomFlag": "chest_open", "is": false }],
  "check":  { "ability": "DEX", "dc": 14, "advantageIf": [{ "class": "rogue" }, { "hasItem": "lockpicks" }] },  // any match → advantage
  "provokes": true,                         // counterattack if hostiles alive (§3.3)
  "onSuccess": [{ "op": "setRoomFlag", "flag": "chest_open" },
                { "op": "grantLoot", "table": "scriptorium_chest" }],
  "onFailure": [{ "op": "narrate", "outcome": "lock_jams" }]
}
```

- **Effect ops (MVP set):** `damage`, `heal`, `grantGold`, `grantLoot`, `grantItem`, `setRoomFlag`, `incRoomCounter`, `setCharFlag` (lore), `applyStatus`, `spawnMonster`, `moveTo`, `revealEdge`, `narrate`, plus (added in M1) `dropGold`, `payGold`, `claimPool` (room pools such as the silt and the altar), `setMonsters` (disposition: wary/friendly/fled), `monsterAttack` (surprise), `alertMonsters` (the bell), `consumeItem`.
- **Conditions:** `roomFlag`, `roomCounter`, `charFlag`, `hasItem`, `class`, `abilityAtLeast`, `monstersAlive`, `levelBossDefeated`, plus (M1) `monsterStatus`, `goldAtLeast`, `lootAvailable`, `not`, `any`.
- **Monster traits** (registry, also append-only opcodes): `pack`, `onHitSave`, `aoeEvery`, `recovers`.
- **Edges** carry optional conditions, e.g. `{ "from": 5, "to": 8, "requires": [{ "roomCounter": "rubble", "atLeast": 2 }] }`. `hidden` edges need a `revealEdge` first, and `oneWay` edges have no automatic reverse (level 1 uses this for the Narthex: you leave by wading out).
- **Stairs** are ordinary edges whose target is in another level, e.g. `{ "from": 12, "to": { "level": 2, "room": 0 }, "requires": [{ "levelBossDefeated": 1 }] }`. An edge to a level that isn't active yet is treated as sealed ("the stairs are flooded").
- **The way back up never seals.** Every stairs edge has an automatic, unconditional reverse edge. Conditions only gate descending. Otherwise a level-1 reset that respawns the boss would trap level-2 characters with no way to reach the only extraction point. Climbing back into a respawned boss room is dangerous but allowed (flee rules apply).

### 5.3 Addressing and state scoping

- Every room is globally addressed as `(levelId, roomId)`. Monster, item, and status IDs are global and **append-only**: they are never reused or renumbered.
- Shared world state is keyed by level and that level's season: `abbey/room/{levelId}/{season}/{roomId}`.
- **Each level has its own season clock.** Killing the level-2 boss resets level 2 without disturbing level 1, and launching a new level doesn't reset existing ones.
- There's still only one extraction point (level 1, room 0). Deeper gold is worth more because you have to carry it further.

### 5.4 Shipping a new level

1. Author `levels/0N-*/level.json` plus client text, then run the **content linter**: every room is reachable, every action references known IDs, DCs sit on the ladder, loot draws fit the level's treasury budget, and there are no dead ends without an exit.
2. Run the **balance simulator** for the level (§9) and tune.
3. Cut a plugin release. It includes the pack and a hard-coded `activationHeight` for the new level, plus its `contentHash`.
4. Validators upgrade at any point before `activationHeight`. Until then the new level is inert, so nodes on the old and new release produce identical state. **This is what avoids a coordinated stop-the-world upgrade.**
5. At `activationHeight`, `EndBlock` writes the level's initial state, allocates its treasury budget (§6.3), and the sealed stairs open.
6. The client fetches `/abbey/levels`, sees the new level and its `contentHash`, and loads the matching text pack. It refuses to render a level whose text-pack hash doesn't match.

**Reserved for deeper levels** (fields exist in the MVP schema, unused): `character.xp`, `character.level`, `character.features[]`, `item.charges`, `level.minCharacterLevel`.

**What still needs code:** a new effect op or condition, a new class or class feature, or a new combat rule. These are added to the engine as **new** opcodes, and existing opcodes never change meaning, so older levels replay identically.

---

## 6. Economy: Gold is the native token

Gold is the native currency of the game's nested chain. It pays transaction fees, players can send it with the core `send` transaction, and it becomes the staking token once the chain graduates (§6.5).

### 6.1 Units

- Native accounting is integer micro-units, like CNPY: **1 GOLD = 1,000,000 µGOLD**. (Confirm the chain's denomination in genesis.)
- All game tables are authored in whole gold and converted with exact integer math. The client displays whole gold, plus decimals only where fees need them.

### 6.2 Why the game doesn't mint

A plugin may write **only** to core `accounts` and `pools` (and its own prefixes outside 1–15). The core rejects any other write (`fsm/state.go` `assertPluginKeyWritable`). Plugins **cannot** update the core `supply` record (prefix 10). If loot were minted straight into accounts, total supply would silently drift from the recorded supply. So:

- **No minting by the game.** All loot comes out of a fixed, genesis-funded **Abbey Treasury**.
- Gold moves only by transfer: treasury → player on extraction, player → treasury on shop purchases and offerings. Supply is untouched.

### 6.3 Treasury mechanics

- **Treasury account:** a 20-byte address derived as `sha256("abbey.treasury.v1")[:20]`. Nobody holds a private key for it, and only the plugin moves its balance. A deterministic account is preferable to claiming a core pool ID, because core pool IDs are allocated by chain-ID ranges that the core may use later. Funded in genesis.
- **Level budgets:** at activation, each level reserves a per-season budget from the treasury (level 1 ≈ 700 gold per season, §4). A level only spawns loot if the treasury can cover its budget. If the treasury runs low, loot tables scale down deterministically instead of failing.
- **Items with a sale price escrow it at drop time.** When loot creates the Abbot's Signet, its 150g sale price is drawn from the level budget into the item's `escrow` field, and `shop_sell` pays exactly that. A sale in a later season therefore never draws on that season's budget.
- **Carried gold is escrow.** Gold a character picks up is a game-state claim backed by the treasury balance. It becomes a real account balance only on `extract`. Death or the season flood returns it to room pools or to the treasury. The treasury never pays out more than it holds.
- **Sinks recycle:** shop purchases, flood losses, Ferryman toll remainders, and season-end leftovers (left-behind caches, room gold, altar pools) all flow back to the treasury, which funds future seasons. Offerings sit in the altar pool until someone desecrates it or the season resets.
- **Invariant (tested every block in debug builds):** `treasury.balance ≥ Σ carriedGold + Σ room/corpse/altar pools + Σ unspent level budgets`.

### 6.4 Consequences of real value

- **Randomness must be manipulation-resistant.** That's why the design uses commit-reveal (§7.3).
- **Sybil and farming pressure:** fees are paid in gold and character slots are capped (5 living per account). Bots that farm the cheap rooms are expected. Keep early-room gold low and put the value deep. The faucet is a separate pool, so faucet abuse can never drain loot (§6.6).
- **Fees:** plugin tx fees are paid in gold. The core skips its own fee check for plugin-registered messages (`fsm/transaction.go`), so the plugin enforces and collects fees itself, as the template does with the fee pool. **Each dice action costs two fees (commit + reveal).** New players get their first gold from the faucet (§6.6). M0 confirmed the core neither checks nor deducts plugin-message fees, so **free messages must reject a non-zero fee**; otherwise a fee would be signed and silently never collected. Collected fees go to `pools[chainId]`, which the core pays out to the committee each block.

### 6.5 Staking: nested now, gold later

- **Phase 1 (launch):** the game chain is a nested chain. Its validator set comes from the root chain (`rootChainID` governance param, "the source of the validator set", `fsm/gov_params.go`), so it's secured by validators staking **CNPY** for our committee on the Canopy root chain. During this phase gold is the currency for fees, loot, and trading, but not for consensus stake.
- **Phase 2 (graduation):** once gold has enough market value and enough holders to secure the chain on its own, a governance proposal sets `rootChainID` to the game chain's own ID. Validators then stake gold on the game chain. `fsm/gov.go` lists `RootChainId` among the params that need coordinated adjustment, so this needs its own runbook and a localnet rehearsal before mainnet.
- **Why this order:** a young token makes weak stake. Borrowing CNPY security at launch protects the treasury while gold has little value.
- **Graduation readiness (to be defined before Phase 2):** minimum gold market cap relative to treasury balance, minimum number of independent validators, and the stake distribution. These are tracked on a dashboard. They are not automatic triggers.

### 6.6 Faucet

- **Faucet account:** a keyless account derived as `sha256("abbey.faucet.v1")[:20]`, funded from its own genesis allocation (§6.7). Kept **separate from the treasury** on purpose: if the faucet is drained, loot budgets are unaffected.
- **`faucet_claim` tx:** pays `faucetAmount` from the faucet account to the signer. It's the only **zero-fee** message (the plugin's `CheckTx` fee rule exempts it), so a brand-new account with no gold can still call it.
- **Params** (in `abbey/params`, readable via `/abbey/params`):

  | Param | Launch value | Meaning |
  |---|---|---|
  | `faucetEnabled` | `true` | Kill switch |
  | `faucetAmount` | enough for ~100 dice actions (~200 txs) at launch fees | Gold per claim |
  | `faucetCooldownBlocks` | `0` (no limit) | Min blocks between claims per account |
  | `faucetMaxPerAccount` | `0` (no limit) | Lifetime gold per account |
  | `faucetMaxPerBlock` | `0` (no limit) | Total claims per block, chain-wide |
  | `maxTxPerBlock` | `150` | Game txs per block (`set_params` exempt). Later ones fail "block is full" and pay nothing. The core drops them from its mempool, so clients resubmit after a block or two, and higher fees are taken first (§7.4, §12 Q7) |
  | `sweepPerBlock` | `100` | EndBlock items per sweep per block: forfeits, ferries, flood (§7.4) |

- **"Simple param change":** a `set_params` tx signed by the **params authority** address set in genesis. It can change **only** the params above and per-message fee amounts. It can't move funds, touch the treasury, or alter loot budgets. Those stay under §6.8. Start with a team multisig as the authority, and plan to hand it to chain governance at graduation.
- **Known risk at launch:** with every limit at 0, a script can drain the faucet allocation and spam zero-fee claims. The damage is bounded by the faucet balance, and recovery is one `set_params` tx (e.g. a 600-block cooldown and a per-block cap). The client and RPC surface faucet balance and claim rate so the drain is visible.
- **Don't confuse this with the core's faucet mode.** The core has a node-config `FaucetAddress` that **mints** to top up sends from that address (`fsm/account.go` `maybeFaucetTopUpForSendTx`). It's a dev/test feature: it creates supply outside the treasury model, and it's per-node config. Leave it unset on every game-chain node.

### 6.7 Genesis allocation

| Allocation | Share | Notes |
|---|---|---|
| **Abbey Treasury** | **40%** | Loot budgets for all levels and seasons. Recycled by sinks |
| Faucet | proposal: 5% | Free onboarding gold (§6.6) |
| Validator / staking incentives | proposal: 20% | Rewards ahead of graduation, then gold staking |
| DEX liquidity | proposal: 15% | Gold/CNPY market so players can acquire gold |
| Team & development | proposal: 20% | Vesting recommended |

Only the 40% treasury share is decided. The other 60% shows a placeholder split for discussion (§12).

### 6.8 Treasury governance

- Treasury rules (budget per level, scaling curve, sink routing, treasury address) are **constants in the plugin release**, and no transaction can change them. **No admin key can move treasury funds.**
- **Changing them:** (1) an on-chain governance proposal approves the change and target height, then (2) a plugin release ships the new rules gated by that `activationHeight`, the same mechanism as new levels (§5.4). Validators upgrade before the height.
- **Topping up:** anyone can send gold to the treasury address with a core `send`, so no special message is needed. Withdrawals happen only through game rules.

---

## 7. Onchain architecture

### 7.1 Surface

- **Runtime:** a Canopy **nested chain** running an external state-machine plugin, connected to the core over the Unix-socket plugin protocol (`lib/.proto/plugin.proto`).
- **Language: TypeScript** (template `canopy/plugin/typescript`). The main reason is that one pure rules package, `@abbey/rules`, can be shared byte-for-byte between the plugin and the web client. The client then previews odds and **verifies rolls with the same code consensus ran**.
- **Client:** Next.js + `@canopynetwork/canopy-ts` (keystore, plugin-format signing, RPC, NodePool for reads, a sticky node for submit-and-track).

### 7.2 Block time: 6 seconds

- The core's default consensus timeouts add up to **20s** per block (`lib/config.go` `DefaultConsensusConfig`; `BlockTimeMS()` is the sum of eight phase timeouts).
- For 6s, every validator on the game chain sets proportionally smaller timeouts (about 0.3× each, e.g. NewHeight 1350ms, Election 450, ElectionVote 450, Propose 750, ProposeVote 1200, Precommit 600, PrecommitVote 600, Commit 600). The source notes that block time is set by "social consensus", so these values must be identical across the committee, and setting them too tight causes non-signing and failed rounds.
- **Measured in M0** (single validator, loopback): 5.97–6.01s mean and ≤6.74s max at up to 200 tx/block. The nested chain kept a 6.0s median even with a 20s root chain, with occasional ~8s blocks. Click-to-result was ~10–12s at light load. Multi-validator timing is still unmeasured.
- **Plugin request timeout** defaults to 1000ms (`pluginTimeoutMS`). The design keeps each plugin call small (resolution happens per tx, not batched in EndBlock) so 6s blocks stay comfortable.
- **Action latency:** commit in block *h*, reveal in *h+1*. A player sees the result **~6–12s** after clicking. Single-block resolution isn't safe once gold has value (§7.3).
- **Game time is written in seconds** (`rules/src/timing.ts`). Every timer that is about players reacting in real time is converted to blocks with one constant, `BLOCK_MS` (500): the reveal window, the rescue window, lying low, the Ferryman's "recently active", the season and its bell, how long rolls stay verifiable, and the Abbot's recovery. A different block time is that one constant plus an activation height. Governance params stay in blocks: the faucet cooldown is 7,200 blocks per hour.
- *Update (fast blocks, development):* the localnet's game chain now runs [canopy-network/canopy#648](https://github.com/canopy-network/canopy/pull/648)'s opt-in fast mode: 500ms blocks with a round-robin proposer schedule. A dice move takes ~2s, and the chain sustained ~70–80 game tx/s on one machine with no failed rounds. The PR is unmerged; production waits for it to be released. The game's timers have been re-tuned for it (above). Its predictable proposers weaken the dice against player–validator collusion, which can only be fixed in the core (§7.3, §12 Q8). See `spike/FAST-BLOCKS-REPORT.md`.

### 7.3 Randomness: delayed beacon + player commit-reveal

**What the chain gives a plugin** (verified in `plugin.proto`): `BeginBlock{height}`, `CheckTx{tx, height}`, `DeliverTx{tx, height}`, `EndBlock{height, proposer_address}`. Block hash, VRF output, and VDF output are **not** passed to plugins. Proposers are elected by VRF sortition (`bft/election.go`), so who proposes a future block can't be predicted.

**Ingredient 1: plugin beacon.** On every `EndBlock(h, proposer_h)`:

```
txAcc_h  = sha256 chain over the hashes of all Abbey txs delivered in block h, in order
beacon_h = sha256("abbey.beacon.v1" ‖ beacon_{h−1} ‖ u64be(h) ‖ proposer_h ‖ txAcc_h)
```

**Ingredient 2: a player secret.** The client generates a fresh 32-byte secret `s` for each action.

**Flow:**

1. **Commit (block *h*).** The `act` tx carries the action and `commit = sha256(s ‖ rollId)`, where `rollId = sha256(charId ‖ u64be(character.actionNonce))`. The client reads the nonce from state, so it can compute `rollId` before signing. `DeliverTx` checks the nonce, validates the action, increments the nonce, locks the character, and stores the pending roll. **Contested resources are reserved at commit:** a `take` reserves its `lootRef` to this roll, and a second `take` on a reserved item is rejected at once. Otherwise the proposer of the reveal block would decide every loot race by ordering the reveals.
2. **Reveal (block *h+1* or later, before *h+R*).** As soon as block *h* commits, the client automatically sends `reveal{rollId, s}`. `DeliverTx` checks the commitment and resolves immediately:
   ```
   seed = sha256("abbey.roll.v1" ‖ s ‖ beacon_h ‖ rollId)
   ```
   Preconditions are re-checked at this point. If the target is gone (e.g. another player killed the monster in between), the action **fizzles**: no dice, no counterattack, the character unlocks, and a `ActionFizzled` event is emitted. Otherwise the outcome is applied and an `ActionResolved` event is emitted with every input.
3. **Timeout.** If no reveal lands by `h + R` (default R = 1 minute of blocks: 120 at 500ms), `EndBlock` applies the **forfeit outcome**: every player die counts as its minimum and every monster die as its maximum. Any reservation is released. Forfeit is never better than any real outcome, so refusing to reveal a bad roll can't help a player.

**Dice from a seed:** draw `u32` values from `sha256(seed ‖ u32be(counter))` with **rejection sampling** (reject `x ≥ floor(2³²/N)·N`) so `dN` has no modulo bias. Dice are consumed in a fixed order the engine defines.

**Who can bias a roll?**

| Party | Can they bias it? | Why |
|---|---|---|
| Player | No | `s` is fixed at commit, and `beacon_h` (which includes their own tx and the VRF-elected proposer) doesn't exist yet. Aborting gives the forfeit outcome |
| Proposer of *h* (grinding tx order, or withholding the block) | No | They can see `commit` but not `s`, so they can't evaluate the outcome |
| Frontend / backend | No | Never touches `s` or the beacon. The secret is generated in the player's browser |
| Proposers of *h+1…h+R* (censoring the reveal) | Grief only | Excluding the reveal doesn't change the outcome, because the seed doesn't depend on the reveal block. Forcing a forfeit would take **R consecutive** colluding proposers. Mitigations: R ≥ 10, the client re-broadcasts to several nodes, and repeated censorship shows up in `ActionForfeited` stats |
| Player **colluding** with proposer of *h* | Weakly | The player shares their secret, and the proposer tries candidate tx sets until the beacon gives a good roll. Under VRF election this needs the player to control or bribe whoever is elected, each time. **Under a predictable proposer schedule (canopy-network/canopy#648's fast mode) the player can time a commit for a friendly proposer's block, so this gets much easier to arrange.** Moving the seed to a later block doesn't help, because that block's proposer can tune its beacon just the same. The real fix is per-block randomness the proposer can't vary, such as the proposer's BLS signature over the previous beacon (unique for a key and message, so the only move left is to withhold the block). Only the core can provide that (`plugin/UPSTREAM-NOTES.md`, item 4). Until then: accepted, and monitored via outlier detection on roll streaks per player and per proposer |

**Verifiability:** each `ActionResolved` event carries `s`, `beacon_h`, `rollId`, and the raw dice. The client recomputes them with `@abbey/rules` and checks the beacon chain against `/abbey/beacon/{h}`.

**Stat rolls, wandering monsters, and the season flood** use the same commit-reveal through the character owner's client. Only system events with no owner (season reset, treasury loot scaling) use the beacon alone, and those don't transfer value to any one player.

### 7.4 EndBlock work (confirmed supported)

- The core sends `EndBlock` through the same `sendToPluginSync` path as `DeliverTx` (`lib/plugin.go`), and serves the plugin's `stateRead`/`stateWrite` requests for any in-flight request ID. **State I/O during EndBlock is supported by the core.**
- The **TS template's** dispatcher calls `c.EndBlock(msg.end)` synchronously, and its `EndBlock` is a stub (`plugin/typescript/src/contract/plugin.ts`, `contract.ts`). We'll make it `async` and route it through the same pattern `DeliverTx` uses. That's a template-level change, not a core change.
- EndBlock duties stay small: advance the beacon, apply reveal timeouts, ferry downed characters after 2 minutes (§3.4; the plugin needs an index of recently active characters per level to find toll recipients), run level activation and season resets, and prune old beacons. All of these are bounded per block (`MAX_SWEEP_PER_BLOCK`, e.g. 200), with overflow carried to the next block in order.
- *As built:* each sweep handles at most `sweepPerBlock` items per block (a param, default 100), oldest first, and carries the rest over:
  - **Forfeits** page through `expiry/{h}/{roll}` and **ferries** through `ferry/{h}/{char}`. A late item is still processed; a late ferry checks its schedule against the height in its key.
  - **Toll recipients** come from the level's activity index, keyed by last-action height. A reverse page of at most 64 entries is loaded one height at a time until 10 other accounts qualify, so a ferry costs about a dozen record reads however busy the level is.
  - **The flood** is paged. The first block returns the rooms' gold and the unspent budget and closes the level. Then each block washes out up to `sweepPerBlock` characters to camp. While the level is closed, its actions, extracts and gives are refused, and its pending rolls resolve as void. The block that finds the level empty starts the new season (`FloodBegan`, `FloodSwept`, `SeasonEnded`).
  - **Roll pruning:** a resolved roll is deleted 100 minutes after it resolves (12,000 blocks), the same as the beacons, so any roll still on chain can be verified. The sweep pages through `rollprune/{h}/{roll}`.
  - **Range reads:** the core can't start a range mid-prefix, and it stops an unlimited range at 5,000 entries (`fsm/state.go`). So every sweep reads a limited page from the front of its index, and each item it handles leaves that index.

### 7.5 State model (plugin-owned keys, length-prefixed, big-endian ints)

*As built in M2:* game records are **canonical JSON** (sorted keys) rather than the protobuf messages named below, because the engine's types are the schema. Core records stay protobuf. Extra indexes: `where/{level}/{room}/{standing|downed}/{lastActionHeight}/{char}` (room occupancy, so a room-wide exchange reads a reverse page of the most recently active), `roomcount/{level}/{room}` (headcount, so presence checks never scan the room), `active/{level}/{lastActionHeight}/{char}` (Ferryman recipients), `ferry/{h}/{char}`, `reserve/…` (take reservations), and `ledger` (gold the treasury owes). See `plugin/README.md`.

The plugin declares a **multi-byte** custom state prefix (`"abbey"`). Only single-byte prefixes 1–15 can collide with core prefixes (`lib/plugin.go` `CoreReservedPrefixMax`).

| Key | Value (protobuf) | Notes |
|---|---|---|
| `abbey/cfg` | `GameConfig{R, maxSweep, treasuryAddr, faucetAddr, paramsAuthority, shopPrices…}` | Set at genesis. Changes only via release + activation height |
| `abbey/params` | `Params{faucetEnabled, faucetAmount, faucetCooldownBlocks, faucetMaxPerAccount, faucetMaxPerBlock, fees{msgType→amount}, maxTxPerBlock, sweepPerBlock}` | Mutable via `set_params` (§6.6) |
| `abbey/faucet/{addr}` | `FaucetRecord{lastClaimHeight, totalClaimed}` | Tracked from day one so limits work the moment they're enabled |
| `abbey/levels/{levelId}` | `Level{contentHash, activationHeight, season, seasonStart, bossKilledAt, endsAt, budgetReserved, budgetPaid}` | Level registry |
| `abbey/beacon/{h}` | `bytes32` | Pruned after 100 minutes (12,000 blocks). Latest also at `abbey/beacon/latest` |
| `abbey/acct/{addr}` | `Account{stash[itemId], charIds[], nextNonce}` | Gold balance is the core account, not stored here |
| `abbey/char/{charId}` | `Character{owner, class, stats[6], hp, maxHp, ac, levelId, roomId, prevRoom, carriedGold, inventory[], statuses[], abilityUses, status, downedAt, lastActionHeight, pendingRollId, charFlags, xp, level, features[]}` | `charId = sha256(owner ‖ nonce)[:16]` |
| `abbey/room/{levelId}/{season}/{roomId}` | `RoomState{monsters[{templateId,hp,status}], flags, counters, goldPool, lootPile[itemId], corpseCaches[]}` | **The shared world** |
| `abbey/item/{itemId}` | `Item{templateId, location, charges}` | |
| `abbey/roll/{rollId}` | `PendingRoll{charId, action, args, commit, committedAt, expiresAt}` → `ResolvedRoll{…, s, dice[], outcome}` | |
| `abbey/expiry/{height}/{rollId}` | empty | Index for timeout sweeps |
| `abbey/lb/{levelId}/{season}/{addr}` | `Score{goldExtracted, kills, deepestRoom}` | Leaderboards |

Core keys written: treasury, faucet, and player accounts (prefix 1), only in the `extract`, shop/offering, and `faucet_claim` paths.

Determinism rules: no floats; `uint64` as `bigint` in TS; sort map-derived lists before encoding; checked arithmetic; a missing key decodes to zero/absent; the content pack is loaded from the plugin bundle, never from disk or network at runtime.

### 7.6 Transactions

Every tx is signed by the account owner. `CheckTx` returns `[owner]` as the authorized signer and does stateless/shape validation plus the fee check. State-dependent checks run in `DeliverTx` and are repeated at reveal.

| Message | Args | Effect |
|---|---|---|
| `create_character` | `name (≤24 ascii), class, commit` | Create char (status `Rolling`). Reveal → roll 6× 4d6-drop-lowest |
| `assign_stats` | `charId, permutation[6]` | Apply. Status `InCamp` |
| `enter_dungeon` | `charId` | Must be `InCamp`. Move to L1 room 1 |
| `act` | `charId, kind, actionId?, target?, itemId?, ability?, toLevel?, toRoom?, lootRef?, commit?` | One exchange: any engine intent (room action, attack, ability, item, move/flee, rest, take, stabilize). Must be legal. If the engine's `needsRoll` says no dice are involved (a plain move, a dice-free action), it resolves at once and must carry no commit. Otherwise a commit is required: lock char → pending roll. *(M2 folded the spec's separate `move`/`take`/`stabilize` messages into `act`; semantics unchanged)* |
| — `act` with `kind: take` | `lootRef` | Reserves `lootRef` at commit (a second `take` on it is rejected). Pending roll for the counterattack if hostiles. Released on forfeit |
| `reveal` | `rollId, secret` | Verify commit and resolve (§7.3) |
| `give` | `charId, toCharId, itemId \| gold` | Same room, both alive |
| — `act` with `kind: stabilize` | `target` (downed char id) | Same room, target downed for at most 2 minutes |
| `extract` | `charId` | Must be in L1 room 0. **Treasury → owner account transfer** of carried gold. Items go to stash, full heal |
| `shop_buy` | `charId, templateId, qty` | In camp. **Owner account → treasury**, create items |
| `shop_sell` | `charId, itemId` | In camp. Item must have a sale price. **Treasury → owner account**, counted against the source level's budget. Item destroyed |
| `stash_move` | `charId, itemId, direction` | In camp |
| `party_set` | `charId, with` (a char id, or empty to leave) | Join `with`'s party (§3.6): `with` stands in the same place, or is one of the signer's own characters; the party has room. Empty: leave |
| `faucet_claim` | — | **Zero fee.** Faucet → signer, subject to `abbey/params` limits (§6.6) |
| `set_params` | `Params` (partial) | Signer must be `paramsAuthority`. Faucet params and fee amounts only |

Sending gold between players uses the core `send` transaction, not a game message. **The plugin must not list `send` in `supported_transactions`.** The TS template does list it, and if left in, the plugin's own send would replace the core's (`fsm/transaction.go` routes any plugin-supported message type to the plugin).

**Anti-spam:** one pending roll per character, 5 living characters per account, chain fees, plus faucet limits that can be switched on (§6.6).

### 7.7 Events

`CharacterCreated`, `StatsRolled`, `ActionCommitted`, `ActionResolved{rollId, charId, levelId, roomId, actionId, dice[], modifiers, dc/ac, outcomeId, deltas, seedInputs}`, `ActionFizzled`, `ActionForfeited`, `RoomChanged{levelId, roomId, flagsDiff}`, `CharacterDowned`, `CharacterFerried{charId, roomId, kept, shares[], toCache}`, `GoldExtracted`, `GoldSpent`, `ItemMoved`, `BellTolled`, `LevelActivated`, `SeasonEnded/Started{levelId}`.

### 7.8 Read-only plugin RPC

| Route | Returns |
|---|---|
| `/abbey/levels` | Level registry: active levels, content hashes, seasons |
| `/abbey/world/{levelId}` | All room states for a level |
| `/abbey/room/{levelId}/{roomId}` | Room state + characters present |
| `/abbey/character/{id}` · `/abbey/account/{addr}` | Character/account (stash, characters) |
| `/abbey/roll/{rollId}` | Pending or resolved roll with seed inputs |
| `/abbey/beacon/{height}` | Beacon value (verification) |
| `/abbey/treasury` | Treasury balance, reserved budgets, outstanding carried gold |
| `/abbey/params` · `/abbey/faucet/{addr}` | Current params, faucet balance and claim rate, an account's claim record |
| `/abbey/options?char=` | *(M2)* Every legal intent for a character right now, with exact odds and whether it needs commit-reveal |
| `/abbey/stats?blocks=` | *(M2)* Liveness numbers to watch: game txs in recent blocks against `maxTxPerBlock`, forfeit and ferry backlogs, characters per level and the busiest rooms. Watch it alongside the node's proposal-build time (logged as "Validating mempool…" to "Done checking mempool"), which must stay well under the propose window |
| `/abbey/leaderboard/{levelId}/{season}` | Top extractors, boss killers *(not built yet: M4)* |
| `/abbey/feed?fromHeight=` | Recent `ActionResolved` events (the "dungeon chatter" log). *M2:* served by the core's `events-by-height` / `events-by-address`, since plugin events (`abbey.*`, payload `AbbeyEvent{kind, data}`) are indexed by the core |

All routes accept an explicit `height` for consistent snapshots. *M2 routes take query parameters* (`/abbey/room?level=1&room=2`, `/abbey/character?id=`, `/abbey/roll?id=`, `/abbey/beacon?at=`).

---

## 8. Client (text UI)

- **Terminal aesthetic:** monospaced room text, numbered choices with odds, typed-out narration, and an ASCII map per level that reveals rooms you've visited and shows chalk marks other players left.
- **Roll theatre:** "sealed at block X → revealing at X+1", with a dice animation that **lands on the real value**. Every result has a "verify roll ▸" link.
- **Auto-reveal:** the client keeps per-action secrets in memory (and in encrypted session storage, so a page reload can still reveal before timeout), sends `reveal` as soon as the commit block is final, and warns if the tab closes with a pending reveal.
- **Shared-world presence:** a live feed of other players' actions, the other characters in your room, and monster HP bars that move when others fight.
- **Wallet:** canopy-ts keystore with encrypted storage. Decrypted keys are short-lived and never logged. Shows the gold balance (the native token) and carried gold separately.
- **Pending-tx tracking:** submit to a pinned node, then track the roll route. Show "tx confirmed" separately from "roll resolved". M0 lessons: `tx-by-hash` also returns mempool txs stamped with the *next* height, so a tx is committed only once `tx.height < /v1/query/height`. Per-tx polling from many clients overloads a single node's RPC, so use a push channel and keep read traffic off validators.
- **Canonical encoding:** drop proto3 default values (0, empty) before encoding the message and tx for signing. protobufjs encodes explicit zeros and Go doesn't, which makes signatures invalid (found in M0).
- *As built in M3b:* a browser client on the same library (`npm run web`). Passkey sign-in (decision 11); the key and the roll secrets live in IndexedDB, encrypted under a non-extractable WebCrypto key; screens redraw every block from chain state. The plugin's read endpoint now sends CORS headers.
- *As built in M3* ([client/](client)): a terminal client on a library meant to sit under a later web client. Its vault holds the key and the per-roll secrets, encrypted with scrypt and AES-GCM, in place of the browser's encrypted session storage. Every action is confirmed from committed plugin state. Reads are polled, not pushed. See [client/M3-REPORT.md](client/M3-REPORT.md).

---

## 9. Testing & validation

1. **`@abbey/rules` unit tests:** dice golden vectors, rejection-sampling distribution, every effect op and condition, every class ability, forfeit outcome ≤ every real outcome (property test).
2. **Content linter** (CI gate for every level pack): reachability, ID references, DC ladder, budget fit, no orphan rooms. Also checks that existing opcodes keep their meaning: a fixture replay of every older level must stay byte-identical.
3. **Balance simulator:** 10k simulated delves per class and party size (1–4) per level. Level 1 targets: solo boss kill ~25%, 3-player party ~65%, average gold extracted per survivor ~150g. Treasury runway is simulated at 1/10/100 daily players.
   - **The M1 model:** scripted bots run one *expedition* per party: one season, up to 3 trips, extracting between trips to heal, with 2 potions bought per trip. Monsters stay dead between trips, as the season rules say. A ferried character keeps playing on later trips. The bots never retreat from a fight once committed, so ferry rates read high.
   - **M1 results at N=2000, with the Ferryman:** solo boss kill 26.5% (fighter 30%, wizard 29%, cleric 28%, rogue 18%), party of 3 at 67.5%, and 141g extracted per party-of-3 member. The toll averages 16–37g per expedition. See `rules/M1-REPORT.md`.
   - Treasury runway simulation is not built yet; it's deferred to M4.
4. **Plugin tests:** success, wrong signer, malformed msg, bad reveal, late reveal → forfeit, Ferryman at 21 blocks downed (toll split to active same-level accounts only, own account excluded, cache fallback), faucet claim from a zero-balance account, each faucet limit enforced once enabled, `set_params` rejected for non-authority signers and for non-whitelisted fields, locked character, illegal move, wrong `actionNonce`, loot race (second `take` rejected while reserved, reservation released on forfeit), fizzle when the target dies between commit and reveal, return stairs open after a level-1 reset, `shop_sell` budget accounting, sealed stairs before activation, level activation at height, season reset per level, treasury invariant, restart persistence, historical queries.
5. **Determinism:** replay a recorded block sequence through two plugin processes and require byte-identical writes. Also run nodes on release N and N+1 across a level's `activationHeight` with no divergence before it.
6. **Localnet playtest:** 4 players on a local nested-chain setup with 6s blocks, one full season.

---

## 10. Milestones

| # | Milestone | Exit criteria |
|---|---|---|
| **M0** ✅ | **Spike (de-risk)** — done 2026-11-04, see [spike/M0-REPORT.md](spike/M0-REPORT.md) | Nested-chain localnet with the TS plugin. Async EndBlock with state I/O working. **6s blocks sustained** with the tuned timeouts under synthetic load. Treasury account transfers from the plugin. Plugin-side fee collection working, **including zero-fee `faucet_claim`** (source says the core leaves plugin-message fees to the plugin; confirm end to end). `send` removed from the plugin's supported txs, with core `send` still working |
| **M1** ✅ | **Rules engine + level 1 content**: done 2026-11-04, see [rules/M1-REPORT.md](rules/M1-REPORT.md) | Data-driven engine, linter, simulator, tests green, tuned numbers |
| **M2** ✅ | **Plugin**: done 2026-11-05, including bounded block work (§7.4, §12 Q7). See [plugin/M2-REPORT.md](plugin/M2-REPORT.md) | All txs, commit-reveal, beacon, treasury, level registry, events, RPC, test suite |
| **M3** ✅ | **Client**: done 2026-11-05 as a terminal app on a reusable library. See [client/M3-REPORT.md](client/M3-REPORT.md) | Playable end-to-end text UI with auto-reveal and roll verification |
| **M3b** ✅ | **Browser client**: done 2026-11-05 on the same library; passkey sign-in confirmed on a real device. See [client/M3-REPORT.md](client/M3-REPORT.md) | The full game in a browser, with passkey sign-in (decision 11), silent signing, and reveal across reloads |
| M4 | Multiplayer & seasons | Shared feed, left-behind caches and the Ferryman toll split, season reset, 4-player localnet playtest |
| M5 | Level-2 dry run | Author a stub level 2 and ship it via `activationHeight` on the localnet to prove the extension path, without shipping it to players |

---

## 11. Decisions (from v0.1 open questions)

| # | Question | Decision |
|---|---|---|
| 1 | Block time | **Target 6s blocks.** Requires tuned consensus timeouts on all validators (§7.2). Actions resolve in about 2 blocks (6–12s) because commit-reveal needs one block between commit and reveal |
| 2 | EndBlock state I/O | **Supported by the core.** The TS template needs its EndBlock made async (§7.4). The design also moved roll resolution into the reveal tx, so EndBlock only does light sweeps. No crank tx is needed |
| 3 | Deployment | **Dedicated nested chain**, with gold as its native token |
| 4 | Core PR to expose block hash/VDF | **Not needed for MVP. Optional later.** See the tradeoff below |
| 5 | Gold value | **Real value: the native currency and staking token.** Drives the treasury model (§6) and makes commit-reveal mandatory (§7.3) |
| 6 | Staking (v0.2 Q1) | **Nested now, gold later.** CNPY root-chain validators at launch, graduating to gold staking via `rootChainID` governance (§6.5) |
| 7 | Onboarding (v0.2 Q2) | **Free, unthrottled faucet** from its own allocation, with limits switchable via `set_params` (§6.6) |
| 8 | Genesis (v0.2 Q3) | **40% to the Abbey Treasury.** The rest is a proposal (§6.7) |
| 9 | Treasury governance (v0.2 Q4) | **Fixed in the plugin. Changes via governance vote + release with activation height.** No admin key over funds (§6.8) |
| 10 | Fees on failed transactions (M2) | **Match the core: a failed tx is free and never enters a block.** The core rolls back every write of a failed tx (its own `send` included) and leaves it out of the block. So that bad txs are refused at submission rather than re-run from the mempool, the plugin's CheckTx runs the real handler as a dry run against a scratch view of state that is never written. Soft-fail with a fee was rejected because it would make honest players pay for lost races and put rejected txs in blocks |
| 11 | Browser sign-in (M3b) | **Passkeys.** The account key is derived from the passkey's PRF output (`HKDF(prf, "abbey.bls.v1")` mod r, with the PRF salt fixed forever), so one Face ID or Touch ID tap signs in on any device the passkey syncs to: no password, seed phrase or key server. Every move is then signed in the page with no prompts. Browsers without PRF fall back to a key kept on that device. **Constraints:** a passkey belongs to its domain, so pick the final domain before real players sign up. A passkey from another ecosystem (say Windows Hello) derives a different account; wrapping one random key under several passkeys can come later. Session keys come in once gold has value |

**Tradeoff for #4.** Canopy blocks contain a hash and a VDF output (`lib/.proto/block.proto`), but plugins don't receive them. Exposing them would take a small upstream change to `PluginBeginRequest` and `fsm/automatic.go`.

- *Benefit:* a stronger beacon. The VDF output in particular is expensive to grind. It would let rolls with no owner (e.g. season-wide events) be safe without commit-reveal.
- *Cost:* it depends on upstream review and a Canopy core release. Our chain would have to run that core version, which couples our schedule to theirs. It also **doesn't stop a proposer from withholding a block**, so for player rolls it doesn't replace commit-reveal.
- *Recommendation:* ship on commit-reveal, which is secure without core changes. Open a low-priority upstream issue/PR as defense-in-depth, and adopt it in the beacon later via a level-style activation height if it lands.

---

## 12. Open questions

1. **Committee size and geography** for sustaining 6s blocks with multiple validators. (M0 showed that a 20s root chain doesn't cap a 6s nested chain, with one validator.)
7. **Liveness under load (from M2). Resolved for the plugin 2026-11-05;** the core-side items are drafted in `plugin/UPSTREAM-NOTES.md`. History: nothing bounded a block's work. At 6s blocks, 100 game txs per block were fine, but 200 stalled the chain. Retesting at 10s blocks, 200 stalled it too. The limiting phases (PROPOSE, PROPOSE_VOTE) scale with block time, so longer blocks raise txs per block but not txs per second (roughly 15 game txs/s either way). The levers are per-tx cost (~12ms in DeliverTx) and a per-block bound. Separately, EndBlock sweeps (forfeits, ferries, the season flood) aren't capped either (`MAX_SWEEP_PER_BLOCK`, §7.4). How should the plugin bound the work per block? See `plugin/M2-REPORT.md`, finding 6. *Update:* most of the stall was crowding. Actions now load only the room-mates they can affect, and idle characters lie low (§3.3). With that, 300 players at 300 tx/block run at 5.98s mean with 0 failures (findings 7–8). The per-block cap (`maxTxPerBlock`) and bounded sweeps are built (finding 9). But overload showed that the chain wedges for good once building a full block exceeds the propose window, and per-tx cost still grows with room occupancy (each action reads the room's whole occupancy index). *Update 2:* every read an action makes is now bounded, whatever the room's crowd (finding 10). The cap's default is 150, with `/abbey/stats` to watch it. Upstream, it's still worth raising that proposals should be built from a bounded mempool prefix and that nested rounds should survive root blocks.
8. **Fast blocks (from the PR #648 trial).**
   - *Done:* the game's timers are in seconds and keep their original durations at 500ms blocks; the balance sim is unchanged (§7.2).
   - The dice beacon can be tuned by any single block's proposer through its choice of txs; predictable proposers make player–validator collusion easy to arrange (§7.3). A plugin-side change can't fix it: using a later block's beacon just moves the target. Ask Canopy for unbiasable per-block randomness for plugins (`plugin/UPSTREAM-NOTES.md`, item 4). Before others run validators with real value, either that exists or the residual risk is accepted with monitoring (outlier detection on roll luck per player and per proposer).
   - Decide when to depend on the PR: it's unmerged, and every validator must opt in. See `spike/FAST-BLOCKS-REPORT.md`.
6. **Operational hardening from M0:** a node exits when its plugin dies, so production needs a process supervisor. The TS plugin uses host-global `/tmp/plugin` paths, so it's one plugin per host or container. The node's default config exposes admin RPC on all interfaces and enables auto-update. The deployment runbook needs to cover all of this (spike/M0-REPORT.md, findings 6–7).
2. **The non-treasury 60% of genesis.** Confirm or change the proposed faucet / validator incentives / liquidity / team split (§6.7), and the team vesting schedule.
3. **Params authority.** Who signs `set_params` at launch (e.g. a 2-of-3 team multisig), and when does it move to chain governance?
4. **Graduation criteria** for gold staking (§6.5): thresholds and who decides. Confirm the `rootChainID` switch procedure with Canopy maintainers.
5. **How the 20% validator-incentive allocation is paid.** In Phase 1, consensus rewards come from the root chain's committee rewards in CNPY. Paying gold to our committee needs its own mechanism: a vesting distribution account, or a plugin EndBlock payout to the block proposer. That isn't designed yet.

---

*Rules adapted from the System Reference Document 5.1 by Wizards of the Coast LLC, licensed under CC-BY-4.0. The Drowned Abbey setting, rooms, and text are original.*
