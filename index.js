/* =========================================================================
 *  index.js  –  Football Clips Server (Render)
 *  26-May-2025   |   שינוי: cache זיכרון + limit ב־ /clips
 * ========================================================================= */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const { google } = require('googleapis');
const {
  uploadToDrive,
  formatTime,
  cutClipFromDriveFile
} = require('./segmentsManager');

/* ---------- Google Drive auth ---------- */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

/* ---------- constants ---------- */
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const CACHE_TTL_MS          = 60_000;   // 60 שניות

/* ---------- in-memory cache ---------- */
let clipsCache = { data: null, ts: 0 };

/* ---------- helpers ---------- */
const matchIdMap = Object.create(null);
function resolveMatchId(id, segStart){
  if(!matchIdMap[id] && Number(segStart) === 0){
    matchIdMap[id] = `${id}_${Date.now()}`;
    console.log('🆕  New matchId →', matchIdMap[id]);
  }
  return matchIdMap[id] || id;
}

function mapDriveFile(file){
  return {
    external_id        : file.id,
    name               : file.name,
    view_url           : `https://drive.google.com/file/d/${file.id}/view`,
    download_url       : `https://drive.google.com/uc?export=download&id=${file.id}`,
    created_date       : file.createdTime,
    match_id           : file.properties?.match_id           || '',
    action_type        : file.properties?.action_type        || '',
    player_name        : file.properties?.player_name        || '',
    team_color         : file.properties?.team_color         || '',
    assist_player_name : file.properties?.assist_player_name || '',
    segment_start_time_in_game : file.properties?.segment_start_time_in_game || ''
  };
}

/* ---------- express ---------- */
const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------- health ---------- */
app.get('/health', (_, res) => res.send('OK'));

/* ---------- upload-segment (unchanged) ---------- */
app.post('/upload-segment', upload.single('file'), async (req,res)=>{
  try{
    const { match_id, segment_start_time_in_game, end_time } = req.body;
    const matchId = resolveMatchId(match_id, segment_start_time_in_game);

    console.log('📤 Uploading segment:', req.file.originalname);
    const clip = await uploadToDrive({
      filePath : req.file.path,
      metadata : {
        custom_name: req.file.originalname,
        match_id   : matchId,
        duration   : end_time || '00:00:20',
        segment_start_time_in_game
      },
      isFullClip : true
    });
    res.json({ success: true, clip, match_id: matchId });
  }catch(e){
    console.error('[UPLOAD ERROR]', e.message);
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ---------- auto-generate-clips (unchanged) ---------- */
app.post('/auto-generate-clips', async (req,res)=>{
  const { match_id, actions=[], segments=[] } = req.body;
  const matchId = matchIdMap[match_id] || match_id;
  res.json({ success:true, message:'processing', match_id:matchId });

  for(const a of actions){
    const seg = segments.find(s=>{
      const s0 = Number(s.segment_start_time_in_game);
      return a.timestamp_in_game >= s0 && a.timestamp_in_game < s0 + Number(s.duration||20);
    });
    if(!seg) continue;

    const rel   = a.timestamp_in_game - Number(seg.segment_start_time_in_game);
    let start   = Math.max(0, rel-8);
    let prev_id = null;
    if(rel < 3){
      const idx = segments.indexOf(seg);
      if(idx>0){
        prev_id = segments[idx-1].file_id;
        start   = Number(seg.duration||20) + rel - 8;
      }
    }

    try{
      await cutClipFromDriveFile({
        fileId           : seg.file_id,
        previousFileId   : prev_id,
        startTimeInSec   : start,
        durationInSec    : 8,
        matchId,
        actionType       : a.action_type,
        playerName       : a.player_name,
        teamColor        : a.team_color,
        assistPlayerName : a.assist_player_name,
        segmentStartTimeInGame: seg.segment_start_time_in_game
      });
      console.log('✅ Auto-clip done', a.action_type, '@', a.timestamp_in_game);
    }catch(e){ console.error('[auto-cut]', e.message); }
  }
});

/* ---------- manual generate (unchanged) ---------- */
app.post('/generate-clips', async (req,res)=>{
  try{
    const { file_id, match_id, start_time, duration, action_type,
            player_name, team_color, assist_player_name } = req.body;

    const clip = await cutClipFromDriveFile({
      fileId           : file_id,
      matchId          : match_id,
      startTimeInSec   : formatTime(Number(start_time)),
      durationInSec    : Number(duration),
      actionType       : action_type,
      playerName       : player_name,
      teamColor        : team_color,
      assistPlayerName : assist_player_name
    });
    res.json({ success:true, clip });
  }catch(e){
    console.error('[MANUAL CUT ERROR]', e.message);
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ---------- /clips  (NOW WITH CACHE + LIMIT) ---------- */
app.get('/clips', async (req,res)=>{
  try{
    const queryLimit = Number(req.query.limit) || null; // ?limit=50
    const useCache   = Date.now() - clipsCache.ts < CACHE_TTL_MS;

    if(useCache){
      console.log('🗄️  /clips → cache hit');
      const data = queryLimit ? clipsCache.data.slice(0, queryLimit) : clipsCache.data;
      return res.json(data);
    }

    console.log('🌐  /clips → fetching from Drive …');
    const list = await drive.files.list({
      q      : `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed=false`,
      fields : 'files(id,name,createdTime,properties)',
      orderBy: 'createdTime desc'
    });

    const clips = list.data.files.map(mapDriveFile);
    clipsCache = { data: clips, ts: Date.now() };

    res.json(queryLimit ? clips.slice(0, queryLimit) : clips);
  }catch(e){
    console.error('[ERROR] /clips:', e.message);
    res.status(500).json({ error:'Failed to load clips' });
  }
});

/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('📡 server ready on', PORT));
