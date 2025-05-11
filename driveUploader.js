const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function uploadSegmentToDrive(base64Video, filename, match_id, start_time, end_time) {
  const buffer = Buffer.from(base64Video, 'base64');
  const tempPath = path.join('/tmp', `${uuidv4()}_${filename}.webm`);
  fs.writeFileSync(tempPath, buffer);

  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  const fileMetadata = {
    name: filename,
    parents: ['1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'], // תיקיית Full_clips
  };

  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(tempPath),
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

  fs.unlinkSync(tempPath);

  return {
    success: true,
    file_id: fileId,
    name: filename,
    start_time,
    end_time,
  };
}

module.exports = { uploadSegmentToDrive };
