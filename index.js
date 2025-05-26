/* index.js – SERVER (Render) */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const {
  uploadToDrive,
  cutClipFromDriveFile,
  formatTime               // ⬅️ ייבוא קיים מ-segmentsManager
} = require('./segmentsManager');

const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

/*───────────────────────────  middleware  ──────────────────────────*/
app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.send('OK'));

/*─────────────────────────── 1) upload-segment ─────────────────────*/
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

    console.log(`✅  Segment uploaded to Drive (fileId=${uploaded.external_id})`);
    fs.unlink(file.path, () => {});
    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/*─────────────────────────── 2) auto-generate-clips ───────────────*/
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;

  console.log('✂️  Auto clip request received:', {
    match_id,
    actionsCount  : actions.length,
    segmentsCount : segments.length
  });
  res.json({ success: true, message: 'Clip generation started in background' });

  for (const action of actions) {
    try {
      /*── מוצאים המקטע המתאים ──*/
      const seg = segments.find(s => {
        const s0 = Number(s.segment_start_time_in_game);
        const s1 = s0 + Number(s.duration || 20);
        return action.timestamp_in_game >= s0 && action.timestamp_in_game < s1;
      });
      if (!seg) {
        console.warn(`⚠️  No segment for action at ${action.timestamp_in_game}s`);
        continue;
      }

      const relative = action.timestamp_in_game - Number(seg.segment_start_time_in_game);

      /*── NEW LOGIC: add previous segment אם <3s ──*/
      let previousFileId = null;
      let startSec       = Math.max(0, relative - 8);

      if (relative < 3) {
        const idx = segments.indexOf(seg);
        if (idx > 0) {
          previousFileId = segments[idx - 1].file_id;
          startSec       = Number(segments[idx - 1].duration || 20) + relative - 8;
          if (startSec < 0) startSec = 0;
        }
      }

      const startTimeStr = formatTime(startSec);   // uniform "HH:MM:SS"
      console.log(
        `✂️  Cutting clip ${seg.file_id}` +
        (previousFileId ? ` (+prev ${previousFileId})` : '') +
        ` @${startSec}s`
      );

      await cutClipFromDriveFile({
        fileId           : seg.file_id,
        previousFileId,
        startTimeInSec   : startTimeStr,
        durationInSec    : 8,
        matchId,
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

/*─────────────────────────── 3) clips feed  ───────────────────────*/
app.get('/clips', (_, res) =>
  res.status(501).json({ error: 'Not implemented in this snippet' })
);

/*─────────────────────────── start server ─────────────────────────*/
app.listen(PORT, () => console.log(`📡  Server listening on port ${PORT}`));
