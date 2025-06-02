// autoGenerateClips.js
const { cutClipFromDriveFile } = require('./segmentsManager');

/* ─────────── הגדרות גמישות ─────────── */
const BACKWARD_OFFSET_SEC = 13;   // כמה שניות ללכת אחורה מהלחיצה
const CLIP_DURATION_SEC   = 12;   // אורך הקליפ הסופי שנחתך

/* helper */
const toSeconds = v =>
  typeof v === 'number'
    ? v
    : (v && v.includes(':'))
      ? v.split(':').map(Number).reduce((t, n) => t * 60 + n, 0)
      : Number(v) || 0;

/**
 * יוצר קליפים קצרים אוטומטית לפי רשימת פעולות.
 * – אם הפעולה מתרחשת < BACKWARD_OFFSET_SEC מתחילת הסגמנט → מצרפים את הסגמנט הקודם למיזוג.
 */
async function autoGenerateClips(
  actions = [],
  matchId = `auto_match_${Date.now()}`,
  segments = []
) {
  const results = [];

  for (const action of actions) {
    const {
      timestamp_in_game,
      duration           = CLIP_DURATION_SEC,
      action_type        = 'auto_clip',
      player_name        = '',
      team_color         = '',
      assist_player_name = ''
    } = action;

    try {
      /* locate segment */
      const seg = segments.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const dur   = toSeconds(s.duration) || 20;
        return timestamp_in_game >= start && timestamp_in_game < start + dur;
      });
      if (!seg) {
        results.push({ success: false, error: 'No segment', timestamp_in_game });
        continue;
      }

      const relative       = timestamp_in_game - Number(seg.segment_start_time_in_game);
      let   startSec       = Math.max(0, relative - BACKWARD_OFFSET_SEC);
      let   previousFileId = null;

      /* מיזוג עם הסגמנט הקודם במידת הצורך */
      if (relative < BACKWARD_OFFSET_SEC) {
        const idx = segments.indexOf(seg);
        if (idx > 0) {
          const prev = segments[idx - 1];
          previousFileId = prev.file_id;
          startSec = (toSeconds(prev.duration) || 20) + relative - BACKWARD_OFFSET_SEC;
          if (startSec < 0) startSec = 0;
        }
      }

      const clip = await cutClipFromDriveFile({
        fileId                 : seg.file_id,
        previousFileId,
        startTimeInSec         : startSec,
        durationInSec          : duration,
        matchId,
        actionType             : action_type,
        playerName             : player_name,
        teamColor              : team_color,
        assistPlayerName       : assist_player_name,
        segmentStartTimeInGame : seg.segment_start_time_in_game
      });

      results.push(clip);
    } catch (err) {
      results.push({ success: false, error: err.message, timestamp_in_game });
    }
  }

  return results;
}

module.exports = { autoGenerateClips };
