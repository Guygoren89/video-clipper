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

/* ─────────── הגדרות חיתוך חדשות ─────────── */
const BACKWARD_OFFSET_SEC = 13;   // כמה שניות אחורה מהלחיצה
const CLIP_DURATION_SEC   = 12;   // אורך הקליפ הקצר

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

/* ───── upload-segment (20 s) ───── */
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { file } = req;
    const { match_id, segment_start_time_in_game = 0, duration = '00:00:20' } = req.body;

    console.log('📥 Upload received:', {
      localPath : file.path,
      name      : file.originalname,
      sizeMB    : (file.size / 1024 / 1024).toFixed(2),
      match_id,
      segment_start_time_in_game
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name : file.originalname || `segment_${uuidv4()}.webm`,
        match_id,
        duration,
        segment_start_time_in_game
      },
      isFullClip : true
    });

    console.log(`✅ Segment uploaded (id=${uploaded.external_id})`);
    fs.unlink(file.path, () => {});
    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ───── auto-generate-clips (SHORT) ───── */
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;

  console.log('✂️ Auto clip request:', {
    match_id, actions: actions.length, segments: segments.length
  });
  res.json({ success: true });               // משיבים מיד ללקוח

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

      if (rel <= 3) {
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

/* ───── clips feed (/clips) – ללא שינוי … ───── */
/* ───── full-clip helper        – ללא שינוי … ───── */

app.listen(PORT, () => console.log(`📡 Server listening on port ${PORT}`));
