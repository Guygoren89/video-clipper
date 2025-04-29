const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

const CLIPS_FOLDER_ID = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // תיקיית הקליפים

async function uploadToDrive({ filePath, metadata }) {
  const fileMetadata = {
    name: metadata.clip_id + '.mp4',
    parents: [CLIPS_FOLDER_ID],
  };

  const media = {
    mimeType: 'video/mp4',
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

  const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  return {
    external_id: metadata.clip_id,
    name: metadata.player_name,
    view_url: viewUrl,
    download_url: downloadUrl,
    thumbnail_url: '',
    duration: metadata.duration,
    created_date: metadata.created_date,
    player_id: metadata.player_id,
    player_name: metadata.player_name,
    action_type: metadata.action_type,
    match_id: metadata.match_id,
  };
}

async function downloadFileFromDrive(fileId, destinationPath) {
  const dest = fs.createWriteStream(destinationPath);
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    res.data
      .pipe(dest)
      .on('finish', () => {
        console.log(`✅ Downloaded file ${fileId}`);
        resolve();
      })
      .on('error', reject);
  });
}

module.exports = {
  uploadToDrive,
  downloadFileFromDrive,
};
