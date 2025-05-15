const { cutClipFromDriveFile } = require('./segmentsManager');

async function autoGenerateClips(fileId, clipTimestamps, matchId = "auto_match") {
  const results = [];

  for (const { start_time_in_segment, duration = 8, action_type = "auto_clip" } of clipTimestamps) {
    try {
      const result = await cutClipFromDriveFile({
        fileId,
        startTimeInSec: start_time_in_segment,
        durationInSec: duration,
        matchId,
        actionType: action_type
      });
      results.push(result);
    } catch (err) {
      results.push({
        success: false,
        error: err.message,
        start_time_in_segment
      });
    }
  }

  return results;
}

module.exports = { autoGenerateClips };
