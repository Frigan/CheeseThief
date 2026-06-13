// Cheese Thief game engine — pure logic, kept separate from socket wiring.
// See docs/GAME_PLAN.md for the rules and the "shared-dice-hour" digitisation.

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

// Create a fresh game state for the given members ([{ id, name }]).
function startGame(members, config = {}) {
  const ids = members.map(m => m.id);
  const cfg = Object.assign(
    { discussionSeconds: 90, tieEscapes: true, fallMouse: false },
    config
  );

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
    followerId: null,
    witnesses: [],         // everyone (incl. Fall Mouse) who saw the theft
    followerCandidates: [], // witnesses eligible to be the thief's follower
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

  // Anyone (Sleepyhead or Fall Mouse) awake at the thief's hour sees the theft.
  state.witnesses = ids.filter(id =>
    id !== state.thiefId && state.dice[id] === thiefHour
  );
  // Any witness — including the Fall Mouse — can be picked as the thief's follower.
  // (The Fall Mouse still only ever wins alone, by most votes; see resolveVote.)
  state.followerCandidates = state.witnesses.slice();

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

  // Exactly one eligible witness → automatically the follower.
  if (state.followerCandidates.length === 1) {
    state.followerId = state.followerCandidates[0];
  }
}

// The private slice of state a single player is allowed to see.
function secretFor(state, id) {
  const isThief = id === state.thiefId;
  const isWitness = state.witnesses.includes(id);
  return {
    role: state.roles[id],
    isFallMouse: id === state.fallMouseId,
    hour: state.dice[id],
    cheesePresent: state.cheesePresent[id],
    isWitness,
    knownThiefId: isThief || isWitness ? state.thiefId : null,
    awakeWith: isThief ? state.witnesses : [],
    canPeek: state.soloEligible.includes(id) && !isThief && !state.peeks[id],
    peekResult: state.peeks[id]
      ? { targetId: state.peeks[id], hour: state.dice[state.peeks[id]] }
      : null,
    isFollower: state.followerId === id,
    followerId: isThief ? state.followerId : null,
    needsFollowerChoice: isThief && state.followerCandidates.length > 1 && !state.followerId,
    witnessCandidates: isThief ? state.followerCandidates : [],
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

// The thief picks their follower among eligible witnesses.
function chooseFollower(state, thiefId, targetId) {
  if (thiefId !== state.thiefId) return false;
  if (!state.followerCandidates.includes(targetId)) return false;
  state.followerId = targetId;
  return true;
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
  state.soloEligible = state.soloEligible.filter(x => x !== id);
  state.acked = state.acked.filter(x => x !== id);
  if (state.followerId === id) state.followerId = null;
  if (state.fallMouseId === id) state.fallMouseId = null;
  // Votes that pointed at the departed player are dropped too.
  Object.keys(state.votes).forEach(v => { if (state.votes[v] === id) delete state.votes[v]; });
}

// Tally votes and resolve. Win priority: Fall Mouse (sole most-voted) > Sleepyheads
// (sole plurality on the thief) > Thief. The Fall Mouse wins ALONE — even if she was
// the thief's chosen follower — and no one else wins with her.
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

  const soleTop = max > 0 && top.length === 1 ? top[0] : null;

  let winners;
  if (state.fallMouseId && soleTop === state.fallMouseId) {
    winners = 'fallMouse';
  } else if (soleTop === state.thiefId) {
    winners = 'sleepyheads';
  } else {
    winners = 'thief';
  }

  state.result = {
    winners,
    tally,
    accused: top,
    thiefId: state.thiefId,
    followerId: state.followerId,
    fallMouseId: state.fallMouseId,
  };
  return state.result;
}

module.exports = {
  startGame,
  secretFor,
  applyPeek,
  chooseFollower,
  castVote,
  removeParticipant,
  resolveVote,
};
