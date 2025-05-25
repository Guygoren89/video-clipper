const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile
} = require('./segmentsManager');

/* ---------- google auth ---------- */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* ---------- helpers ---------- */
const matchIdMap = Object.create(null);
function resolveMatchId(origId, segStart) {
  const isFirst = Number(segStart) === 0;
  if (!matchIdMap[origId] && isFirst) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;
    console.log(`🆕  New matchId → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;
}

/* ---------- app ---------- */
const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_, res) => res.send('OK'));

/* ---------- upload-segment ---------- */
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id, start_time, end_time, segment_start_time_in_game } = req.body;
    const file     = req.file;
    const matchId  = resolveMatchId(match_id, segment_start_time_in_game);

    const clip = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name              : file.originalname,
        match_id                 : matchId,
        duration                 : end_time || '00:00:20',
        segment_start_time_in_game
      },
      isFullClip: true
    });

    res.json({ success: true, clip, match_id: matchId });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- auto-generate-clips ---------- */
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id, actions = [], segments = [] } = req.body;
    const matchId = matchIdMap[match_id] || match_id;

    res.json({ success: true, message: 'processing', match_id: matchId });

    for (const act of actions) {
      const seg = segments.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const end   = start + Number(s.duration || 20);
        return act.timestamp_in_game >= start && act.timestamp_in_game < end;
      });
      if (!seg) continue;

      const rel = act.timestamp_in_game - Number(seg.segment_start_time_in_game);
      let   startSec = Math.max(0, rel - 8);
      let   prevId   = null;

      if (rel < 3) {
        const idx = segments.indexOf(seg);
        if (idx > 0) {
          prevId   = segments[idx - 1].file_id;
          startSec = Number(seg.duration || 20) + rel - 8;
        }
      }

      try {
        await cutClipFromDriveFile({
          fileId           : seg.file_id,
          previousFileId   : prevId,
          startTimeInSec   : startSec,
          durationInSec    : 8,
          matchId,
          actionType       : act.action_type,
          playerName       : act.player_name,
          teamColor        : act.team_color,
          assistPlayerName : act.assist_player_name
        });
      } catch (err) {
        console.error('[AUTO CUT ERROR]', err.message);
      }
    }
  } catch (err) {
    console.error('[AUTO-CLIP ERROR]', err.message);
  }
});

/* ---------- manual-generate-clips ---------- */
app.post('/generate-clips', async (req, res) => {
  try {
    const { file_id, match_id, start_time, duration, action_type, player_name, team_color, assist_player_name } = req.body;

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

    res.json({ success: true, clip });
  } catch (err) {
    console.error('[MANUAL CUT ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- clips feed ---------- */
app.get('/clips', async (_, res) => {
  try {
    const list = await drive.files.list({
      q       : `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed = false`,
      fields  : 'files(id,name,createdTime,properties)',
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
    console.error('[CLIPS ERROR]', err.message);
    res.status(500).json({ error: 'Failed to load clips' });
  }
});

/* ---------- server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 Server on ${PORT}`));
