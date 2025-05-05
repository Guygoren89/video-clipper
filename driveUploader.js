// driveUploader.js

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

const FOLDER_IDS = {
  full: '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC',
  short: '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'
};

async function uploadToDrive({ filePath, metadata, custom_name = null }) {
  const actionType = (metadata.action_type || '').toLowerCase().trim();
  const isFullClip = actionType === 'segment_upload';
  const folderId = isFullClip ? FOLDER_IDS.full : FOLDER_IDS.short;

  console.log(`📂 Uploading to folder: ${isFullClip ? 'Full_clips' : 'Short_clips'}`);
  console.log(`📄 File name: ${custom_name || path.basename(filePath)}`);

  const fileMetadata = {
    name: custom_name || `${metadata.match_id}_${path.basename(filePath)}`,
    parents: [folderId],
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

  const result = {
    external_id: metadata.clip_id,
    name: fileMetadata.name,
    view_url: viewUrl,
    download_url: downloadUrl,
    thumbnail_url: '',
    duration: metadata.duration,
    created_date: metadata.created_date,
    match_id: metadata.match_id,
    google_file_id: fileId,
  };

  if (metadata.player_id) result.player_id = metadata.player_id;
  if (metadata.player_name) result.player_name = metadata.player_name;
  if (metadata.action_type) result.action_type = metadata.action_type;

  return result;
}

module.exports = {
  uploadToDrive,
};
