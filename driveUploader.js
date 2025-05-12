const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

const FULL_CLIPS_FOLDER = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

async function uploadToDrive(localPath, name, match_id, start_time, end_time) {
  const fileMetadata = {
    name,
    parents: [FULL_CLIPS_FOLDER],
  };
  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(localPath),
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  fs.unlink(localPath, () => {}); // מחיקת קובץ זמני

  return {
    google_file_id: file.data.id,
    name,
    start_time,
    end_time,
  };
}

module.exports = { uploadToDrive };
