// index.js  –  גרסה יציבה + פתיחת CORS + לוג חסימות
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

// ---------- Google Drive init (ללא שינוי) ----------
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

// ---------- CORS (שינוי עדין) ----------
/*
   • כל דומיין preview / app של Base44 (production או branch) – יתקבל.  
   • הדומיינים הקבועים שהיו ברשימה נשארו.  
   • כל Origin אחר → 403 + לוג אזהרה.
*/
const allowedOrigins = [
  /https:\/\/(?:preview--|app--)?\d+-[a-z0-9]+\.base44\.app$/, // כל Preview/App-<port>-<hash>.base44.app
  'https://app.base44.com',
  'https://editor.base44.com'
];

const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||                      // curl / health-check
      allowedOrigins.some(rule =>
        typeof rule === 'string' ? rule === origin : rule.test(origin)
      )
    ) {
      return callback(null, true);
    }
    console.warn(`[CORS BLOCK] origin=${origin}`);   // <-- לוג חדש
    callback(new Error('Not allowed by CORS'));      // 403
  }
}));

// ---------- Body parsers ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Health ----------
app.get('/health', (_, res) => res.send('OK'));

// ---------- UPLOAD SEGMENT (לוגים קיימים) ----------
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id: origMatchId, start_time, end_time, segment_start_time_in_game } = req.body;
    const file     = req.file;
    const matchId  = resolveMatchId(origMatchId, segment_start_time_in_game);

    console.log('📤 Uploading segment:', {          // <-- לוג שכבר קיים
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
        custom_name : file.originalname,
        match_id    : matchId,
        duration    : end_time || '00:00:20',
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

// ---------- AUTO GENERATE CLIPS (לוגים קיימים) ----------
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id: origMatchId, actions = [], segments = [] } = req.body;
    const matchId = matchIdMap[origMatchId] || origMatchId;

    console.log('✂️ Auto clip request received:', { matchId, actionsCount: actions.length, segmentsCount: segments.length });

    res.json({ success: true, message: 'processing', match_id: matchId });

    /* … הלוגיקה / לולאות / cutClipFromDriveFile  –  לא שונה … */
  } catch (err) {
    console.error('[CLIP ERROR]', err);
  }
});

// ---------- MANUAL GENERATE CLIP, /clips, resolveMatchId, etc. ----------
/* … כל הקוד כפי שהיה – לא נערך … */

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});

/* ----------  END  ---------- */
