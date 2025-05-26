/**
 * MAIN SERVER – Render
 * --------------------
 * ▸ מחזיר את כל הלוגיקה המקורית + לוגים ברורים
 * ▸ יוצר matchId ייחודי בעזרת resolveMatchId (כמו ב-v-OK)
 * ▸ כולל /clips שעובר ל-Drive (כמו קודם)
 */
const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fs       = require('fs');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const {
  uploadToDrive,
  cutClipFromDriveFile,
} = require('./segmentsManager');

/* ─────────  Google Drive helper  ───────── */
const auth  = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });
const drive = google.drive({ version: 'v3', auth });
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* ─────────  match-id helper  ───────── */
const matchIdMap = Object.create(null);
function resolveMatchId(origId, segStart) {
  if (!matchIdMap[origId] && Number(segStart) === 0) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;
    console.log(`🆕  New matchId → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;
}

/* ─────────  Express setup  ───────── */
const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.send('OK'));

/* ─────────  1) upload-segment  ───────── */
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { file } = req;
    let {
      match_id,
      segment_start_time_in_game = 0,
      duration = '00:00:20',
    } = req.body;

    match_id = resolveMatchId(match_id, segment_start_time_in_game);

    console.log('📥  Upload received:', {
      localPath : file.path,
      name      : file.originalname,
      sizeMB    : (file.size / 1024 / 1024).toFixed(2),
      match_id,
      segment_start_time_in_game,
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name              : file.originalname || `segment_${uuidv4()}.webm`,
        match_id,
        duration,
        segment_start_time_in_game,
      },
      isFullClip : true,
    });

    console.log(`✅  Segment uploaded to Drive (fileId=${uploaded.external_id})`);
    fs.unlink(file.path, () => {});
    res.json({ success: true, clip: uploaded, match_id });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────  2) auto-generate-clips  ───────── */
app.post('/auto-generate-clips', async (req, res) => {
  try {
    let { match_id, actions = [], segments = [] } = req.body;
    match_id = matchIdMap[match_id] || match_id;

    console.log('✂️  Auto clip request received:', {
      match_id,
      actionsCount  : actions.length,
      segmentsCount : segments.length,
    });

    res.json({ success: true, message: 'Clip generation started' });

    for (const action of actions) {
      const seg = segments.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const end   = start + Number(s.duration || 20);
        return action.timestamp_in_game >= start && action.timestamp_in_game < end;
      });
      if (!seg) {
        console.warn(`⚠️  No segment for action at ${action.timestamp_in_game}s`);
        continue;
      }
      const rel = action.timestamp_in_game - Number(seg.segment_start_time_in_game);
      let startSec = Math.max(0, rel - 8);
      let previousFileId = null;
      if (rel < 3) {
        const prevSeg = segments[segments.indexOf(seg) - 1];
        if (prevSeg) {
          previousFileId = prevSeg.file_id;
          startSec = Number(seg.duration || 20) + rel - 8;
        }
      }

      console.log(`✂️  Cutting clip ${seg.file_id} @${startSec}s`);
      await cutClipFromDriveFile({
        fileId          : seg.file_id,
        previousFileId,
        startTimeInSec  : startSec,
        durationInSec   : 8,
        matchId         : match_id,
        actionType      : action.action_type,
        playerName      : action.player_name,
        teamColor       : action.team_color,
        assistPlayerName: action.assist_player_name,
        segmentStartTimeInGame: seg.segment_start_time_in_game
      });
    }
  } catch (err) { console.error('[CLIP ERROR]', err); }
});

/* ─────────  3) clips feed  ───────── */
app.get('/clips', async (_, res) => {
  try {
    const list = await drive.files.list({
      q       : `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed=false`,
      fields  : 'files(id,name,createdTime,properties)',
      orderBy : 'createdTime desc'
    });
    const clips = list.data.files.map(f => ({
      external_id  : f.id,
      name         : f.name,
      view_url     : `https://drive.google.com/file/d/${f.id}/view`,
      download_url : `https://drive.google.com/uc?export=download&id=${f.id}`,
      created_date : f.createdTime,
      ...f.properties
    }));
    res.json(clips);
  } catch (err) {
    console.error('[CLIPS LIST ERROR]', err);
    res.status(500).json({ error: 'Drive list failed' });
  }
});

/* ─────────  start ───────── */
app.listen(PORT, () => console.log(`📡  Server listening on port ${PORT}`));
