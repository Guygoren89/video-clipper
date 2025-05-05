const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { uploadToDrive, downloadFileFromDrive } = require('./driveUploader');

const TEMP_DIR = '/tmp';

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

async function cutClip({ fileId, startTimeInSec, durationInSec = 8, matchId = 'test-match', actionType = null }) {
  const clipId = uuidv4();
  const inputPath = path.join(TEMP_DIR, `input_${clipId}.webm`);
  const outputPath = path.join(TEMP_DIR, `clip_${clipId}.webm`);

  // שלב 1 – הורדת הקובץ מגוגל דרייב
  await downloadFileFromDrive(fileId, inputPath);

  // שלב 2 – חיתוך עם ffmpeg
  const ffmpegCmd = `ffmpeg -ss ${formatTime(startTimeInSec)} -i ${inputPath} -t ${durationInSec} -c copy -y ${outputPath}`;
  await new Promise((resolve, reject) => {
    exec(ffmpegCmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // שלב 3 – העלאה לגוגל דרייב
  const metadata = {
    clip_id: clipId,
    match_id: matchId,
    created_date: new Date().toISOString(),
    duration: `${durationInSec}`,
    action_type: actionType,
  };

  const customName = `clip_${matchId}_${clipId}.webm`;
  const result = await uploadToDrive({ filePath: outputPath, metadata, custom_name: customName });

  // ניקוי קבצים זמניים
  if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  return result;
}

module.exports = { cutClip };
