// driveUploader.js

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function uploadSegmentToDrive(file, filename, match_id, start_time, end_time) {
  if (file.mimetype !== 'video/webm') {
    throw new Error('Invalid file type. Only video/webm is allowed.');
  }

  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  const fileMetadata = {
    name: filename,
    parents: ['1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'], // Full_clips folder
  };

  const media = {
    mimeType: file.mimetype,
    body: fs.createReadStream(file.path),
  };

  const uploadResponse = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  const fileId = uploadResponse.data.id;

  await drive.files.update({
    fileId,
    resource: {
      description: JSON.stringify({
        match_id,
        start_time,
        end_time,
      }),
    },
  });

  fs.unlink(file.path, (err) => {
    if (err) {
      console.error(`Failed to delete temp file: ${file.path}`, err);
    } else {
      console.log(`Temp file deleted: ${file.path}`);
    }
  });

  console.log(`[UPLOAD DONE] file_id: ${fileId}, name: ${filename}`);

  return {
    success: true,
    clip: {
      google_file_id: fileId,
      name: filename,
      start_time,
      end_time,
    },
  };
}

module.exports = { uploadSegmentToDrive };
