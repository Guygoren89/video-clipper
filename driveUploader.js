const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({
  scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

const CLIPS_FOLDER_ID = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C';

async function uploadToDrive({ filePath, thumbnailPath, metadata }) {
  const fileMetadata = {
    name: path.basename(filePath),
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

  // Share publicly
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
    thumbnail_url: '', // not implemented yet
    duration: metadata.duration,
    created_date: metadata.created_date,
    player_id: metadata.player_id,
    player_name: metadata.player_name,
    action_type: metadata.action_type,
    match_id: metadata.match_id,
  };
}

async function generateThumbnail(videoPath) {
  return new Promise((resolve, reject) => {
    const thumbnailPath = `${videoPath.replace('.mp4', '')}_thumb.jpg`;
    const cmd = `ffmpeg -i ${videoPath} -ss 00:00:01.000 -vframes 1 ${thumbnailPath}`;
    exec(cmd, (error) => {
      if (error) {
        return reject(error);
      }
      resolve(thumbnailPath);
    });
  });
}

async function listClipsFromDrive() {
  const response = await drive.files.list({
    q: `'${CLIPS_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name, createdTime, thumbnailLink, webViewLink, webContentLink)',
    orderBy: 'createdTime desc',
  });

  return response.data.files.map(file => ({
    external_id: file.id,
    name: file.name,
    view_url: file.webViewLink,
    download_url: file.webContentLink,
    thumbnail_url: file.thumbnailLink || '',
    created_date: file.createdTime,
  }));
}

module.exports = {
  uploadToDrive,
  generateThumbnail,
  listClipsFromDrive
};
