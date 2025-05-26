/* index.js – SERVER (Render) */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile,
  formatTime
} = require('./segmentsManager');

/* ─────────────────────────  Google Drive client  ───────────────────────── */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* ─────────────────────────────  app setup  ─────────────────────────────── */
const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.send('OK'));

/* ─────────────────── 1) upload-segment (FULL clips) ───────────────────── */
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { file } = req;
    const {
      match_id,
      segment_start_time_in_game = 0,
      duration = '00:00:20'
    } = req.body;

    console.log('📥  Upload received:', {
      localPath : file.path,
      name      : file.originalname,
      sizeMB    : (file.size / 1024 / 1024).toFixed(2),
      match_id,
      segment_start_time_in_game
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name              : file.originalname || `segment_${uuidv4()}.webm`,
        match_id,
        duration,
        segment_start_time_in_game
      },
      isFullClip : true
    });

    console.log(`✅  Segment uploaded (id=${uploaded.external_id})`);
    fs.unlink(file.path, () => {});
    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ───────────────── 2) auto-generate-clips (SHORT) ─────────────────────── */
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;

  console.log('✂️  Auto clip request:', {
    match_id, actions: actions.length, segments: segments.length
  });
  res.json({ success: true });               // תשובה מידית

  for (const action of actions) {
    try {
      /* segment lookup */
      const seg = segments.find(s => {
        const s0 = Number(s.segment_start_time_in_game);
        return action.timestamp_in_game >= s0 &&
               action.timestamp_in_game < s0 + Number(s.duration || 20);
      });
      if (!seg) {
        console.warn(`⚠️  No segment for ${action.timestamp_in_game}s`);
        continue;
      }

      /* previous-segment logic */
      const rel      = action.timestamp_in_game - Number(seg.segment_start_time_in_game);
      let   startSec = Math.max(0, rel - 8);
      let   prevId   = null;

      if (rel < 3) {                         // זקוק למיזוג
        const idx = segments.indexOf(seg);
        if (idx > 0) {
          prevId   = segments[idx - 1].file_id;
          startSec = Number(segments[idx - 1].duration || 20) + rel - 8;
          if (startSec < 0) startSec = 0;
        }
      }

      console.log(`✂️  Cutting ${seg.file_id}${prevId ? ' +prev' : ''} @${startSec}s`);
      await cutClipFromDriveFile({
        fileId           : seg.file_id,
        previousFileId   : prevId,
        startTimeInSec   : formatTime(startSec),
        durationInSec    : 8,
        matchId          : match_id,
        actionType       : action.action_type,
        playerName       : action.player_name,
        teamColor        : action.team_color,
        assistPlayerName : action.assist_player_name,
        segmentStartTimeInGame : seg.segment_start_time_in_game
      });
    } catch (err) {
      console.error('[CLIP ERROR]', err);
    }
  }
});

/* ───────────────── 3) clips feed  (Media / Statistics) ───────────────────
   GET /clips?limit=25&before=<ISO date>     */
app.get('/clips', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 100, 200);  // safety
    const before = req.query.before            // ISO string or undefined
      ? new Date(req.query.before).toISOString()
      : null;

    /* Drive query */
    const qParts = [
      `'${SHORT_CLIPS_FOLDER_ID}' in parents`,
      'trashed = false'
    ];
    if (before) qParts.push(`createdTime < '${before}'`);
    const resp = await drive.files.list({
      q         : qParts.join(' and '),
      pageSize  : limit,
      fields    : 'files(id,name,createdTime,properties)',
      orderBy   : 'createdTime desc'
    });

    const clips = resp.data.files.map(f => ({
      external_id        : f.id,
      name               : f.name,
      view_url           : `https://drive.google.com/file/d/${f.id}/view`,
      download_url       : `https://drive.google.com/uc?export=download&id=${f.id}`,
      created_date       : f.createdTime,
      match_id           : f.properties?.match_id || '',
      action_type        : f.properties?.action_type || '',
      player_name        : f.properties?.player_name || '',
      team_color         : f.properties?.team_color || '',
      assist_player_name : f.properties?.assist_player_name || '',
      segment_start_time_in_game : f.properties?.segment_start_time_in_game || ''
    }));

    res.json(clips);
  } catch (err) {
    console.error('[CLIPS ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────────────────── start server ───────────────────────────── */
app.listen(PORT, () => console.log(`📡  Server listening on port ${PORT}`));
