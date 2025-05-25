const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const { google } = require('googleapis');
const { uploadToDrive, cutClipFromDriveFile } = require('./segmentsManager');

const SCOPES=['https://www.googleapis.com/auth/drive'];
const auth  =new google.auth.GoogleAuth({scopes:SCOPES});
const drive =google.drive({version:'v3',auth});
const SHORT_CLIPS_FOLDER_ID='1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

const matchIdMap=Object.create(null);
function resolveMatchId(id,start){if(!matchIdMap[id]&&Number(start)===0)matchIdMap[id]=`${id}_${Date.now()}`;return matchIdMap[id]||id;}

const app=express();
app.use(cors({origin:true}));
app.use(express.json({limit:'10mb'}));
const upload=multer({dest:'uploads/'});

app.get('/health',(_,r)=>r.send('OK'));

/* upload-segment */
app.post('/upload-segment',upload.single('file'),async(req,res)=>{
  try{
    const {match_id,segment_start_time_in_game,end_time}=req.body;
    const matchId=resolveMatchId(match_id,segment_start_time_in_game);
    const clip=await uploadToDrive({filePath:req.file.path,metadata:{
      custom_name:req.file.originalname,
      match_id:matchId,
      duration:end_time||'00:00:20',
      segment_start_time_in_game
    },isFullClip:true});
    res.json({success:true,clip,match_id:matchId});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

/* auto-generate-clips */
app.post('/auto-generate-clips',async(req,res)=>{
  const {match_id,actions=[],segments=[]}=req.body;
  const matchId=matchIdMap[match_id]||match_id;
  res.json({success:true,message:'processing',match_id});
  for(const a of actions){
    const seg=segments.find(s=>{
      const s0=Number(s.segment_start_time_in_game);
      return a.timestamp_in_game>=s0&&a.timestamp_in_game<s0+Number(s.duration||20);
    });
    if(!seg)continue;
    const rel=a.timestamp_in_game-Number(seg.segment_start_time_in_game);
    let start=Math.max(0,rel-8),prev=null;
    if(rel<3){
      const idx=segments.indexOf(seg);
      if(idx>0){prev=segments[idx-1].file_id;start=Number(seg.duration||20)+rel-8;}
    }
    try{
      await cutClipFromDriveFile({
        fileId:seg.file_id,previousFileId:prev,
        startTimeInSec:start,durationInSec:8,matchId,
        actionType:a.action_type,playerName:a.player_name,
        teamColor:a.team_color,assistPlayerName:a.assist_player_name
      });
    }catch(e){console.error('[auto-cut]',e.message);}
  }
});

/* clips feed */
app.get('/clips',async(_,res)=>{
  const list=await drive.files.list({q:`'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed=false`,
    fields:'files(id,name,createdTime,properties)',orderBy:'createdTime desc'});
  res.json(list.data.files.map(f=>({...f.properties,external_id:f.id,name:f.name,
    view_url:`https://drive.google.com/file/d/${f.id}/view`,
    download_url:`https://drive.google.com/uc?export=download&id=${f.id}`,
    created_date:f.createdTime})));
});

app.listen(process.env.PORT||3000,()=>console.log('📡 server ready'));
