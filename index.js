/**
 * MAIN SERVER – Render
 * --------------------
 * ▸ אינו משנה לוגיקה קיימת של חיתוך/מיזוג.
 * ▸ מוסיף לוגים ברורים כדי שתראה מה קורה בכל שלב.
 * ▸ שומר על חתימת הפונקציות ב-segmentsManager.js (uploadToDrive, cutClipFromDriveFile).
 */

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const {
  uploadToDrive,          // export name in segmentsManager.js
  cutClipFromDriveFile,   // "
} = require('./segmentsManager');

const app   = express();
const PORT  = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

// ───────────────────────────────────────────────────────────
// MIDDLEWARE
// ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Health-check
app.get('/health', (_, res) => res.send('OK'));

// ───────────────────────────────────────────────────────────
// 1)  UPLOAD SINGLE 20-SEC SEGMENT
// ───────────────────────────────────────────────────────────
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { file } = req;
    const {
      match_id,
      segment_start_time_in_game = 0,
      duration = '00:00:20',           // ברירת מחדל 20 שניות
    } = req.body;

    console.log('📥  Upload received:', {
      localPath : file.path,
      name      : file.originalname,
      sizeMB    : (file.size / 1024 / 1024).toFixed(2),
      match_id,
      segment_start_time_in_game,
    });

    // העלאה ל-Drive (תיקיית FULL_CLIPS)
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

    // ניקוי קובץ מקומי
    fs.unlink(file.path, () => {});

    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// 2)  AUTO-GENERATE CLIPS FROM ACTIONS
// ───────────────────────────────────────────────────────────
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;

  console.log('✂️  Auto clip request received:', {
    match_id,
    actionsCount  : actions.length,
    segmentsCount : segments.length,
  });

  // תשובה מידית לפורנט-אנד
  res.json({ success: true, message: 'Clip generation started in background' });

  // עיבוד ברקע
  for (const action of actions) {
    try {
      const seg = segments.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const end   = start + Number(s.duration || 20);
        return action.timestamp_in_game >= start && action.timestamp_in_game < end;
      });

      if (!seg) {
        console.warn(`⚠️  No segment for action at ${action.timestamp_in_game}s`);
        continue;
      }

      const relativeStart = action.timestamp_in_game - Number(seg.segment_start_time_in_game);
      const clipStartSec  = Math.max(0, relativeStart - 8);  // 8 שניות לפני האירוע
      const clipDuration  = 8;

      console.log(`✂️  Cutting clip from file ${seg.file_id} @${clipStartSec}s for ${clipDuration}s`);

      const clip = await cutClipFromDriveFile({
        fileId           : seg.file_id,
        startTimeInSec   : clipStartSec,
        durationInSec    : clipDuration,
        matchId          : match_id,
        actionType       : action.action_type,
        playerName       : action.player_name,
        teamColor        : action.team_color,
        assistPlayerName : action.assist_player_name,
      });

      console.log(`🎬  Short clip uploaded (fileId=${clip.external_id})`);
    } catch (err) {
      console.error('[CLIP ERROR]', err);
    }
  }
});

// ───────────────────────────────────────────────────────────
// 3)  LIST CLIPS  (דף מדיה / סטטיסטיקה בבייס44)
// ───────────────────────────────────────────────────────────
app.get('/clips', async (req, res) => {
  try {
    // מפנה ל-segmentsManager / Google-Drive list …
    // השאר ללא שינוי אם כבר קיים אצלך; אחרת החזר 501.
    res.status(501).json({ error: 'Not implemented in this snippet' });
  } catch (err) {
    console.error('[CLIPS LIST ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// START SERVER
// ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`📡  Server listening on port ${PORT}`);
});
