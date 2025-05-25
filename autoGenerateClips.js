const { cutClipFromDriveFile } = require('./segmentsManager');

async function autoGenerateClips(fileId, clipTimestamps, matchId = `auto_match_${Date.now()}`, segments = []) {
  const results = [];

  for (const {
    start_time_in_segment,
    duration = 8,
    action_type = 'auto_clip',
    player_name = '',
    team_color = '',
    assist_player_name = ''
  } of clipTimestamps) {
    try {
      const needsPrevious = start_time_in_segment < 3; // 🟡 רק אם הפעולה מוקדמת מ־3 שניות
      let previousFileId = null;

      if (needsPrevious && segments.length > 0) {
        const currentSegment = segments.find(s => s.file_id === fileId);
        const currentIndex = segments.indexOf(currentSegment);
        const previousSegment = segments[currentIndex - 1];
        if (previousSegment) {
          previousFileId = previousSegment.file_id;
        }
      }

      const result = await cutClipFromDriveFile({
        fileId,
        previousFileId,
        startTimeInSec : start_time_in_segment,
        durationInSec  : duration,
        matchId,
        actionType     : action_type,
        playerName     : player_name,
        teamColor      : team_color,
        assistPlayerName: assist_player_name // ✅ תיקון מפתח שגוי: assistPlayer → assistPlayerName
      });

      results.push(result);
    } catch (err) {
      results.push({
        success: false,
        error  : err.message,
        start_time_in_segment
      });
    }
  }

  return results;
}

module.exports = { autoGenerateClips };
