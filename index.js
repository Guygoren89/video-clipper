/* index.js – SERVER */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile
} = require('./segmentsManager');

/* ──────────── Google Drive ──────────── */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

/* ─────────── הגדרות חיתוך ─────────── */
const BACKWARD_OFFSET_SEC = 13;
const CLIP_DURATION_SEC   = 12;

/* helper: "00:00:20" → 20 (sec) */
function toSeconds(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val.includes(':')) return val.split(':').map(Number).reduce((t, n) => t * 60 + n, 0);
  const n = Number(val);
  return Number.isNaN(n) ? 0 : n;
}

/* ───────────── app ───────────── */
const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.send('OK'));

/* ───── upload-segment – ללא שינוי ───── */

/* ───── auto-generate-clips (SHORT) ───── */
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;

  console.log('✂️ Auto clip request:', {
    match_id, actions: actions.length, segments: segments.length
  });
  res.json({ success: true });               // משיבים מיד

  const segsByTime = [...segments].sort(
    (a, b) => Number(a.segment_start_time_in_game) - Number(b.segment_start_time_in_game)
  );

  for (const action of actions) {
    try {
      const seg = segsByTime.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const dur   = toSeconds(s.duration) || 20;
        return action.timestamp_in_game >= start && action.timestamp_in_game < start + dur;
      });
      if (!seg) {
        console.warn(`⚠️ No segment for ${action.timestamp_in_game}s`);
        continue;
      }

      const rel      = action.timestamp_in_game - Number(seg.segment_start_time_in_game);
      let   startSec = Math.max(0, rel - BACKWARD_OFFSET_SEC);
      let   prevSeg  = null;

      if (rel < BACKWARD_OFFSET_SEC) {
        prevSeg = segsByTime
          .filter(s => Number(s.segment_start_time_in_game) < Number(seg.segment_start_time_in_game))
          .pop();
        if (prevSeg) {
          startSec = (toSeconds(prevSeg.duration) || 20) + rel - BACKWARD_OFFSET_SEC;
          if (startSec < 0) startSec = 0;
        }
      }

      console.log(`✂️ Cutting ${seg.file_id}${prevSeg ? ' +prev' : ''} @${startSec}s`);
      await cutClipFromDriveFile({
        fileId                 : seg.file_id,
        previousFileId         : prevSeg ? prevSeg.file_id : null,
        startTimeInSec         : startSec,
        durationInSec          : CLIP_DURATION_SEC,
        matchId                : match_id,
        actionType             : action.action_type,
        playerName             : action.player_name,
        teamColor              : action.team_color,
        assistPlayerName       : action.assist_player_name,
        segmentStartTimeInGame : seg.segment_start_time_in_game
      });
    } catch (err) {
      console.error('[CLIP ERROR]', err);
    }
  }
});

/* ───── שאר ה-routes ללא שינוי ───── */

app.listen(PORT, () => console.log(`📡 Server listening on port ${PORT}`));
