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

function isFullClip(metadata) {
  return metadata.action_type === 'segment_upload';
}

async function uploadToDrive({ filePath, metadata, custom_name = null }) {
  const folderId = isFullClip(metadata) ? FOLDER_IDS.full : FOLDER_IDS.short;
  const finalName = custom_name || `${metadata.match_id}_${path.basename(filePath)}`;

  const fileMetadata = {
    name: finalName,
    parents: [folderId],
  };

  const media = {
    mimeType: 'video/webm',
    body: fs.createReadStream(filePath),
  };

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id',
  });

  const fileId = file.data.id;

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
    name: finalName,
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
