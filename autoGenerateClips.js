const { cutClip } = require('./segmentsManager');

async function autoGenerateClips(fileId, clipTimestamps) {
  const results = [];

  for (const { start_time_in_segment } of clipTimestamps) {
    try {
      const result = await cutClip(
        fileId,
        start_time_in_segment,
        8,               // ברירת מחדל לאורך קליפ
        "auto_match",    // match_id גנרי
        "auto_clip"      // action_type גנרי
      );
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
