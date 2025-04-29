// segmentsManager.js

const segments = {};

function addSegment(matchId, segmentInfo) {
  if (!segments[matchId]) {
    segments[matchId] = [];
  }
  segments[matchId].push(segmentInfo);
}

function getSegments(matchId) {
  return segments[matchId] || [];
}

function clearSegments(matchId) {
  delete segments[matchId];
}

module.exports = {
  addSegment,
  getSegments,
  clearSegments,
};
