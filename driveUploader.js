const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library'); // 💡 תיקון קריטי כאן

async function uploadToDrive(filePath, fileName, folderId) {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };

  const mimeType = mime.lookup(filePath) || 'application/octet-stream';

  const media = {
    mimeType: mimeType,
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink, webContentLink',
  });

  return response.data;
}

module.exports = uploadToDrive;
