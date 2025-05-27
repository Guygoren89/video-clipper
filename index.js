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

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

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

/* ……………………… ( /upload-segment , /auto-generate-clips , /clips ) – נשארו ללא שינוי …………………… */

/* ───────────── FULL-CLIP helper – חדש ─────────────
   GET /full-clip?match_id=…&start=…
   ➜ מחזיר עד שני קבצי FULL שהכי קרובים ל-start:
      • הקטע עם start_time ≤ start (הקודם/שווה)
      • הקטע הבא אחריו (אם קיים)
   מחזיר ‎200‎ עם מערך [{download_url,…}, …]  או ‎404‎ אם לא נמצא.
*/
app.get('/full-clip', async (req, res) => {
  try {
    const { match_id, start } = req.query;
    if (!match_id || start === undefined)
      return res.status(400).json({ error: 'Missing match_id or start' });

    /* 1. מביאים את כל full-segments של אותו משחק */
    const listResp = await drive.files.list({
      q: [
        `'${FULL_CLIPS_FOLDER_ID}' in parents`,
        'trashed = false',
        `properties has { key='match_id' and value='${match_id}' }`
      ].join(' and '),
      pageSize : 1000,
      fields   : 'files(id,name,properties)',
    });

    /* 2. מיון לפי segment_start_time_in_game (מספרי) */
    const files = (listResp.data.files || [])
      .filter(f => f.properties?.segment_start_time_in_game !== undefined)
      .sort((a,b) =>
        Number(a.properties.segment_start_time_in_game) -
        Number(b.properties.segment_start_time_in_game)
      );

    if (!files.length)
      return res.status(404).json({ error: 'No full clips for that match_id' });

    const startNum = Number(start);
    let prev = null, next = null;

    for (const f of files) {
      const segStart = Number(f.properties.segment_start_time_in_game);
      if (segStart <= startNum) prev = f;
      if (segStart >  startNum) { next = f; break; }
    }

    const candidates = [prev, next].filter(Boolean).map(f => ({
      external_id : f.id,
      name        : f.name,
      match_id    : f.properties.match_id,
      segment_start_time_in_game : f.properties.segment_start_time_in_game,
      view_url    : `https://drive.google.com/file/d/${f.id}/view`,
      download_url: `https://drive.google.com/uc?export=download&id=${f.id}`
    }));

    if (!candidates.length)
      return res.status(404).json({ error: 'No suitable full clips found' });

    res.json(candidates);          // <-- מערך (אחד או שניים)
  } catch (err) {
    console.error('[FULL-CLIP ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────── start server ───────────── */
app.listen(PORT, () => console.log(`📡 Server listening on port ${PORT}`));
