/* ---------- imports והגדרות שכבר קיימות אצלך ---------- */
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

/* ---------- Google Drive ---------- */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

/* ---------- helper: matchId (היה חסר ונוסף קודם) ---------- */
const matchIdMap = Object.create(null);
function resolveMatchId(origId, segStart) {
  const first = Number(segStart) === 0;
  if (!matchIdMap[origId] && first) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;
    console.log(`🆕  New matchId → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;
}

/* ---------- app / CORS / body-parsers (ללא שינוי) ---------- */
const app    = express();
const upload = multer({ dest: 'uploads/' });
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------- health ---------- */
app.get('/health', (_,res)=>res.send('OK'));

/* ---------- upload-segment endpoint (כמו שהיה) ---------- */
app.post('/upload-segment', upload.single('file'), async (req,res)=>{
  try {
    const { match_id:startId, segment_start_time_in_game } = req.body;
    const file    = req.file;
    const matchId = resolveMatchId(startId, segment_start_time_in_game);

    console.log('📤 Uploading segment:', {
      name:file.originalname, matchId, segment_start_time_in_game
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name : file.originalname,
        match_id    : matchId,
        duration    : req.body.end_time || '00:00:20',
        segment_start_time_in_game
      },
      isFullClip:true
    });

    res.json({ success:true, clip:uploaded, match_id:matchId });
  } catch(err){
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success:false, error:err.message });
  }
});

/* ------------------------------------------------------------------
   🛠  **תיקון** – /auto-generate-clips
   ------------------------------------------------------------------ */

/* ממיר "hh:mm:ss" -> seconds */
function hmsToSeconds(str){
  if(!str || typeof str !== 'string' || !str.includes(':')) return Number(str)||0;
  const [h,m,s] = str.split(':').map(Number);
  return (h||0)*3600 + (m||0)*60 + (s||0);
}

app.post('/auto-generate-clips', async (req,res)=>{
  try {
    const { match_id:startId, actions=[], segments=[] } = req.body;
    const matchId = matchIdMap[startId] || startId;

    console.log('✂️ Auto clip request:', { matchId, actions:actions.length, segments:segments.length });
    res.json({ success:true, message:'processing', match_id:matchId });

    for (const act of actions){
      const { timestamp_in_game, action_type, player_name,
              team_color='', assist_player_name='' } = act;

      /* --- מציאת סגמנט --- */
      const seg = segments.find(s=>{
        const segStart = Number(s.segment_start_time_in_game);
        const segDur   = hmsToSeconds(s.duration) || 20;   // <-- תיקון
        const segEnd   = segStart + segDur;
        return timestamp_in_game >= segStart && timestamp_in_game < segEnd;
      });

      if(!seg){
        console.warn(`⚠️  No segment found for action @${timestamp_in_game}s`);
        continue;
      }

      const relative = timestamp_in_game - Number(seg.segment_start_time_in_game);
      const startSec = Math.max(0, relative - 8);
      const durSec   = Math.min(8, relative);

      console.log(`✂️  Cutting clip ${seg.file_id} @${startSec}s for ${durSec}s`);

      try{
        await cutClipFromDriveFile({
          fileId         : seg.file_id,
          matchId,
          startTimeInSec : startSec,
          durationInSec  : durSec,
          actionType     : action_type,
          playerName     : player_name,
          teamColor      : team_color,
          assistPlayerName: assist_player_name
        });
      }catch(e){
        console.error(`[CUT ERROR] ${e.message}`);
      }
    }
  }catch(err){
    console.error('[AUTO-CLIP ERROR]', err);
  }
});

/* ---------- endpoints /generate-clips, /clips (ללא שינוי) ---------- */

/* ---------- start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`📡 Server listening on port ${PORT}`));
