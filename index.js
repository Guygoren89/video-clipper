/* ---------- index.js (FULL) ---------- */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile
} = require('./segmentsManager');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* ---------- match-id helper ---------- */
const matchIdMap = Object.create(null);
function resolveMatchId(origId, segStart) {
  const isFirstSegment = Number(segStart) === 0;
  if (!matchIdMap[origId] && isFirstSegment) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;
    console.log(`🆕  New matchId created → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;
}

/* ---------- express setup ---------- */
const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      'https://app.base44.com',
      'https://preview--2000-f1d18643.base44.app',
      'https://app--2000-f1d18643.base44.app',
      'https://editor.base44.com'
    ];
    if (!origin || allowed.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_, res) => res.send('OK'));

/* ---------- 1. upload-segment ---------- */
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id: origMatchId, start_time, end_time, segment_start_time_in_game } = req.body;
    const file     = req.file;
    const matchId  = resolveMatchId(origMatchId, segment_start_time_in_game);

    console.log('📤 Uploading segment:', {
      name : file.originalname,
      size : (file.size / 1024 / 1024).toFixed(2) + ' MB',
      matchId,
      start_time,
      end_time,
      segment_start_time_in_game
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name              : file.originalname,
        match_id                 : matchId,
        duration                 : end_time || '00:00:20',
        segment_start_time_in_game
      },
      isFullClip: true
    });

    return res.json({ success: true, clip: uploaded, match_id: matchId });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- 2. auto-generate-clips (merge-aware) ---------- */
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id: origMatchId, actions = [], segments = [] } = req.body;
    const matchId = matchIdMap[origMatchId] || origMatchId;

    console.log('✂️ Auto clip request received:', {
      matchId,
      actionsCount  : actions.length,
      segmentsCount : segments.length
    });

    /* תשובה מידית */
    res.json({ success: true, message: 'Clip generation started in background', match_id: matchId });

    for (const action of actions) {
      const {
        timestamp_in_game,
        action_type,
        player_name,
        team_color = '',
        assist_player_name = ''
      } = action;

      /* מצא את המקטע הנוכחי */
      const seg = segments.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const end   = start + Number(s.duration || 20);
        return timestamp_in_game >= start && timestamp_in_game < end;
      });

      if (!seg) {
        console.warn(`⚠️  No segment for action @${timestamp_in_game}s`);
        continue;
      }

      const segStart      = Number(seg.segment_start_time_in_game);
      const segDuration   = Number(seg.duration || 20);
      const relative      = timestamp_in_game - segStart;          // שניות בתוך המקטע
      let   startSec      = Math.max(0, relative - 8);             // ברירת מחדל
      let   previousFileId = null;

      /* < 3 שניות מתחילת המקטע ⇒ צריך מיזוג */
      if (relative < 3) {
        const currentIdx      = segments.indexOf(seg);
        const previousSegment = segments[currentIdx - 1];
        if (previousSegment) {
          previousFileId = previousSegment.file_id;
          // התחלה חדשה: 8 שניות לפני הפעולה בתוך הסרטון המאוחד
          startSec = segDuration + relative - 8;
        }
      }

      /* חותכים תמיד 8 שניות */
      try {
        await cutClipFromDriveFile({
          fileId           : seg.file_id,
          previousFileId,
          startTimeInSec   : startSec,
          durationInSec    : 8,
          matchId,
          actionType       : action_type,
          playerName       : player_name,
          teamColor        : team_color,
          assistPlayerName : assist_player_name
        });
      } catch (err) {
        console.error(`[ERROR] Clip cut failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[CLIP ERROR]', err);
  }
});

/* ---------- 3. manual generate-clips ---------- */
app.post('/generate-clips', async (req, res) => {
  try {
    const {
      file_id, match_id, start_time, duration,
      action_type, player_name, team_color, assist_player_name
    } = req.body;

    console.log('✂️ Manual clip request:', req.body);

    const clip = await cutClipFromDriveFile({
      fileId           : file_id,
      matchId          : match_id,
      startTimeInSec   : Number(start_time),
      durationInSec    : Number(duration),
      actionType       : action_type,
      playerName       : player_name,
      teamColor        : team_color,
      assistPlayerName : assist_player_name
    });

    return res.json({ success: true, clip });
  } catch (err) {
    console.error('[MANUAL CLIP ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- 4. clips feed ---------- */
app.get('/clips', async (_, res) => {
  try {
    const list = await drive.files.list({
      q       : `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed = false`,
      fields  : 'files(id, name, createdTime, properties)',
      orderBy : 'createdTime desc'
    });

    const clips = list.data.files.map(f => ({
      external_id        : f.id,
      name               : f.name,
      view_url           : `https://drive.google.com/file/d/${f.id}/view`,
      download_url       : `https://drive.google.com/uc?export=download&id=${f.id}`,
      thumbnail_url      : '',
      duration           : '',
      created_date       : f.createdTime,
      match_id           : f.properties?.match_id || '',
      action_type        : f.properties?.action_type || '',
      player_name        : f.properties?.player_name || '',
      team_color         : f.properties?.team_color || '',
      assist_player_name : f.properties?.assist_player_name || ''
    }));

    res.json(clips);
  } catch (err) {
    console.error('[ERROR] Failed to load clips from Drive:', err.message);
    res.status(500).json({ error: 'Failed to load clips from Drive' });
  }
});

/* ---------- server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});
