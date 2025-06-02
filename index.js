/* index.js – SERVER */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile
} = require('./segmentsManager');

/* ─────────── Google Drive ─────────── */
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

/* ─────────── חיתוך ─────────── */
const BACKWARD_OFFSET_SEC = 13;
const CLIP_DURATION_SEC   = 12;

/* helper */
function toSeconds(v){
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.includes(':')) return v.split(':').map(Number).reduce((t,n)=>t*60+n,0);
  const n = Number(v); return Number.isNaN(n)?0:n;
}

/* ───────────── app ───────────── */
const app  = express();
const PORT = process.env.PORT || 3000;

/* Multer – כותבים ל-/tmp/uploads */
const uploadDir = path.join(os.tmpdir(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest   : uploadDir,
  limits : { fileSize: 50 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

app.get('/health', (_,res)=>res.json({ ok:true }));

/* ───── upload-segment ───── */
app.post('/upload-segment', (req,res)=>{
  upload.single('file')(req,res,async err=>{
    if (err){
      console.error('[MULTER]',err);
      return res.status(400).json({ success:false, error: err.message });
    }
    try{
      const { file } = req;
      const { match_id, segment_start_time_in_game=0, duration='00:00:20' } = req.body;

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

      fs.unlink(file.path, ()=>{});
      res.json({ success:true, clip:uploaded });
    }catch(e){
      console.error('[UPLOAD]',e);
      res.status(500).json({ success:false, error:e.message });
    }
  });
});

/* ───── auto-generate-clips ───── */
app.post('/auto-generate-clips', async (req,res)=>{
  const { match_id, actions=[], segments=[] } = req.body;
  res.json({ success:true });                             // ack

  const segs=[...segments].sort(
    (a,b)=>Number(a.segment_start_time_in_game)-Number(b.segment_start_time_in_game)
  );

  for (const act of actions){
    try{
      const seg = segs.find(s=>{
        const start=Number(s.segment_start_time_in_game);
        const dur=toSeconds(s.duration)||20;
        return act.timestamp_in_game>=start && act.timestamp_in_game<start+dur;
      });
      if(!seg){ console.warn('⚠️ no seg for',act.timestamp_in_game); continue; }

      const rel = act.timestamp_in_game-Number(seg.segment_start_time_in_game);
      let startSec=Math.max(0, rel-BACKWARD_OFFSET_SEC);
      let prev=null;

      if(rel < BACKWARD_OFFSET_SEC){
        prev=segs.filter(s=>Number(s.segment_start_time_in_game)<Number(seg.segment_start_time_in_game)).pop();
        if(prev){
          startSec=(toSeconds(prev.duration)||20)+rel-BACKWARD_OFFSET_SEC;
          if(startSec<0) startSec=0;
        }
      }

      await cutClipFromDriveFile({
        fileId         : seg.file_id,
        previousFileId : prev?prev.file_id:null,
        startTimeInSec : startSec,
        durationInSec  : CLIP_DURATION_SEC,
        matchId        : match_id,
        actionType     : act.action_type,
        playerName     : act.player_name,
        teamColor      : act.team_color,
        assistPlayerName: act.assist_player_name,
        segmentStartTimeInGame: seg.segment_start_time_in_game
      });
    }catch(e){ console.error('[CLIP]',e); }
  }
});

/* ───── clips feed  (/clips?limit&before) ───── */
app.get('/clips', async (req,res)=>{
  try{
    const limit  = Math.min(Number(req.query.limit)||100, 200);
    const before = req.query.before ? new Date(req.query.before).toISOString() : null;

    const q = [
      `'${SHORT_CLIPS_FOLDER_ID}' in parents`,
      'trashed = false'
    ];
    if (before) q.push(`createdTime < '${before}'`);

    const resp = await drive.files.list({
      q        : q.join(' and '),
      pageSize : limit,
      fields   : 'files(id,name,createdTime,properties)',
      orderBy  : 'createdTime desc'
    });

    const clips = (resp.data.files||[]).map(f=>({
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
  }catch(e){
    console.error('[CLIPS]',e);
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ───── FULL-CLIP helper  (/full-clip) ───── */
app.get('/full-clip', async (req,res)=>{
  try{
    const { match_id, start } = req.query;
    if(!match_id||start===undefined) return res.status(400).json({ error:'Missing params' });

    const list = await drive.files.list({
      q: [
        `'${FULL_CLIPS_FOLDER_ID}' in parents`,
        'trashed = false',
        `properties has { key='match_id' and value='${match_id}' }`
      ].join(' and '),
      pageSize:1000,
      fields :'files(id,name,properties)'
    });

    const files = (list.data.files||[])
      .filter(f=>f.properties?.segment_start_time_in_game!==undefined)
      .sort((a,b)=>Number(a.properties.segment_start_time_in_game)-Number(b.properties.segment_start_time_in_game));

    if(!files.length) return res.status(404).json({ error:'no full clips' });

    const sNum = Number(start);
    let prev=null, next=null;
    for(const f of files){
      const st=Number(f.properties.segment_start_time_in_game);
      if(st<=sNum) prev=f;
      if(st>sNum){ next=f; break; }
    }
    const cand=[prev,next].filter(Boolean).map(f=>({
      external_id:f.id,
      name:f.name,
      match_id:f.properties.match_id,
      segment_start_time_in_game:f.properties.segment_start_time_in_game,
      view_url:`https://drive.google.com/file/d/${f.id}/view`,
      download_url:`https://drive.google.com/uc?export=download&id=${f.id}`
    }));
    if(!cand.length) return res.status(404).json({ error:'no suitable full clips' });
    res.json(cand);
  }catch(e){
    console.error('[FULL-CLIP]',e);
    res.status(500).json({ error:e.message });
  }
});

/* ───── fallback JSON error ───── */
app.use((err,req,res,next)=>{
  console.error('[EXPRESS]',err);
  res.status(err.status||500).json({ success:false, error:err.message||'server' });
});

app.listen(PORT, ()=>console.log(`📡 server on ${PORT}`));
