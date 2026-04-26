/* index.js – SERVER */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile
} = require('./segmentsManager');

const {
  saveIncomingSegment,
  pruneOldSegments,
  getSegmentsForClip
} = require('./bufferManager');

const execFileAsync = promisify(execFile);

/* ─────────── ENV ─────────── */
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;
const BUFFER_WINDOW_SECONDS = Number(process.env.BUFFER_WINDOW_SECONDS || 300);
const RENDER_INTERNAL_SECRET = process.env.RENDER_INTERNAL_SECRET || '';

/* ─────────── Google Drive ─────────── */
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const FULL_CLIPS_FOLDER_ID = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

/* ─────────── חיתוך ─────────── */
const BACKWARD_OFFSET_SEC = 13;
const CLIP_DURATION_SEC = 12;

/* helper */
function toSeconds(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.includes(':')) return v.split(':').map(Number).reduce((t, n) => t * 60 + n, 0);
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function ensureBase44Env() {
  if (!BASE44_APP_ID || !BASE44_API_KEY) {
    throw new Error('Missing BASE44_APP_ID or BASE44_API_KEY in environment variables');
  }
}

async function callBase44Function(functionName, payload, extraHeaders = {}) {
  ensureBase44Env();

  const response = await fetch(
    `https://herut-football-6798c5e8.base44.app/api/apps/${BASE44_APP_ID}/functions/${functionName}`,
    {
      method: 'POST',
      headers: {
        api_key: BASE44_API_KEY,
        'Content-Type': 'application/json',
        'x-api-key': RENDER_INTERNAL_SECRET,
        ...extraHeaders
      },
      body: JSON.stringify(payload || {})
    }
  );

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`Invalid JSON from Base44 function ${functionName}: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Base44 function ${functionName} failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

function getTargetCamera(teamSides, goal, game) {
  if (!teamSides || !teamSides.left || !teamSides.right) {
    throw new Error('team_sides missing or incomplete');
  }

  const scoringTeamColor = goal.team === 'team1' ? game.team1 : game.team2;

  let scoringSide = null;
  if (teamSides.left === scoringTeamColor) scoringSide = 'left';
  if (teamSides.right === scoringTeamColor) scoringSide = 'right';

  if (!scoringSide) {
    throw new Error(`Could not determine scoring side. goal.team=${goal.team}, scoringTeamColor=${scoringTeamColor}, teamSides=${JSON.stringify(teamSides)}`);
  }

  const targetCamera = scoringSide === 'left' ? 'right' : 'left';

  console.log('[CAMERA SELECT]', {
    goal_id: goal.id,
    goal_team: goal.team,
    scoring_team_color: scoringTeamColor,
    team_sides: teamSides,
    scoring_side: scoringSide,
    target_camera: targetCamera
  });

  return targetCamera;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function concatAndTrimSegments({ segmentPaths, trimStart, outputPath }) {
  if (!segmentPaths || segmentPaths.length === 0) {
    throw new Error('No segment paths provided');
  }

  if (segmentPaths.length === 1) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(trimStart),
      '-i', segmentPaths[0],
      '-t', String(CLIP_DURATION_SEC),
      '-c', 'copy',
      outputPath
    ]);
    return;
  }

  const workDir = path.dirname(outputPath);
  const concatListPath = path.join(workDir, `concat_${uuidv4()}.txt`);
  const mergedPath = path.join(workDir, `merged_${uuidv4()}.webm`);

  const concatText = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');

  await fsp.writeFile(concatListPath, concatText, 'utf8');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    mergedPath
  ]);

  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', String(trimStart),
    '-i', mergedPath,
    '-t', String(CLIP_DURATION_SEC),
    '-c', 'copy',
    outputPath
  ]);

  try { await fsp.unlink(concatListPath); } catch (_) {}
  try { await fsp.unlink(mergedPath); } catch (_) {}
}

async function uploadProcessedClipToBase44({ goalId, filePath }) {
  ensureBase44Env();

  const form = new FormData();
  const fileBuffer = await fsp.readFile(filePath);
  const file = new File([fileBuffer], `goal_${goalId}.webm`, { type: 'video/webm' });

  form.append('file', file);
  form.append('goal_id', goalId);

  const response = await fetch(
    `https://herut-football-6798c5e8.base44.app/api/apps/${BASE44_APP_ID}/functions/uploadProcessedClip`,
    {
      method: 'POST',
      headers: {
        api_key: BASE44_API_KEY,
        'x-api-key': RENDER_INTERNAL_SECRET
      },
      body: form
    }
  );

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`Invalid JSON from uploadProcessedClip: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`uploadProcessedClip failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

/* ───────────── app ───────────── */
const app = express();
const PORT = process.env.PORT || 3000;

