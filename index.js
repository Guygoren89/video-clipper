const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const { google } = require('googleapis');

const {
  uploadToDrive,
  formatTime,
  cutClipFromDriveFile
} = require('./segmentsManager');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

const matchIdMap = Object.create(null);
function resolveMatchId(origId, segStart) {
  const isFirstSegment = Number(segStart) === 0;
  if (!matchIdMap[origId] && isFirstSegment) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;
    console.log(`🆕  New matchId created → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;
}

const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://app.base44.com',
      'https://preview--2000-f1d18643.base44.app',
      'https://app--2000-f1d18643.base44.app',
      'https://editor.base44.com'
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_, res) => res.send('OK'));

app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id: origMatchId, start_time, end_time, segment_start_time_in_game } = req.body;
    const file = req.file;
    const matchId = resolveMatchId(origMatchId, segment_start_time_in_game);

    console.log('📤 Uploading segment:', {
      name  : file.originalname,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
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

app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id: origMatchId, actions = [], segments = [] } = req.body;
    const matchId = matchIdMap[origMatchId] || origMatchId;

    console.log('✂️ Auto clip request received:', {
      matchId,
      actionsCount  : actions.length,
      segmentsCount : segments.length
    });

    res.json({ success: true, message: 'Clip generation started in background', match_id: matchId });

    for (const action of actions) {
      const {
        timestamp_in_game,
        action_type,
        player_name,
        team_color = '',
        assist_player_name = ''
      } = action;

      const seg = segments.find(s => {
        const segStart = Number(s.segment_start_time_in_game);
        const segEnd   = segStart + Number(s.duration || 20);
        return timestamp_in_game >= segStart && timestamp_in_game < segEnd;
      });

      if (!seg) {
        console.warn(`⚠️  No segment for action at ${timestamp_in_game}s`);
        continue;
      }

      const relative  = timestamp_in_game - Number(seg.segment_start_time_in_game);
      const startSec  = Math.max(0, relative - 8);
      const durSec    = Math.min(8, relative);

      console.log(`✂️  Cutting clip ${seg.file_id} @${startSec}s for ${durSec}s`);

      try {
        await cutClipFromDriveFile({
          fileId           : seg.file_id,
          matchId,
          startTimeInSec   : Number(startSec), // ✅ שינוי כאן — לא להשתמש ב־formatTime
          durationInSec    : durSec,
          actionType       : action_type,
          playerName       : player_name || '',
          teamColor        : team_color || '',
          assistPlayerName : assist_player_name || ''
        });
      } catch (err) {
        console.error(`[ERROR] Clip cut failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[CLIP ERROR]', err);
  }
});

app.post('/generate-clips', async (req, res) => {
  try {
    const { file_id, match_id, start_time, duration, action_type, player_name, team_color, assist_player_name } = req.body;

    console.log('✂️ Manual clip request:', {
      file_id,
      match_id,
      start_time,
      duration,
      action_type,
      player_name,
      team_color,
      assist_player_name
    });

    const clip = await cutClipFromDriveFile({
      fileId           : file_id,
      matchId          : match_id,
      startTimeInSec   : Number(start_time), // ✅ שינוי כאן — לא להשתמש ב־formatTime
      durationInSec    : Number(duration),
      actionType       : action_type,
      playerName       : player_name || '',
      teamColor        : team_color || '',
      assistPlayerName : assist_player_name || ''
    });

    return res.json({ success: true, clip });
  } catch (err) {
    console.error('[MANUAL CLIP ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/clips', async (req, res) => {
  try {
    const list = await drive.files.list({
      q: `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, createdTime, properties)',
      orderBy: 'createdTime desc'
    });

    const clips = list.data.files.map(file => ({
      external_id         : file.id,
      name                : file.name,
      view_url            : `https://drive.google.com/file/d/${file.id}/view`,
      download_url        : `https://drive.google.com/uc?export=download&id=${file.id}`,
      thumbnail_url       : '',
      duration            : '',
      created_date        : file.createdTime,
      match_id            : file.properties?.match_id || '',
      action_type         : file.properties?.action_type || '',
      player_name         : file.properties?.player_name || '',
      team_color          : file.properties?.team_color || '',
      assist_player_name  : file.properties?.assist_player_name || ''
    }));

    res.json(clips);
  } catch (err) {
    console.error('[ERROR] Failed to load clips from Drive:', err.message);
    res.status(500).json({ error: 'Failed to load clips from Drive' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});
