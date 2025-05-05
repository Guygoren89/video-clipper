// segmentsManager.js

const segments = {};

// הוספת מקטע חדש למשחק
function addSegment(matchId, segmentInfo) {
  if (!segments[matchId]) {
    segments[matchId] = [];
  }

  // אם כבר קיים segmentNumber כזה - מחליפים
  const existingIndex = segments[matchId].findIndex(
    s => s.segmentNumber === segmentInfo.segmentNumber
  );
  if (existingIndex !== -1) {
    segments[matchId][existingIndex] = segmentInfo;
  } else {
    segments[matchId].push(segmentInfo);
  }
}

// החזרת רשימת מקטעים
function getSegments(matchId) {
  return segments[matchId] || [];
}

// מחיקת מקטעים שלמים למשחק
function clearSegments(matchId) {
  delete segments[matchId];
}

// חיפוש מקטע לפי זמן מוחלט
function findSegmentByTime(matchId, absoluteTime) {
  const all = segments[matchId] || [];
  return all.find(s => absoluteTime >= s.startTime && absoluteTime < s.endTime);
}

// חיפוש מקטע לפי מספר מקטע
function getSegmentByNumber(matchId, segmentNumber) {
  const all = segments[matchId] || [];
  return all.find(s => s.segmentNumber === segmentNumber);
}

module.exports = {
  addSegment,
  getSegments,
  clearSegments,
  findSegmentByTime,
  getSegmentByNumber,
};
