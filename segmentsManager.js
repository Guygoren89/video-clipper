const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // ← ודא שזה נכון

function formatTime(seconds) {
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `00:${mins}:${secs}`;
}

async function downloadFileFromDrive(fileId, destinationPath) {
  const dest = fs.createWriteStream(destinationPath);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });
}

async function uploadToDrive({ filePath, metadata, custom_name = null }) {
  const fileMetadata = {
    name: custom_name || path.basename(filePath),
    parents: [SHORT_CLIPS_FOLDER],
    description: `match_id: ${metadata.match_id}`,
    properties: {
      match_id: metadata.match_id,
      action_type: metadata.action_type || 'clip'
    }
  };

  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(filePath)
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, webViewLink, webContentLink'
  });

  const fileId = res.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  return {
    external_id: metadata.clip_id,
    name: fileMetadata.name,
    view_url: res.data.webViewLink,
    download_url: res.data.webContentLink,
    duration: metadata.duration,
    created_date: metadata.created_date,
    match_id: metadata.match_id,
    player_id: metadata.player_id,
    player_name: metadata.player_name,
    action_type: metadata.action_type
  };
}

async function cutClipFromDriveFile({
  fileId,
  matchId,
  startTimeInSec,
  durationInSec,
  actionType = 'auto_clip'
}) {
  const inputPath = `/tmp/input_${Date.now()}.webm`;
  const outputId = uuidv4();
  const outputPath = `/tmp/clip_${outputId}.webm`;

  await downloadFileFromDrive(fileId, inputPath);

  const command = `ffmpeg -ss ${startTimeInSec} -i ${inputPath} -t ${durationInSec} -c:v libvpx -an -y ${outputPath}`;
  console.log('🎬 FFmpeg command:', command);

  await new Promise((resolve, reject) => {
    exec(command, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const uploaded = await uploadToDrive({
    filePath: outputPath,
    metadata: {
      clip_id: outputId,
      match_id: matchId,
      created_date: new Date().toISOString(),
      duration: durationInSec.toString(),
      action_type: actionType
    },
    custom_name: `clip_${matchId}_${outputId}.webm`
  });

  // ניקוי קבצים זמניים
  if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  return uploaded;
}

module.exports = {
  formatTime,
  cutClipFromDriveFile
};
