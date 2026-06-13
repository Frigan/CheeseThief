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
  const thiefId = pick(ids);
  const roles = {};
  const dice = {};
  ids.forEach(id => {
    roles[id] = id === thiefId ? 'thief' : 'sleepyhead';
    dice[id] = rollDie();
  });

  const state = {
    phase: 'roleReveal',
    thiefId,
    roles,
    dice,
    followerId: null,
    witnesses: [],
    soloEligible: [],
    peeks: {},          // { sleepyheadId: targetId }
    cheesePresent: {},  // derived per player
    votes: {},          // { voterId: targetId }
    acked: [],          // ids that have seen their role
    config: Object.assign({ discussionSeconds: 90, tieEscapes: true }, config),
    result: null,
  };

  computeNight(state, ids);
  return state;
}

// Derive witness / peek eligibility and per-player cheese visibility from the dice.
function computeNight(state, ids) {
  const thiefHour = state.dice[state.thiefId];

  const counts = {};
  ids.forEach(id => { counts[state.dice[id]] = (counts[state.dice[id]] || 0) + 1; });

  // Sleepyheads who rolled the thief's hour witness the theft (they know the thief).
  state.witnesses = ids.filter(id =>
    id !== state.thiefId &&
    state.roles[id] === 'sleepyhead' &&
    state.dice[id] === thiefHour
  );

  // A sleepyhead alone at their hour may peek one other player's die.
  state.soloEligible = ids.filter(id =>
    id !== state.thiefId && counts[state.dice[id]] === 1
  );

  // The thief takes the cheese AT their hour: earlier wakers saw it, same-hour saw
  // it taken, later wakers found it gone. This is the one genuine info signal.
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

  // Exactly one witness → that player is automatically the follower.
  if (state.witnesses.length === 1) {
    state.followerId = state.witnesses[0];
  }
}

// The private slice of state a single player is allowed to see.
function secretFor(state, id) {
  const isThief = id === state.thiefId;
  const isWitness = state.witnesses.includes(id);
  return {
    role: state.roles[id],
    hour: state.dice[id],
    cheesePresent: state.cheesePresent[id],
    isWitness,
    // The thief knows themselves; witnesses saw the thief take the cheese.
    knownThiefId: isThief || isWitness ? state.thiefId : null,
    awakeWith: isThief ? state.witnesses : [],
    canPeek: state.soloEligible.includes(id) && !isThief && !state.peeks[id],
    peekResult: state.peeks[id]
      ? { targetId: state.peeks[id], hour: state.dice[state.peeks[id]] }
      : null,
    isFollower: state.followerId === id,
    followerId: isThief ? state.followerId : null,
    needsFollowerChoice: isThief && state.witnesses.length > 1 && !state.followerId,
    witnessCandidates: isThief ? state.witnesses : [],
  };
}

// A solo sleepyhead spends their one peek on a target.
function applyPeek(state, peekerId, targetId) {
  if (!state.soloEligible.includes(peekerId)) return false;
  if (peekerId === state.thiefId) return false;
  if (state.peeks[peekerId]) return false;
  if (targetId === peekerId || !(targetId in state.dice)) return false;
  state.peeks[peekerId] = targetId;
  return true;
}

// The thief picks their follower among witnesses.
function chooseFollower(state, thiefId, targetId) {
  if (thiefId !== state.thiefId) return false;
  if (!state.witnesses.includes(targetId)) return false;
  state.followerId = targetId;
  return true;
}

function castVote(state, voterId, targetId) {
  if (!(voterId in state.dice) || !(targetId in state.dice)) return false;
  if (voterId === targetId) return false; // can't point at yourself
  state.votes[voterId] = targetId;
  return true;
}

// Tally votes; sleepyheads win only on a clear, single plurality landing on the thief.
function resolveVote(state, ids) {
  const tally = {};
  ids.forEach(id => { tally[id] = 0; });
  Object.values(state.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });

  let max = -1;
  let top = [];
  ids.forEach(id => {
    const c = tally[id] || 0;
    if (c > max) { max = c; top = [id]; }
    else if (c === max) { top.push(id); }
  });

  const caught = max > 0 && top.length === 1 && top[0] === state.thiefId;
  const winners = caught ? 'sleepyheads' : 'thief';

  state.result = {
    winners,
    tally,
    accused: top,
    thiefId: state.thiefId,
    followerId: state.followerId,
  };
  return state.result;
}

module.exports = {
  startGame,
  secretFor,
  applyPeek,
  chooseFollower,
  castVote,
  resolveVote,
};
