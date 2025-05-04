const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadToDrive } = require('./driveUploader');

const TEMP_FOLDER = '/tmp';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

async function downloadFile(fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    res.data.on('end', resolve).on('error', reject).pipe(dest);
  });
}

// עוזר להחסיר שניות ממחרוזת זמן
function subtractSecondsFromTimestamp(timestamp, seconds) {
  const [hh, mm, ss] = timestamp.split(':').map(Number);
  let total = hh * 3600 + mm * 60 + ss;
  total = Math.max(0, total - seconds);
  const newH = String(Math.floor(total / 3600)).padStart(2, '0');
  const newM = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const newS = String(total % 60).padStart(2, '0');
  return `${newH}:${newM}:${newS}`;
}

async function cutClip(fileId, startTime, duration = '00:00:08', extraMetadata = {}) {
  const timestamp = Date.now();
  const inputPath = path.join(TEMP_FOLDER, `input_${timestamp}.webm`);
  const outputPath = path.join(TEMP_FOLDER, `clip_${timestamp}.webm`);

  await downloadFile(fileId, inputPath);

  const startBefore = subtractSecondsFromTimestamp(startTime, 8);

  const ffmpegCommand = `ffmpeg -ss ${startBefore} -i ${inputPath} -t ${duration} -c copy -y ${outputPath}`;
  await new Promise((resolve, reject) => {
    exec(ffmpegCommand, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const metadata = {
    clip_id: timestamp.toString(),
    match_id: extraMetadata.match_id || 'manual_test',
    created_date: new Date().toISOString(),
    duration: duration,
    player_id: 'manual',
    player_name: extraMetadata.player_name || 'לא ידוע',
    action_type: extraMetadata.action_type || 'unknown_action',
  };

  const customFileName = `${metadata.action_type}_${metadata.player_name}_${metadata.match_id}_${metadata.clip_id}.webm`;

  const uploadedClip = await uploadToDrive({
    filePath: outputPath,
    metadata,
    custom_name: customFileName
  });

  fs.unlinkSync(inputPath);
  fs.unlinkSync(outputPath);

  return uploadedClip;
}

module.exports = { cutClip };
