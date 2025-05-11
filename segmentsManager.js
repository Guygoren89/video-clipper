const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// updated folderId - 11/05

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function cutClip(fileId, startTimeInSec, durationInSec, matchId, actionType) {
  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  const tempInput = path.join('/tmp', `${uuidv4()}.webm`);
  const tempOutput = path.join('/tmp', `${uuidv4()}.webm`);

  const dest = fs.createWriteStream(tempInput);

  const res = await drive.files.get(
    {
      fileId,
      alt: 'media',
      auth: authClient
    },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    res.data
      .on('end', resolve)
      .on('error', reject)
      .pipe(dest);
  });

  const ffmpegCmd = `ffmpeg -ss ${startTimeInSec} -i ${tempInput} -t ${durationInSec} -c copy ${tempOutput}`;
  console.log('[FFmpeg]', ffmpegCmd);

  await new Promise((resolve, reject) => {
    exec(ffmpegCmd, (err, stdout, stderr) => {
      if (err) {
        console.error('FFmpeg error:', stderr);
        return reject(err);
      }
      resolve();
    });
  });

  const uploadRes = await drive.files.create({
    resource: {
      name: `clip_${Date.now()}.webm`,
      parents: ['1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU'], // תיקיית Short_clips_2025
    },
    media: {
      mimeType: 'video/webm',
      body: fs.createReadStream(tempOutput),
    },
    fields: 'id',
  });

  const newClipId = uploadRes.data.id;

  await drive.files.update({
    fileId: newClipId,
    resource: {
      description: JSON.stringify({
        match_id: matchId,
        action_type: actionType,
        source_file_id: fileId,
        start_time_in_segment: startTimeInSec,
        duration: durationInSec,
      }),
    },
  });

  fs.unlinkSync(tempInput);
  fs.unlinkSync(tempOutput);

  return {
    success: true,
    file_id: newClipId,
    source_file_id: fileId,
    start_time: startTimeInSec,
    duration: durationInSec,
  };
}

module.exports = { cutClip };
