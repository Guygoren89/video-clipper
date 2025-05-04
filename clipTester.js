// cutClip.js

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

async function cutClip(fileId, startTime, duration = '00:00:08', extraMetadata = {}) {
  const timestamp = Date.now();
  const inputPath = path.join(TEMP_FOLDER, `input_${timestamp}.webm`);
  const outputPath = path.join(TEMP_FOLDER, `clip_${timestamp}.webm`);

  await downloadFile(fileId, inputPath);

  const ffmpegCommand = `ffmpeg -ss ${startTime} -i ${inputPath} -t ${duration} -c copy -y ${outputPath}`;
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
    // ↓ לא כולל שחקן או פעולה – יתווסף בדיעבד
  };

  const customFileName = `clip_${metadata.match_id}_${metadata.clip_id}.webm`;

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
