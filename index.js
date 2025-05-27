/* index.js – SERVER (Render) */
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

/* ─────────────────────────── Google Drive ─────────────────────────── */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* helper: "00:00:20" → 20 (sec) */
function toSeconds(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val.includes(':')) return val.split(':').map(Number).reduce((t,n)=>t*60+n,0);
  const n = Number(val);
  return Number.isNaN(n) ? 0 : n;
}

/* ─────────────────────────────  app ─────────────────────────────── */
const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.send('OK'));

/* ───────── upload-segment (20 s) ───────── */
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { file } = req;
    const { match_id, segment_start_time_in_game = 0, duration = '00:00:20' } = req.body;

    console.log('📥 Upload received:', {
      localPath : file.path,
      name      : file.originalname,
      sizeMB    : (file.size/1024/1024).toFixed(2),
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

/* ───────── auto-generate-clips (SHORT) ───────── */
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;

  console.log('✂️ Auto clip request:', {
    match_id, actions: actions.length, segments: segments.length
  });
  res.json({ success: true });                           // reply immediately

  /* sort by start-time */
  const segsByTime = [...segments].sort(
    (a,b) => Number(a.segment_start_time_in_game) - Number(b.segment_start_time_in_game)
  );

  for (const action of actions) {
    try {
      /* locate current segment */
      const seg = segsByTime.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const dur   = toSeconds(s.duration) || 20;
        return action.timestamp_in_game >= start &&
               action.timestamp_in_game <  start + dur;
      });
      if (!seg) {
        console.warn(`⚠️ No segment for ${action.timestamp_in_game}s`);
        continue;
      }

      /* relative position & possible merge */
      const rel = action.timestamp_in_game - Number(seg.segment_start_time_in_game);
      let   startSec = Math.max(0, rel - 8);
      let   prevSeg  = null;

      if (rel <= 3) {
        prevSeg = segsByTime
          .filter(s => Number(s.segment_start_time_in_game) < Number(seg.segment_start_time_in_game))
          .pop();
        if (prevSeg) {
          startSec = (toSeconds(prevSeg.duration) || 20) + rel - 8;
          if (startSec < 0) startSec = 0;
        }
      }

      console.log(`✂️ Cutting ${seg.file_id}${prevSeg?' +prev':''} @${startSec}s`);
      await cutClipFromDriveFile({
        fileId                 : seg.file_id,
        previousFileId         : prevSeg ? prevSeg.file_id : null,
        startTimeInSec         : startSec,
        durationInSec          : 8,
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

/* ───────── clips feed (/clips?limit&before) ───────── */
app.get('/clips', async (req,res) => {
  try {
    const limit  = Math.min(Number(req.query.limit)||100, 200);
    const before = req.query.before ? new Date(req.query.before).toISOString() : null;

    const qParts = [
      `'${SHORT_CLIPS_FOLDER_ID}' in parents`,
      'trashed = false'
    ];
    if (before) qParts.push(`createdTime < '${before}'`);

    const resp = await drive.files.list({
      q        : qParts.join(' and '),
      pageSize : limit,
      fields   : 'files(id,name,createdTime,properties)',
      orderBy  : 'createdTime desc'
    });

    const clips = resp.data.files.map(f => ({
      external_id : f.id,
      name        : f.name,
      view_url    : `https://drive.google.com/file/d/${f.id}/view`,
      download_url: `https://drive.google.com/uc?export=download&id=${f.id}`,
      created_date: f.createdTime,
      match_id    : f.properties?.match_id || '',
      action_type : f.properties?.action_type || '',
      player_name : f.properties?.player_name || '',
      team_color  : f.properties?.team_color || '',
      assist_player_name        : f.properties?.assist_player_name || '',
      segment_start_time_in_game: f.properties?.segment_start_time_in_game || ''
    }));

    res.json(clips);
  } catch (err) {
    console.error('[CLIPS ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────── full-clip lookup (/full-clip?match_id=..&start=..) ───────── */
app.get('/full-clip', async (req, res) => {
  const { match_id, start } = req.query;          // start => "320"
  if (!match_id || start === undefined) {
    return res.status(400).json({ error: 'match_id & start required' });
  }

  try {
    const qParts = [
      `'${FULL_CLIPS_FOLDER_ID}' in parents`,
      'trashed = false',
      `properties has { key='match_id' and value='${match_id}' }`,
      `properties has { key='segment_start_time_in_game' and value='${start}' }`
    ];

    const resp = await drive.files.list({
      q        : qParts.join(' and '),
      pageSize : 1,
      fields   : 'files(id,name)'
    });

    if (!resp.data.files.length) {
      return res.status(404).json({ error: 'full segment not found' });
    }

    const id = resp.data.files[0].id;
    res.json({
      name         : resp.data.files[0].name,
      download_url : `https://drive.google.com/uc?export=download&id=${id}`,
      view_url     : `https://drive.google.com/file/d/${id}/view`
    });
  } catch (err) {
    console.error('[FULL-CLIP ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────── start server ───────── */
app.listen(PORT, () => console.log(`📡 Server listening on port ${PORT}`));
