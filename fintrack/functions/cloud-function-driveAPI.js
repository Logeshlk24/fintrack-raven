// ══════════════════════════════════════════════════════════════════════════════
// CLOUD FUNCTION: Google Drive API Integration
// ══════════════════════════════════════════════════════════════════════════════
// Deploy this to Firebase Cloud Functions
// Command: firebase deploy --only functions:driveAPI
//
// This function handles all Google Drive operations server-side
// Uses Firebase Admin SDK to verify ID tokens (secure & automatic refresh)
// ══════════════════════════════════════════════════════════════════════════════

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

admin.initializeApp();

// ── Main API Handler ──────────────────────────────────────────────────────────
exports.driveAPI = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  
  try {
    // ── Step 1: Verify Firebase ID Token ────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).send('Unauthorized: No token provided');
      return;
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    
    console.log('✅ Authenticated user:', uid);
    
    // ── Step 2: Get User's Drive Credentials from Firestore ────────────────
    const userDoc = await admin.firestore()
      .collection('users')
      .doc(uid)
      .collection('tokens')
      .doc('drive')
      .get();
    
    if (!userDoc.exists) {
      res.status(403).send('Drive not authorized. Please sign in again.');
      return;
    }
    
    const { refreshToken } = userDoc.data();
    
    if (!refreshToken) {
      res.status(403).send('No refresh token found. Please re-authorize Drive.');
      return;
    }
    
    // ── Step 3: Create OAuth2 Client with Refresh Token ────────────────────
    const oauth2Client = new google.auth.OAuth2(
      functions.config().google.client_id,
      functions.config().google.client_secret,
      functions.config().google.redirect_uri
    );
    
    oauth2Client.setCredentials({
      refresh_token: refreshToken,
    });
    
    // OAuth2 client will automatically refresh access token when needed!
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    // ── Step 4: Handle Drive Operations ─────────────────────────────────────
    const { action } = req.body;
    
    switch (action) {
      case 'upload':
        return await handleUpload(req, res, drive);
      
      case 'download':
        return await handleDownload(req, res, drive);
      
      case 'list':
        return await handleList(req, res, drive);
      
      case 'delete':
        return await handleDelete(req, res, drive);
      
      default:
        res.status(400).send('Invalid action');
    }
    
  } catch (error) {
    console.error('Drive API error:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

// ── Upload File to Drive ──────────────────────────────────────────────────────
async function handleUpload(req, res, drive) {
  const { fileName, mimeType, fileData, metadata = {} } = req.body;
  
  if (!fileName || !fileData) {
    res.status(400).send('Missing fileName or fileData');
    return;
  }
  
  try {
    // Convert base64 to buffer
    const buffer = Buffer.from(fileData, 'base64');
    
    // Create file in Drive
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: mimeType || 'application/octet-stream',
        ...metadata,
      },
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body: require('stream').Readable.from(buffer),
      },
      fields: 'id, name, mimeType, size, createdTime, webViewLink',
    });
    
    console.log('✅ File uploaded:', response.data.id);
    res.status(200).json({
      success: true,
      fileId: response.data.id,
      file: response.data,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).send(`Upload failed: ${error.message}`);
  }
}

// ── Download File from Drive ──────────────────────────────────────────────────
async function handleDownload(req, res, drive) {
  const { fileId } = req.body;
  
  if (!fileId) {
    res.status(400).send('Missing fileId');
    return;
  }
  
  try {
    // Get file metadata
    const metadata = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size',
    });
    
    // Get file content
    const response = await drive.files.get({
      fileId,
      alt: 'media',
    }, { responseType: 'arraybuffer' });
    
    // Convert to base64
    const base64 = Buffer.from(response.data).toString('base64');
    
    console.log('✅ File downloaded:', fileId);
    res.status(200).json({
      success: true,
      metadata: metadata.data,
      fileData: base64,
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send(`Download failed: ${error.message}`);
  }
}

// ── List Files in Drive ───────────────────────────────────────────────────────
async function handleList(req, res, drive) {
  const { query = {} } = req.body;
  
  try {
    const response = await drive.files.list({
      pageSize: query.pageSize || 100,
      fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
      q: query.q || null,
      orderBy: query.orderBy || 'modifiedTime desc',
    });
    
    console.log(`✅ Listed ${response.data.files.length} files`);
    res.status(200).json({
      success: true,
      files: response.data.files,
    });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).send(`List failed: ${error.message}`);
  }
}

// ── Delete File from Drive ────────────────────────────────────────────────────
async function handleDelete(req, res, drive) {
  const { fileId } = req.body;
  
  if (!fileId) {
    res.status(400).send('Missing fileId');
    return;
  }
  
  try {
    await drive.files.delete({ fileId });
    
    console.log('✅ File deleted:', fileId);
    res.status(200).json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).send(`Delete failed: ${error.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTION: Store Refresh Token (called after OAuth consent)
// ══════════════════════════════════════════════════════════════════════════════
exports.storeRefreshToken = functions.https.onRequest(async (req, res) => {
  // This function is called by your OAuth redirect handler
  // It exchanges the authorization code for tokens and stores the refresh token
  
  res.set('Access-Control-Allow-Origin', '*');
  
  try {
    const { code, uid } = req.body;
    
    if (!code || !uid) {
      res.status(400).send('Missing code or uid');
      return;
    }
    
    // Exchange authorization code for tokens
    const oauth2Client = new google.auth.OAuth2(
      functions.config().google.client_id,
      functions.config().google.client_secret,
      functions.config().google.redirect_uri
    );
    
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store refresh token in Firestore (secure, server-side only)
    await admin.firestore()
      .collection('users')
      .doc(uid)
      .collection('tokens')
      .doc('drive')
      .set({
        refreshToken: tokens.refresh_token,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    
    console.log('✅ Refresh token stored for user:', uid);
    res.status(200).json({ success: true });
    
  } catch (error) {
    console.error('Token storage error:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});
