const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec }       = require('child_process');
const { google }     = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

/* ⇣  Google-Drive folder IDs  ⇣ */
const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* ---------- helpers ---------- */
function pad(n)        { return n.toString().padStart(2, '0'); }
function formatTime(s) { return `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(Math.floor(s%60))}`; }

async function downloadFileFromDrive(fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res  = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error',  reject);
  });
}

async function uploadToDriveUnified({ filePath, metadata, isFullClip = false }) {
  const folderId = isFullClip ? FULL_CLIPS_FOLDER_ID : SHORT_CLIPS_FOLDER_ID;

  const fileMetadata = {
    name: metadata.custom_name || path.basename(filePath),
    parents: [folderId],
    description: `match_id: ${metadata.match_id}, action_type: ${metadata.action_type}, player_name: ${metadata.player_name || ''}`,
    properties: {
      match_id                : metadata.match_id,
      action_type             : metadata.action_type,
      player_name             : metadata.player_name || '',
      team_color              : metadata.team_color || '',
      assist_player_name      : metadata.assist_player_name || '',
      segment_start_time_in_game: metadata.segment_start_time_in_game?.toString() || ''
    }
  };

  const media = { mimeType: 'video/webm', body: fs.createReadStream(filePath) };

  const res    = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id' });
  const fileId = res.data.id;

  await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });

  return {
    external_id       : fileId,
    name              : fileMetadata.name,
    view_url          : `https://drive.google.com/file/d/${fileId}/view`,
    download_url      : `https://drive.google.com/uc?export=download&id=${fileId}`,
    thumbnail_url     : '',
    duration          : metadata.duration,
    created_date      : new Date().toISOString(),
    match_id          : metadata.match_id,
    action_type       : metadata.action_type,
    player_name       : metadata.player_name || '',
    team_color        : metadata.team_color || '',
    assist_player_name: metadata.assist_player_name || ''
  };
}

/* ---------- MAIN  ---------- */
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
  const clipId     = uuidv4();
  const outputPath = `/tmp/clip_${clipId}.webm`;
  let   finalInput = '';

  /* merge (if needed) */
  if (previousFileId) {
    const in1  = `/tmp/input_${previousFileId}.webm`;
    const in2  = `/tmp/input_${fileId}.webm`;
    const merge= `/tmp/merged_${clipId}.webm`;

    await downloadFileFromDrive(previousFileId, in1);
    await downloadFileFromDrive(fileId,          in2);

    const mergeCmd = `ffmpeg -i ${in1} -i ${in2} -filter_complex "[0:v:0][1:v:0]concat=n=2:v=1[outv]" -map "[outv]" -y ${merge}`;
    console.log('🎬 FFmpeg Merge:', mergeCmd);

    await new Promise((res, rej) => exec(mergeCmd, err => err ? rej(err) : res()));
    [in1, in2].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    finalInput = merge;
  } else {
    finalInput = `/tmp/input_${fileId}.webm`;
    await downloadFileFromDrive(fileId, finalInput);
  }

  if (typeof startTimeInSec === 'string' && startTimeInSec.includes(':')) {
    const [h,m,s] = startTimeInSec.split(':').map(Number);
    startTimeInSec = h*3600 + m*60 + s;
  }

  /* cut */
  const cutCmd = `ffmpeg -ss ${startTimeInSec} -i ${finalInput} -t ${durationInSec} -c copy -y ${outputPath}`;
  console.log('✂️ FFmpeg Cut:', cutCmd);
  await new Promise((res, rej) => exec(cutCmd, err => err ? rej(err) : res()));

  const uploaded = await uploadToDriveUnified({
    filePath : outputPath,
    metadata : {
      match_id          : matchId,
      action_type       : actionType,
      player_name       : playerName,
      team_color        : teamColor,
      assist_player_name: assistPlayerName,
      duration          : durationInSec,
      created_date      : new Date().toISOString(),
      custom_name       : `clip_${matchId}_${clipId}.webm`
    },
    isFullClip: false
  });

  /* cleanup */
  [finalInput, outputPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  return uploaded;
}

module.exports = { formatTime, cutClipFromDriveFile, uploadToDrive: uploadToDriveUnified };
