// clipTester.js
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadToDrive } = require('./driveUploader');

const TEMP_FOLDER = '/tmp';
const CLIPS_FOLDER_ID = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // Short_clips

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

async function downloadFile(fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    res.data
      .on('end', resolve)
      .on('error', reject)
      .pipe(dest);
  });
}

async function cutClip(fileId, startTime, duration) {
  const inputPath = path.join(TEMP_FOLDER, `input_${Date.now()}.mp4`);
  const outputPath = path.join(TEMP_FOLDER, `clip_${Date.now()}.mp4`);

  await downloadFile(fileId, inputPath);

  const ffmpegCommand = `ffmpeg -ss ${startTime} -i ${inputPath} -t ${duration} -c copy ${outputPath}`;
  await new Promise((resolve, reject) => {
    exec(ffmpegCommand, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const metadata = {
    clip_id: Date.now().toString(),
    match_id: 'manual_test',
    created_date: new Date().toISOString(),
    duration: duration,
    player_id: 'manual',
    player_name: 'בדיקת חיתוך',
    action_type: 'manual_cut',
  };

  const uploadedClip = await uploadToDrive({ filePath: outputPath, metadata });

  fs.unlinkSync(inputPath);
  fs.unlinkSync(outputPath);

  return uploadedClip;
}

module.exports = { cutClip };
