const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec }       = require('child_process');
const { google }     = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

function pad(n)        { return n.toString().padStart(2, '0'); }
function formatTime(s) { return `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(Math.floor(s%60))}`; }

async function downloadFileFromDrive(fileId, dest) {
  const dst = fs.createWriteStream(dest);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((ok, err) => {
    res.data.pipe(dst);
    dst.on('finish', ok);
    dst.on('error',  err);
  });
}

async function uploadToDriveUnified({ filePath, metadata, isFullClip = false }) {
  const folderId = isFullClip ? FULL_CLIPS_FOLDER_ID : SHORT_CLIPS_FOLDER_ID;
  const meta = {
    name: metadata.custom_name || path.basename(filePath),
    parents: [folderId],
    properties: {
      match_id                : metadata.match_id,
      action_type             : metadata.action_type,
      player_name             : metadata.player_name || '',
      team_color              : metadata.team_color || '',
      assist_player_name      : metadata.assist_player_name || ''
    }
  };

  const { data } = await drive.files.create({
    requestBody: meta,
    media      : { mimeType: 'video/webm', body: fs.createReadStream(filePath) },
    fields     : 'id'
  });

  await drive.permissions.create({ fileId: data.id, requestBody: { role: 'reader', type: 'anyone' } });

  return {
    external_id: data.id,
    name       : meta.name,
    view_url   : `https://drive.google.com/file/d/${data.id}/view`,
    download_url: `https://drive.google.com/uc?export=download&id=${data.id}`,
    created_date: new Date().toISOString(),
    ...metadata
  };
}

async function cutClipFromDriveFile({
  fileId,
  previousFileId = null,
  startTimeInSec,
  durationInSec,
  matchId,
  actionType,
  playerName,
  teamColor,
  assistPlayerName
}) {
  const clipId = uuidv4();
  const out    = `/tmp/clip_${clipId}.webm`;
  let   inFile = '';

  /* ========== merge (optional) ========== */
  if (previousFileId) {
    const in1 = `/tmp/in1_${clipId}.webm`;
    const in2 = `/tmp/in2_${clipId}.webm`;
    const merged = `/tmp/merged_${clipId}.webm`;

    await downloadFileFromDrive(previousFileId, in1);
    await downloadFileFromDrive(fileId,         in2);

    const mergeCmd = `ffmpeg -i ${in1} -i ${in2} -filter_complex "[0:v:0][1:v:0]concat=n=2:v=1[outv]" -map "[outv]" -y ${merged}`;
    console.log('🎬 FFmpeg Merge:', mergeCmd);
    await new Promise((ok, err) => exec(mergeCmd, e => e ? err(e) : ok()));

    [in1,in2].forEach(p => fs.existsSync(p)&&fs.unlinkSync(p));
    inFile = merged;
  } else {
    inFile = `/tmp/input_${clipId}.webm`;
    await downloadFileFromDrive(fileId, inFile);
  }

  if (typeof startTimeInSec === 'string') {
    const [h,m,s] = startTimeInSec.split(':').map(Number);
    startTimeInSec = h*3600 + m*60 + s;
  }

  /* ========== cut ========== */
  const cutCmd = `ffmpeg -ss ${startTimeInSec} -i ${inFile} -t ${durationInSec} -c copy -y ${out}`;
  console.log('✂️ FFmpeg Cut:', cutCmd);

  await new Promise((ok, err) => {
    exec(cutCmd, (e, _, stderr) => {
      if (e) {
        console.error('❌ FFmpeg Cut failed:', e.message);
        console.error('stderr:', stderr);
        return err(e);
      }
      ok();
    });
  });

  const uploaded = await uploadToDriveUnified({
    filePath: out,
    metadata: {
      match_id          : matchId,
      action_type       : actionType,
      player_name       : playerName,
      team_color        : teamColor,
      assist_player_name: assistPlayerName
    }
  });

  [inFile,out].forEach(p => fs.existsSync(p)&&fs.unlinkSync(p));
  return uploaded;
}

module.exports = { formatTime, cutClipFromDriveFile, uploadToDrive: uploadToDriveUnified };
