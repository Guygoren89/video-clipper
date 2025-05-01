const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

const FOLDER_IDS = {
  full: '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC', // Full_clips
  short: '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C' // Short_clips
};

async function uploadToDrive({ filePath, metadata, custom_name = null }) {
  const isFullClip = metadata.action_type === 'segment_upload';
  const targetFolder = isFullClip ? FOLDER_IDS.full : FOLDER_IDS.short;

  const fileMetadata = {
    name: custom_name ? custom_name : `${metadata.match_id}_${path.basename(filePath)}`,
    parents: [targetFolder],
  };

  const media = {
    mimeType: 'video/webm',
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
    name: fileMetadata.name,
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
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });
}

async function listClipsFromDrive(folder = 'short') {
  const folderId = FOLDER_IDS[folder];

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, createdTime, webViewLink, webContentLink)',
    orderBy: 'createdTime desc',
  });

  return response.data.files.map(file => ({
    external_id: file.id,
    name: file.name,
    view_url: file.webViewLink,
    download_url: file.webContentLink,
    thumbnail_url: '',
    created_date: file.createdTime,
  }));
}

module.exports = {
  uploadToDrive,
  downloadFileFromDrive,
  listClipsFromDrive
};
