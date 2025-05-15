const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

// תיקייה לקליפים באורך 20 שניות
const FULL_CLIPS_FOLDER_ID = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';
// תיקייה לקליפים קצרים של 8 שניות
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

async function downloadFileFromDrive(fileId, destinationPath) {
  const dest = fs.createWriteStream(destinationPath);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });
}

async function uploadToDriveUnified({ filePath, metadata, isFullClip = false }) {
  const folderId = isFullClip ? FULL_CLIPS_FOLDER_ID : SHORT_CLIPS_FOLDER_ID;

  const fileMetadata = {
    name: metadata.custom_name || path.basename(filePath),
    parents: [folderId],
    description: `match_id: ${metadata.match_id}, action_type: ${metadata.action_type}`,
    properties: {
      match_id: metadata.match_id,
      action_type: metadata.action_type,
      segment_start_time_in_game: metadata.segment_start_time_in_game?.toString() || '',
    }
  };

  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(filePath),
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id',
  });

  const fileId = res.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return {
    external_id: fileId,
    name: fileMetadata.name,
    view_url: `https://drive.google.com/file/d/${fileId}/view`,
    download_url: `https://drive.google.com/uc?export=download&id=${fileId}`,
    thumbnail_url: '',
    duration: metadata.duration,
    created_date: new Date().toISOString(),
    match_id: metadata.match_id,
    action_type: metadata.action_type
  };
}

async function cutClipFromDriveFile({ fileId, startTimeInSec, durationInSec, matchId, actionType }) {
  const inputPath = `/tmp/input_${fileId}.webm`;
  const clipId = uuidv4();
  const outputPath = `/tmp/clip_${clipId}.webm`;

  await downloadFileFromDrive(fileId, inputPath);

  const command = `ffmpeg -ss ${startTimeInSec} -i ${inputPath} -t ${durationInSec} -c:v libvpx -an -y ${outputPath}`;
  console.log('🎬 FFmpeg:', command);

  await new Promise((resolve, reject) => {
    exec(command, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const uploaded = await uploadToDriveUnified({
    filePath: outputPath,
    metadata: {
      match_id: matchId,
      action_type: actionType,
      duration: durationInSec,
      created_date: new Date().toISOString(),
      custom_name: `clip_${matchId}_${clipId}.webm`,
    },
    isFullClip: false
  });

  if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  return uploaded;
}

module.exports = {
  formatTime,
  cutClipFromDriveFile,
  uploadToDrive: uploadToDriveUnified // משמש גם להעלאת מקטעים מלאים
};
