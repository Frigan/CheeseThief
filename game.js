// Cheese Thief game engine — pure logic, kept separate from socket wiring.
// See docs/GAME_PLAN.md for the rules and the "shared-dice-hour" digitisation.

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

// Follower rules scale with player count:
//   <=5 : "witness" mode — 1 follower drawn from the players who saw the theft.
//    6  : thief recruits 1 follower (any player); that follower learns the thief.
//    7  : thief recruits 2 followers (any players); they know each other, not the thief.
//    8  : thief recruits 2 followers (any players); they know the thief AND each other.
function followerConfigFor(n) {
  if (n <= 5) return { mode: 'witness', count: 1, knowThief: true, knowEachOther: false };
  if (n === 6) return { mode: 'choose', count: 1, knowThief: true, knowEachOther: false };
  if (n === 7) return { mode: 'choose', count: 2, knowThief: false, knowEachOther: true };
  return { mode: 'choose', count: 2, knowThief: true, knowEachOther: true }; // 8
}

// How many followers the thief still needs in total, given who's present.
function requiredFollowerCount(state) {
  if (state.followerConfig.mode === 'witness') {
    return Math.min(1, state.witnesses.length);
  }
  const others = Object.keys(state.dice).length - 1;
  return Math.max(0, Math.min(state.followerConfig.count, others));
}

// Create a fresh game state for the given members ([{ id, name }]).
function startGame(members, config = {}) {
  const ids = members.map(m => m.id);
  const cfg = Object.assign({ discussionSeconds: 90, fallMouse: false }, config);

  const thiefId = pick(ids);

  // Optional Fall Mouse — a Tanner-style role that replaces one Sleepyhead and
  // wins (alone) by drawing the most votes. Only available in 6-8 player games.
  let fallMouseId = null;
  if (cfg.fallMouse && ids.length >= 6) {
    const others = ids.filter(id => id !== thiefId);
    fallMouseId = pick(others);
  }

  const roles = {};
  const dice = {};
  ids.forEach(id => {
    roles[id] = id === thiefId ? 'thief' : (id === fallMouseId ? 'fallMouse' : 'sleepyhead');
    dice[id] = rollDie();
  });

  const state = {
    phase: 'roleReveal',
    thiefId,
    fallMouseId,
    roles,
    dice,
    followerConfig: followerConfigFor(ids.length),
    followerIds: [],        // chosen / derived follower(s)
    followerCandidates: [], // who the thief may pick from
    witnesses: [],          // everyone (incl. Fall Mouse) who saw the theft
    soloEligible: [],
    peeks: {},
    cheesePresent: {},
    votes: {},
    acked: [],
    config: cfg,
    result: null,
  };

  computeNight(state, ids);
  return state;
}

// Derive witness / follower / peek eligibility and cheese visibility from the dice.
function computeNight(state, ids) {
  const thiefHour = state.dice[state.thiefId];

  const counts = {};
  ids.forEach(id => { counts[state.dice[id]] = (counts[state.dice[id]] || 0) + 1; });

  // Anyone (Sleepyhead or Fall Mouse) awake at the thief's hour sees the theft and
  // therefore always learns the thief's identity — independent of being a follower.
  state.witnesses = ids.filter(id =>
    id !== state.thiefId && state.dice[id] === thiefHour
  );

  // A player alone at their hour may peek one other player's die.
  state.soloEligible = ids.filter(id =>
    id !== state.thiefId && counts[state.dice[id]] === 1
  );

  // The thief takes the cheese AT their hour — the one genuine info signal.
  ids.forEach(id => {
    if (id === state.thiefId) {
      state.cheesePresent[id] = 'thief';
    } else if (state.dice[id] < thiefHour) {
      state.cheesePresent[id] = true;
    } else if (state.dice[id] === thiefHour) {
      state.cheesePresent[id] = 'taken';
    } else {
      state.cheesePresent[id] = false;
    }
  });

  // Follower setup.
  state.followerIds = [];
  if (state.followerConfig.mode === 'witness') {
    // Followers come from the witnesses; a lone witness joins automatically.
    state.followerCandidates = state.witnesses.slice();
    if (state.followerCandidates.length === 1) {
      state.followerIds = [state.followerCandidates[0]];
    }
  } else {
    // The thief recruits any other players in a phase after the night.
    state.followerCandidates = ids.filter(id => id !== state.thiefId);
  }
}

