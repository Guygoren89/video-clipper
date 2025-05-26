// index.js  –  stable + CORS elastic + logs + resolveMatchId restored
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

// ---------- Google Drive ----------
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

// ---------- helpers: matchId ----------
const matchIdMap = Object.create(null);
/*  • origId = מזהה שמגיע מה-client
    • segStart = זמן התחלה של הסגמנט במשחק (מספר שניות)
    –  אם זה הסגמנט הראשון (segStart === 0) יוצרים matchId חדש חד-פעמי
*/
function resolveMatchId(origId, segStart) {
  const isFirstSegment = Number(segStart) === 0;
  if (!matchIdMap[origId] && isFirstSegment) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;
    console.log(`🆕  New matchId created → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;
}

// ---------- elastic CORS ----------
const allowedOrigins = [
  /https:\/\/(?:preview--|app--)?\d+-[a-z0-9]+\.base44\.app$/,
  'https://app.base44.com',
  'https://editor.base44.com'
];

const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin ||
      allowedOrigins.some(r => typeof r === 'string' ? r === origin : r.test(origin))
    ) return cb(null, true);
    console.warn(`[CORS BLOCK] origin=${origin}`);
    cb(new Error('Not allowed by CORS'));
  }
}));

// ---------- body parsers ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- health ----------
app.get('/health', (_, res) => res.send('OK'));

// ---------- upload segment ----------
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id: origMatchId, start_time, end_time, segment_start_time_in_game } = req.body;
    const file    = req.file;
    const matchId = resolveMatchId(origMatchId, segment_start_time_in_game);

    console.log('📤 Uploading segment:', {
      name : file.originalname,
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

// ---------- auto-generate clips (unchanged) ----------
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id: origMatchId, actions = [], segments = [] } = req.body;
    const matchId = matchIdMap[origMatchId] || origMatchId;

    console.log('✂️ Auto clip request received:', {
      matchId, actionsCount: actions.length, segmentsCount: segments.length
    });

    res.json({ success: true, message: 'processing', match_id: matchId });

    /* ... הלוגיקה הקיימת שלך ... */
  } catch (err) {
    console.error('[CLIP ERROR]', err);
  }
});

// ---------- manual /generate-clips, /clips list – unchanged ----------
// (הקוד שהיה אצלך ממשיך כאן ללא שינוי)

// ---------- start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});
