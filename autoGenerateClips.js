const { cutClipFromDriveFile } = require('./segmentsManager');

async function autoGenerateClips(fileId, clipTimestamps, matchId = `auto_match_${Date.now()}`) {
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
      const result = await cutClipFromDriveFile({
        fileId,
        startTimeInSec : start_time_in_segment,
        durationInSec  : duration,
        matchId,
        actionType     : action_type,
        playerName     : player_name,
        teamColor      : team_color,
        assistPlayer   : assist_player_name
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