// The private slice of state a single player is allowed to see.
function secretFor(state, id) {
  const isThief = id === state.thiefId;
  const isWitness = state.witnesses.includes(id);
  const isFollower = state.followerIds.includes(id);
  const cfg = state.followerConfig;

  // A player knows the thief if they saw the theft, or if their follower role grants it.
  const knowsThiefViaFollower = isFollower && cfg.knowThief;
  const knownThiefId = (isThief || isWitness || knowsThiefViaFollower) ? state.thiefId : null;

  // Co-followers are visible only when the variant says followers know each other.
  const coFollowerIds = (isFollower && cfg.knowEachOther)
    ? state.followerIds.filter(x => x !== id)
    : [];

  const req = requiredFollowerCount(state);
  return {
    role: state.roles[id],
    isFallMouse: id === state.fallMouseId,
    hour: state.dice[id],
    cheesePresent: state.cheesePresent[id],
    isWitness,
    knownThiefId,
    awakeWith: isThief ? state.witnesses.slice() : [],
    canPeek: state.soloEligible.includes(id) && !isThief && !state.peeks[id],
    peekResult: state.peeks[id]
      ? { targetId: state.peeks[id], hour: state.dice[state.peeks[id]] }
      : null,
    isFollower,
    coFollowerIds,
    // Thief's recruitment UI:
    needsFollowerChoice: isThief && state.followerIds.length < req,
    followerCount: req,
    chooseFromAll: cfg.mode === 'choose',
    followersChosen: isThief ? state.followerIds.slice() : [],
    followerCandidates: isThief
      ? state.followerCandidates.filter(c => !state.followerIds.includes(c))
      : [],
  };
}

// A solo player spends their one peek on a target.
function applyPeek(state, peekerId, targetId) {
  if (!state.soloEligible.includes(peekerId)) return false;
  if (peekerId === state.thiefId) return false;
  if (state.peeks[peekerId]) return false;
  if (targetId === peekerId || !(targetId in state.dice)) return false;
  state.peeks[peekerId] = targetId;
  return true;
}

// The thief adds a follower (called once per pick until the required count is reached).
function chooseFollower(state, thiefId, targetId) {
  if (thiefId !== state.thiefId) return false;
  if (state.followerIds.length >= requiredFollowerCount(state)) return false;
  if (!state.followerCandidates.includes(targetId)) return false;
  if (state.followerIds.includes(targetId)) return false;
  if (targetId === state.thiefId) return false;
  state.followerIds.push(targetId);
  return true;
}

// Fill any follower slots the thief left empty (fallback when the round advances).
function autofillFollowers(state) {
  const req = requiredFollowerCount(state);
  const pool = state.followerCandidates.filter(id => !state.followerIds.includes(id));
  while (state.followerIds.length < req && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    state.followerIds.push(pool.splice(i, 1)[0]);
  }
}

function castVote(state, voterId, targetId) {
  if (!(voterId in state.dice) || !(targetId in state.dice)) return false;
  if (voterId === targetId) return false;
  state.votes[voterId] = targetId;
  return true;
}

// Remove a participant who left mid-round without ending the round.
function removeParticipant(state, id) {
  delete state.dice[id];
  delete state.roles[id];
  delete state.votes[id];
  delete state.peeks[id];
  state.witnesses = state.witnesses.filter(x => x !== id);
  state.followerCandidates = state.followerCandidates.filter(x => x !== id);
  state.followerIds = state.followerIds.filter(x => x !== id);
  state.soloEligible = state.soloEligible.filter(x => x !== id);
  state.acked = state.acked.filter(x => x !== id);
  if (state.fallMouseId === id) state.fallMouseId = null;
  // Votes that pointed at the departed player are dropped too.
  Object.keys(state.votes).forEach(v => { if (state.votes[v] === id) delete state.votes[v]; });
}

// Tally votes and resolve.
// Tie rules: the Fall Mouse wins ALONE if she is among the most-voted (even tied with
// the thief) — Fall Mouse always takes priority. Otherwise, if the thief is among the
// most-voted (even tied), the thief is revealed and the Sleepyheads win. Failing both,
// the thief and any followers escape and win.
function resolveVote(state, ids) {
  const tally = {};
  ids.forEach(id => { tally[id] = 0; });
  Object.values(state.votes).forEach(t => { if (t in tally) tally[t] += 1; });

  let max = -1;
  let top = [];
  ids.forEach(id => {
    const c = tally[id] || 0;
    if (c > max) { max = c; top = [id]; }
    else if (c === max) { top.push(id); }
  });

  const someoneVoted = max > 0;
  let winners;
  if (state.fallMouseId && someoneVoted && top.includes(state.fallMouseId)) {
    winners = 'fallMouse';
  } else if (someoneVoted && top.includes(state.thiefId)) {
    winners = 'sleepyheads';
  } else {
    winners = 'thief';
  }

  state.result = {
    winners,
    tally,
    accused: top,
    thiefId: state.thiefId,
    followerIds: state.followerIds.slice(),
    fallMouseId: state.fallMouseId,
  };
  return state.result;
}

module.exports = {
  startGame,
  secretFor,
  applyPeek,
  chooseFollower,
  autofillFollowers,
  castVote,
  removeParticipant,
  resolveVote,
};
