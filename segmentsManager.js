const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

const FULL_CLIPS_FOLDER_ID  = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

/* ---------- helpers ---------- */
function pad(n) { return n.toString().padStart(2, '0'); }
function formatTime(s) {
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))}`;
}

async function downloadFileFromDrive(id, dst) {
  const out = fs.createWriteStream(dst);
  const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
  await new Promise((ok, err) => { res.data.pipe(out); out.on('finish', ok); out.on('error', err); });
}

async function uploadToDriveUnified({ filePath, metadata, isFullClip = false }) {
  const folderId = isFullClip ? FULL_CLIPS_FOLDER_ID : SHORT_CLIPS_FOLDER_ID;
  const meta = {
    name: metadata.custom_name || path.basename(filePath),
    parents: [folderId],
    properties: {
      match_id: metadata.match_id,
      action_type: metadata.action_type,
      player_name: metadata.player_name || '',
      team_color: metadata.team_color || '',
      assist_player_name: metadata.assist_player_name || '',
      segment_start_time_in_game: metadata.segment_start_time_in_game || ''
    }
  };
  const { data } = await drive.files.create({
    requestBody: meta,
    media: { mimeType: 'video/webm', body: fs.createReadStream(filePath) },
    fields: 'id'
  });
  await drive.permissions.create({ fileId: data.id, requestBody: { role: 'reader', type: 'anyone' } });
  return {
    ...metadata,
    external_id : data.id,
    name        : meta.name,
    view_url    : `https://drive.google.com/file/d/${data.id}/view`,
    download_url: `https://drive.google.com/uc?export=download&id=${data.id}`,
    created_date: new Date().toISOString()
  };
}

/* ---------- MAIN ---------- */
async function cutClipFromDriveFile({
  fileId,
  previousFileId = null,
  startTimeInSec,
  durationInSec,
  matchId,
  actionType,
  playerName,
  teamColor,
  assistPlayerName,
  segmentStartTimeInGame = ''
}) {
  const clipId = uuidv4();
  const out    = `/tmp/clip_${clipId}.webm`;
  let inFile   = '';

  /* ---- merge (demuxer-concat) ---- */
  if (previousFileId) {
    const in1   = `/tmp/in1_${clipId}.webm`;
    const in2   = `/tmp/in2_${clipId}.webm`;
    const list  = `/tmp/list_${clipId}.txt`;
    const merged= `/tmp/merged_${clipId}.webm`;

    await downloadFileFromDrive(previousFileId, in1);
    await downloadFileFromDrive(fileId, in2);
    fs.writeFileSync(list, `file '${in1}'\nfile '${in2}'\n`);

    const mergeCmd = `ffmpeg -f concat -safe 0 -i ${list} -c copy -y ${merged}`;
    console.log('🎬 FFmpeg Merge:', mergeCmd);
    await new Promise((ok, err) =>
      exec(mergeCmd, (e, _, se) => e ? (console.error('❌ Merge stderr:', se), err(e)) : ok())
    );
    [in1, in2, list].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    inFile = merged;
  } else {
    inFile = `/tmp/input_${clipId}.webm`;
    await downloadFileFromDrive(fileId, inFile);
  }

  if (typeof startTimeInSec === 'string') {
    const [h, m, s] = startTimeInSec.split(':').map(Number);
    startTimeInSec = h * 3600 + m * 60 + s;
  }

  /* ---- cut ---- */
  const cutCmd = `ffmpeg -ss ${startTimeInSec} -i ${inFile} -t ${durationInSec} -c copy -y ${out}`;
  console.log('✂️ FFmpeg Cut:', cutCmd);
  await new Promise((ok, err) =>
    exec(cutCmd, (e, _, se) => e ? (console.error('❌ Cut stderr:', se), err(e)) : ok())
  );

  const clip = await uploadToDriveUnified({
    filePath: out,
    metadata: {
      match_id: matchId,
      action_type: actionType,
      player_name: playerName,
      team_color: teamColor,
      assist_player_name: assistPlayerName,
      segment_start_time_in_game: segmentStartTimeInGame
    }
  });

  [inFile, out].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  return clip;
}

module.exports = {
  formatTime,
  cutClipFromDriveFile,
  uploadToDrive: uploadToDriveUnified
};
