const { cutClipFromDriveFile } = require('./segmentsManager');

async function autoGenerateClips(actions = [], matchId = `auto_match_${Date.now()}`, segments = []) {
  const results = [];

  for (const {
    timestamp_in_game,
    duration = 8,
    action_type = 'auto_clip',
    player_name = '',
    team_color = '',
    assist_player_name = ''
  } of actions) {
    try {
      const seg = segments.find(s => {
        const segStart = Number(s.segment_start_time_in_game);
        const segEnd = segStart + Number(s.duration || 20);
        return timestamp_in_game >= segStart && timestamp_in_game < segEnd;
      });

      if (!seg) {
        results.push({
          success: false,
          error: 'No matching segment found',
          timestamp_in_game
        });
        continue;
      }

      const relative = timestamp_in_game - Number(seg.segment_start_time_in_game);
      const needsPrevious = relative < 3;

      let previousFileId = null;
      const currentIndex = segments.indexOf(seg);
      const previousSegment = segments[currentIndex - 1];

      if (needsPrevious && previousSegment) {
        previousFileId = previousSegment.file_id;
      }

      const result = await cutClipFromDriveFile({
        fileId: seg.file_id,
        previousFileId,
        startTimeInSec: relative,
        durationInSec: duration,
        matchId,
        actionType: action_type,
        playerName: player_name,
        teamColor: team_color,
        assistPlayerName: assist_player_name
      });

      results.push(result);
    } catch (err) {
      results.push({
        success: false,
        error: err.message,
        timestamp_in_game
      });
    }
  }

  return results;
}

module.exports = { autoGenerateClips };
