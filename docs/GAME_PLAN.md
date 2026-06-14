# Cheese Thief — Game Implementation Plan

This document plans how to layer the **Cheese Thief** board game rules onto the
existing room/table platform (Express + Socket.io + vanilla JS single page).
It is the durable reference for building the game; update it as decisions change.

---

## 1. The Game (rules summary)

Cheese Thief is a fast 4–8 player social-deduction / bluffing game (~10 min).
Most players are **Sleepyheads**; exactly **one** is the **Cheese Thief**. Overnight
the Thief steals the breakfast cheese. By morning the Sleepyheads must deduce who
took it.

**Physical flow (what we are digitising):**
1. **Roles:** Deal (players − 1) Sleepyhead cards + 1 Cheese Thief card, one per
   player, face down. Each player secretly learns their role.
2. **Wake-up hour:** Every player rolls a die (**1–6**) under a cup and secretly
   peeks. That number is the hour they wake during the night.
3. **Night phase:** A narrator/app counts the hours **1 → 6**. At each hour, the
   players who rolled that number "wake" (open eyes); everyone else "sleeps".
   - When the **Thief's** hour is called, the Thief takes and hides the cheese.
   - Any **Sleepyhead awake at the same hour as the Thief** witnesses the theft and
     becomes the Thief's **Follower** (if several witness, the Thief picks one).
   - A Sleepyhead who is **alone** at their hour may **peek** at one other player's
     die (learning that player's hour).
4. **Day / discussion:** Players give accounts of what hour they woke and whether
   the cheese was still present. Lying is allowed (Thief & Followers bluff).
5. **Vote:** Everyone points at the player they suspect. 
6. **Win:**
   - **Sleepyheads win** if the group correctly identifies the Thief.
   - **Thief + Follower(s) win** if the Sleepyheads fail.

**Key digitisation decision — "awake at the same time":** In physical play two
players are awake together iff they rolled the **same hour**. We adopt this exactly:
- *Witness/Follower:* a Sleepyhead who rolled the **same number as the Thief** sees
  the theft.
- *Peek:* a Sleepyhead who is the **only** player with their rolled number may peek.
- *Cheese-present info (genuine deduction signal):* the Thief takes the cheese **at**
  their hour. So a player who woke **before** the Thief's hour saw cheese; **at** the
  same hour saw it taken; **after** saw it already gone. The app can truthfully tell
  each player "the cheese was / was not there when you woke" — this is the one piece
  of hard information the game leaks.

**Followers scale with player count (implemented):** witnessing the theft always
leaks the thief's identity to that player, but *follower* membership is determined by
count:
- **≤5 players — witness mode:** one follower drawn from the witnesses. A lone witness
  joins automatically; if several witnessed, the thief picks one before discussion.
- **6 players:** after the night, the thief recruits **1** follower (any player); that
  follower learns the thief.
- **7 players:** the thief recruits **2** followers (any players); they know **each
  other** but **not** the thief (unless one independently witnessed the theft).
- **8 players:** the thief recruits **2** followers (any players); they know the thief
  **and** each other.
The thief makes these choices on their Night card; any slots left unpicked are
auto-filled at random when the round advances to discussion.

**Fall Mouse (optional role, implemented):** a Tanner/Fool-style role the host can
toggle on before the round, **only in 6-8 player games**. She replaces one Sleepyhead
card and plays exactly like a Sleepyhead (rolls a die, can witness, can peek, and *can*
be chosen as the thief's follower) but **wins by receiving the most votes**. She **wins
alone** — even if she was the thief's follower — and **no one else wins with her**. A
Fall Mouse who is a follower but does *not* draw the most votes simply loses.

**Vote resolution & ties (implemented):** win priority is **Fall Mouse > Sleepyheads >
Thief + followers**, and ties resolve by membership of the top-voted set, not by sole
plurality:
- If the **Fall Mouse** is among the most-voted (even tied with the thief) → Fall Mouse
  wins alone.
- Else if the **Thief** is among the most-voted (even tied) → the thief is revealed and
  the **Sleepyheads** win.
- Else → the **Thief and followers** escape and win.

---

## 2. How it maps onto the current platform

Already built and reusable:
- Room lifecycle, 4-letter codes, join/leave, admin (creator) with ⭐.
- Circular table with silhouettes + names, live `room_update` sync.
- Admin controls (randomise seats, kick).

What the game adds: a **game state machine** running inside a room, per-player
**private** information channels (role, die, night results), and timed phases.

The admin becomes the **host** who starts the game and advances phases.

---

## 3. Server data model (extend `rooms[code]`)

```
rooms[code] = {
  admin, members: [{ id, name, seat }],     // existing
  game: null | {
    phase: 'lobby'|'roleReveal'|'night'|'discussion'|'voting'|'results',
    thiefId,                                 // socket id of the Thief
    roles:   { [id]: 'thief'|'sleepyhead' },
    dice:    { [id]: 1..6 },                 // secret wake-up hour
    followerId | followerIds: [],            // chosen follower(s)
    witnesses: [id...],                      // sleepyheads sharing thief's hour
    peeks:   { [id]: targetId },             // who each solo sleepyhead peeked
    cheesePresent: { [id]: bool },           // derived per player
    votes:   { [id]: targetId },
    config:  { discussionSeconds, followerVariant },
    result:  null | { winners:'sleepyheads'|'thief', tally, thiefId, followerIds }
  }
}
```

All secret fields are **never** broadcast wholesale. Each client receives only its
own slice via a private `your_secret` event; public state (phase, who has voted,
timer, results) goes through the existing room channel.

---

## 4. Server game engine (new module `game.js`)

Pure functions + a controller, kept separate from socket wiring for testability.

- `assignRoles(members)` → pick random Thief, rest Sleepyheads.
- `rollDice(members)` → random 1–6 per player.
- `computeNight(state)` → derive, from `dice` + `thiefId`:
  - `witnesses` = sleepyheads whose die === thief's die.
  - solo sleepyheads (unique die) eligible to peek.
  - `cheesePresent[id]` = `dice[id] < dice[thiefId]` (woke before theft) → true;
    `=== ` → "saw it taken"; `>` → false.
- `resolveVote(state)` → most-voted player; Sleepyheads win iff plurality target
  === `thiefId` (define tie-break: tie = Thief escapes / Sleepyheads lose).
- Phase transition guards (only host can advance; validate player count 4–8).

Validation: refuse `start_game` if <4 or >8 members; lock joins once a game is in
progress (or queue late joiners as spectators until next round).

---

## 5. New Socket.io events

**Client → server**
- `start_game` (host) — assign roles + dice, go to `roleReveal`.
- `ack_role` — player has seen their role (host sees ready count).
- `begin_night` (host) — run `computeNight`, push private night results.
- `peek_player {targetId}` — solo sleepyhead spends their one peek.
- `choose_follower {targetId}` — Thief picks follower when multiple witnesses.
- `begin_discussion` / discussion timer auto-advances to `voting`.
- `cast_vote {targetId}` — one vote per player; changeable until tally.
- `end_game` / `play_again` (host) — reset `game` to null / new round.

**Server → client**
- `your_secret { role, hour, cheesePresent, witnessInfo, peekResult }` — private.
- `game_update { phase, readyCount, votedIds, timerEndsAt, result }` — public.
- `prompt_choose_follower { candidateIds }` — to the Thief only.
- existing `room_update` continues for membership/seating.

Security: server is authoritative. Never send another player's role/die to a client
except as the explicit, rules-sanctioned reveal (witness sees Thief; peek reveals one
die; final results reveal Thief + followers).

---

## 6. Client UI (extend `public/index.html`)

Add screens layered over the existing table; reuse styling tokens/CSS vars.

1. **Pre-game (in room):** host sees **Start Game** (enabled only at 4–8 players);
   others see "waiting for host". Show player count requirement. Players sit around the
   table as **mice** (4 silhouette styles, coloured by seat) with bold names; the admin
   has a ⭐. A **Session Scores** panel ranks players by points won this session (+1 to
   each winner per round), highlights the leader (👑), and offers the host a **Reset**.
2. **Role reveal:** full-screen card flip — "🧀 You are the **Cheese Thief**" or
   "😴 You are a **Sleepyhead**". Tap to dismiss → `ack_role`.
3. **Night phase:** a clock window ticks **01:00 → 06:00** with a ~3.5s pause between
   each hour. A player's private information is revealed **only when their own hour is
   called** ("the cheese was / wasn't there", witness knowledge, follower status).
   - Solo sleepyhead's one-time **Peek** unlocks at their hour.
   - Thief recruitment resolves at the thief's hour (witness mode, ≤5 players) or at
     **dawn** after 06:00 (choose mode, 6-8 players).
   - The host's **Proceed to Discussion** appears only once dawn breaks.
4. **Discussion:** countdown timer (host-configurable, default 90s) + reminder of
   own private info; table highlights whose turn (optional speaking order).
5. **Voting:** click a silhouette to point at them; live "X / N voted" indicator;
   finger/arrow markers appear on the table.
6. **Results:** reveal Thief (⭐🧀) + Follower(s), vote tally, and the winning side
   banner. Host gets **Play Again** (re-randomise seats optional).

Keep all private info on the player's own device only — mirrors the "secret peek"
of the physical game.

---

## 7. Game state machine (phases)

```
lobby ──start_game──▶ roleReveal ──begin_night──▶ night
  ▲                                                  │
  │ play_again                              (followers/peeks resolved)
  │                                                  ▼
results ◀──tally──── voting ◀──timer──── discussion
```

Host drives forward transitions; server enforces preconditions and timers.

---

## 8. Edge cases & decisions

- **Player count:** enforce 4–8; block start otherwise.
- **Disconnect mid-game:** keep their seat/role for a grace period; if the Thief
  disconnects, host may abort round. If a voter drops, count remaining votes.
- **Admin/host leaves:** existing auto-promote applies; new host inherits game
  controls.
- **Late joiners:** spectate until the round ends, then join next round.
- **Tie vote:** resolved by top-voted membership (see "Vote resolution & ties" in §1)
  — thief in the top set → Sleepyheads win; Fall Mouse in the top set → Fall Mouse wins.
- **No witnesses / not enough recruits:** ≤5 with no witness → no follower (valid);
  6-8 follower slots the thief leaves empty are auto-filled at random.
- **Follower count by players:** 1 (≤6) or 2 (7-8); see §1 "Followers scale with
  player count".
- **Anti-cheat:** authoritative server; never trust client-sent roles/dice/results.

---

## 9. Build milestones

1. **M1 — Engine core (headless):** `game.js` with role/dice assignment, night
   computation, vote resolution + unit tests. No UI.
2. **M2 — Server wiring:** new socket events, authoritative state, private channels,
   phase guards. Test with two browser tabs.
3. **M3 — Client flow:** role reveal → night → discussion → voting → results screens.
4. **M4 — Polish:** timers, animations (hour counter, finger-points, card flip),
   follower-pick & peek modals, play-again reset.
5. **M5 — Variants & robustness:** ✅ Fall Mouse role (host toggle), player-count
   follower scaling (witness mode ≤5; thief recruitment of 1/2 followers for 6/7/8 with
   per-count knowledge), tie-break rules, spectators for mid-round joiners, graceful
   disconnect/kick handling (drop non-essential players, abort only on losing the thief
   or dropping below 4), host-configurable discussion timer (1.5/2/3/4/5 min).

Each milestone: commit with a clean message and push to
`https://github.com/Frigan/CheeseThief` (per project workflow).

---

## 10. Sources

- [Cheese Thief — Shut Up & Sit Down](https://www.shutupandsitdown.com/games/cheese-thief/)
- [Cheese Thief — Board's Eye View](https://www.boardseyeview.net/post/cheese-thief)
- [Cheese Thief — BoardGameGeek](https://boardgamegeek.com/boardgame/294175/cheese-thief)
- [Jolly Thinkers Cheese Thief — Amazon listing](https://www.amazon.com/Jolly-Thinkers-Bluffing-10-Minute-Playtime/dp/B0CHP2Z84P)
```