/* Multer – כותבים ל-/tmp/uploads */
const uploadDir = path.join(os.tmpdir(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

app.get('/health', (_, res) => res.json({
  ok: true,
  buffer_window_seconds: BUFFER_WINDOW_SECONDS
}));

/* ───── upload-segment-buffer (NEW) ───── */
app.post('/upload-segment-buffer', (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) {
      console.error('[MULTER BUFFER]', err);
      return res.status(400).json({ success: false, error: err.message });
    }

    try {
      const { file } = req;
      const {
        match_id,
        camera_id,
        segment_start_time = 0,
        duration = 20
      } = req.body;

      console.log('[SEGMENT UPLOAD RECEIVED]', {
        match_id,
        camera_id,
        segment_start_time,
        duration,
        file_size: file?.size
      });

      if (!file) {
        return res.status(400).json({ success: false, error: 'file is required' });
      }

      if (!match_id || !camera_id) {
        return res.status(400).json({
          success: false,
          error: 'match_id and camera_id are required'
        });
      }

      const saved = await saveIncomingSegment({
        tempFilePath: file.path,
        originalName: file.originalname || `segment_${Date.now()}.webm`,
        matchId: match_id,
        cameraId: camera_id,
        segmentStartTime: Number(segment_start_time || 0),
        duration: Number(duration || 20)
      });

      const pruneResult = await pruneOldSegments(
        match_id,
        camera_id,
        Number(segment_start_time || 0)
      );

      console.log('[SEGMENT BUFFERED]', {
        match_id,
        camera_id,
        segment_start_time: saved.segment_start_time,
        duration: saved.duration,
        filename: saved.filename,
        cleanup: pruneResult
      });

      fs.unlink(file.path, () => {});

      return res.json({
        success: true,
        buffered: true,
        segment: saved,
        cleanup: pruneResult
      });
    } catch (e) {
      console.error('[UPLOAD BUFFER]', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });
});

/* ───── process-goal (NEW) ───── */
app.post('/process-goal', async (req, res) => {
  try {
    const providedSecret = req.headers['x-api-key'] || '';
    if (RENDER_INTERNAL_SECRET && providedSecret !== RENDER_INTERNAL_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { goal_id } = req.body || {};
    console.log('[PROCESS GOAL START]', { goal_id });

    if (!goal_id) {
      return res.status(400).json({ success: false, error: 'goal_id is required' });
    }

    const fullData = await callBase44Function('getGoalFullData', { goal_id });
    const goal = fullData.goal;
    const game = fullData.game;
    const teamSides = fullData.team_sides;

    console.log('[GOAL DATA LOADED]', {
      goal_id,
      goal_team: goal?.team,
      goal_time: goal?.time,
      game_id: game?.id,
      game_team1: game?.team1,
      game_team2: game?.team2,
      team_sides: teamSides
    });

    if (!goal || !game) {
      return res.status(404).json({ success: false, error: 'Goal or Game not found' });
    }

    if (goal.video_clip_uri) {
      console.log('[PROCESS GOAL SKIPPED]', {
        goal_id,
        reason: 'already_has_clip',
        video_clip_uri: goal.video_clip_uri
      });
      return res.json({ success: true, skipped: true, reason: 'already_has_clip' });
    }

    const targetCamera = getTargetCamera(teamSides, goal, game);

    const clipStart = Math.max(0, Number(goal.time || 0) - BACKWARD_OFFSET_SEC);
    const clipEnd = clipStart + CLIP_DURATION_SEC;

    const relevantSegments = await getSegmentsForClip({
      matchId: goal.game_id,
      cameraId: targetCamera,
      clipStart,
      clipEnd
    });

    console.log('[SEGMENTS FOUND]', {
      goal_id,
      target_camera: targetCamera,
      clip_start: clipStart,
      clip_end: clipEnd,
      count: relevantSegments.length,
      segments: relevantSegments.map(s => ({
        filename: s.filename,
        segment_start_time: s.segment_start_time,
        duration: s.duration
      }))
    });

    if (!relevantSegments.length) {
      return res.status(404).json({
        success: false,
        error: 'No buffered segments found for goal',
        goal_id,
        target_camera: targetCamera,
        clip_start: clipStart,
        clip_end: clipEnd
      });
    }

    const tempWorkDir = path.join(os.tmpdir(), `goal-${goal_id}-${uuidv4()}`);
    await ensureDir(tempWorkDir);

    const outputPath = path.join(tempWorkDir, `goal_${goal_id}.webm`);
    const trimStart = Math.max(0, clipStart - Number(relevantSegments[0].segment_start_time || 0));
    const segmentPaths = relevantSegments.map((s) => s.path);

    console.log('[FFMPEG START]', {
      goal_id,
      target_camera: targetCamera,
      trim_start: trimStart,
      output_path: outputPath,
      segment_paths: segmentPaths
    });

    await concatAndTrimSegments({
      segmentPaths,
      trimStart,
      outputPath
    });

    console.log('[FFMPEG DONE]', {
      goal_id,
      output_path: outputPath
    });

    const uploadResult = await uploadProcessedClipToBase44({
      goalId: goal_id,
      filePath: outputPath
    });

    console.log('[PROCESS GOAL SUCCESS]', {
      goal_id,
      target_camera: targetCamera,
      upload_result: uploadResult
    });

    try {
      await fsp.rm(tempWorkDir, { recursive: true, force: true });
    } catch (_) {}

    return res.json({
      success: true,
      goal_id,
      target_camera: targetCamera,
      clip_start: clipStart,
      clip_end: clipEnd,
      segments_used: relevantSegments.map((s) => ({
        filename: s.filename,
        segment_start_time: s.segment_start_time,
        duration: s.duration
      })),
      upload_result: uploadResult
    });
  } catch (e) {
    console.error('[PROCESS GOAL]', e);
    return res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

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
  res.json({ success:true });

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

    if(!files.length) return res.status(404).json({ error:'no suitable full clips' });

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
