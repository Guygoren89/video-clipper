const { cutClipFromDriveFile } = require('./segmentsManager');

/**
 * מייצר קליפים אוטומטית לפי רשימת פעולות  ➜  שינויים מינימליים בלבד
 *
 * ➊ מחשב startSec = action-8s (כמו בגרסה הישנה).
 * ➋ אם action נמצאת <3s מתחילת המקטע – מוסיף את המקטע הקודם למיזוג
 *    ומזיז את startSec אל תוך החלק המשולב.
 */
async function autoGenerateClips (
  actions   = [],
  matchId   = `auto_match_${Date.now()}`,
  segments  = []
) {
  const results = [];

  for (const action of actions) {
    const {
      timestamp_in_game,
      duration          = 8,
      action_type       = 'auto_clip',
      player_name       = '',
      team_color        = '',
      assist_player_name = ''
    } = action;

    try {
      /* ── מאתרים את המקטע שבו הפעולה נמצאת ── */
      const seg = segments.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const end   = start + Number(s.duration || 20);
        return timestamp_in_game >= start && timestamp_in_game < end;
      });

      if (!seg) {
        results.push({ success:false, error:'No matching segment', timestamp_in_game });
        continue;
      }

      /* ── חישוב יחסיים ── */
      const relative       = timestamp_in_game - Number(seg.segment_start_time_in_game);
      let   startSec       = Math.max(0, relative - 8);   // ברירת־מחדל: 8 שניות לפני האירוע
      let   previousFileId = null;

      /* ── צריך מיזוג? (<3 שניות מתחילת המקטע) ── */
      if (relative < 3) {
        const idx = segments.indexOf(seg);
        if (idx > 0) {
          const prev = segments[idx - 1];
          previousFileId = prev.file_id;
          // מזיזים את נקודת-התחלה לתוך הקטע המשולב
          startSec = Number(prev.duration || 20) + relative - 8;
          if (startSec < 0) startSec = 0;                // תחום ביטחון
        }
      }

      /* ── קריאה לחיתוך / מיזוג ── */
      const clip = await cutClipFromDriveFile({
        fileId           : seg.file_id,
        previousFileId,
        startTimeInSec   : startSec,
        durationInSec    : duration,
        matchId,
        actionType       : action_type,
        playerName       : player_name,
        teamColor        : team_color,
        assistPlayerName : assist_player_name,
        segmentStartTimeInGame : seg.segment_start_time_in_game
      });

      results.push(clip);
    } catch (err) {
      results.push({ success:false, error:err.message, timestamp_in_game });
    }
  }

  return results;
}

module.exports = { autoGenerateClips };
