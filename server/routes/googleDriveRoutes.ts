import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import GoogleDriveService from '../services/googleDriveService';
import { DocxProcessor } from '../docx-processor';
import { storage } from '../storage';
import { logAccountActivity } from '../utils/activityLogger';
import { encryptToken, decryptToken } from '../utils/tokenEncryption';
import { insertResumeSchema } from '@shared/schema';
import { isAuthenticated } from '../localAuth';

const router = Router();
const googleDriveService = new GoogleDriveService();

// Validation schemas
const authCallbackSchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
  state: z.string().optional()
});

const downloadFileSchema = z.object({
  fileId: z.string().min(1, "File ID is required"),
  fileName: z.string().min(1, "File name is required")
});

const listFilesSchema = z.object({
  pageSize: z.number().min(1).max(100).optional().default(20),
  pageToken: z.string().optional()
});

// We'll persist Google tokens on the user record in the database (see shared.schema)

/**
 * Generate Google Drive authentication URL
 */
router.get('/auth-url', isAuthenticated, async (req: any, res) => {
  try {
    console.log('🔐 Generating Google Drive auth URL for user:', req.user.id);
    // Create a per-request state value to mitigate CSRF
    const state = crypto.randomBytes(16).toString('hex');
    req.session.googleOAuthState = state;

    const authUrl = googleDriveService.generateAuthUrl() + `&state=${encodeURIComponent(state)}`;
    
    res.json({
      authUrl,
      message: 'Redirect user to this URL for Google Drive authorization'
    });
  } catch (error) {
    console.error('💥 Failed to generate auth URL:', error);
    res.status(500).json({
      message: 'Failed to generate authorization URL',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Handle OAuth callback and store tokens
 */
router.post('/auth-callback', isAuthenticated, async (req: any, res) => {
  try {
    const { code } = authCallbackSchema.parse(req.body);
    const state = req.body.state as string | undefined;
    // Validate state
    if (!req.session || !req.session.googleOAuthState || req.session.googleOAuthState !== state) {
      console.warn('Google Drive auth callback state mismatch', { expected: req.session?.googleOAuthState, received: state });
      return res.status(400).json({ message: 'Invalid OAuth state' });
    }
    const userId = req.user.id;
    
    console.log('🔑 Processing Google Drive auth callback for user:', userId);
    
    // Exchange code for tokens
      const tokens = await googleDriveService.getTokens(code);

      // Persist tokens to the user's record (encrypt in production)
      try {
        await storage.upsertUser({
          id: userId,
          googleAccessToken: tokens.accessToken,
          googleRefreshToken: encryptToken(tokens.refreshToken ?? null),
          googleTokenExpiresAt: tokens.expiryDate ? new Date(tokens.expiryDate) : null,
          googleDriveConnected: true,
          googleDriveEmail: (tokens as any).email ?? null,
        } as any);
      } catch (e) {
        console.warn('Failed to persist Google tokens to user record:', e);
      }
    
    console.log('✅ Google Drive authentication successful for user:', userId);
    // Audit log
    try {
      await logAccountActivity(userId, 'google_drive_connect', 'success', { googleDriveEmail: (tokens as any).email ?? null });
    } catch (e) {}
    
    res.json({
      success: true,
      message: 'Google Drive authentication successful',
      expiresAt: tokens.expiryDate
    });
  } catch (error) {
    console.error('💥 Google Drive auth callback failed:', error);
    res.status(400).json({
      message: 'Authentication failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Check authentication status
 */
router.get('/auth-status', isAuthenticated, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const user = await storage.getUser(userId);
    if (!user || !user.googleDriveConnected) {
      return res.json({ authenticated: false, message: 'Not authenticated with Google Drive' });
    }

    const expiresAt = user.googleTokenExpiresAt ? new Date(user.googleTokenExpiresAt).getTime() : undefined;
    const isExpired = expiresAt ? Date.now() >= expiresAt : false;

    res.json({
      authenticated: !!user.googleDriveConnected && !isExpired,
      expiresAt,
      needsRefresh: isExpired,
      googleDriveEmail: user.googleDriveEmail ?? null,
    });
  } catch (error) {
    console.error('💥 Failed to check auth status:', error);
    res.status(500).json({
      message: 'Failed to check authentication status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * List DOCX files from Google Drive
 */
router.get('/files', isAuthenticated, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { pageSize, pageToken } = listFilesSchema.parse(req.query);
    
    // Get user tokens from DB
    const user = await storage.getUser(userId);
    if (!user || !user.googleDriveConnected) {
      return res.status(401).json({ message: 'Not authenticated with Google Drive', needsAuth: true });
    }

    let tokens = {
      accessToken: user.googleAccessToken,
      refreshToken: decryptToken(user.googleRefreshToken as any),
      expiryDate: user.googleTokenExpiresAt ? new Date(user.googleTokenExpiresAt).getTime() : undefined,
    } as any;

    // If token expired, attempt to refresh and persist new access token
    if (tokens.expiryDate && Date.now() >= tokens.expiryDate) {
      try {
        googleDriveService.setCredentials(tokens);
        await googleDriveService.refreshAccessToken();
        // pull refreshed creds from service
        const creds: any = (googleDriveService as any).oauth2Client?.credentials || {};
        tokens = {
          accessToken: creds.access_token,
          refreshToken: creds.refresh_token || tokens.refreshToken,
          expiryDate: creds.expiry_date,
        };
        // Persist refreshed access token and expiry
        await storage.upsertUser({
          id: userId,
          googleAccessToken: tokens.accessToken,
          googleTokenExpiresAt: tokens.expiryDate ? new Date(tokens.expiryDate) : null,
          googleDriveConnected: true,
        } as any);
      } catch (err) {
        console.warn('Failed to refresh Google access token for user', userId, err);
        return res.status(401).json({ message: 'Authentication expired. Please reconnect to Google Drive.', needsAuth: true });
      }
    } else {
      // Set credentials normally
      googleDriveService.setCredentials(tokens);
    }
    
    console.log(`📁 Listing Google Drive files for user: ${userId}`);
    
    // List DOCX files
    const result = await googleDriveService.listDocxFiles(pageSize, pageToken);
    
    console.log(`📄 Found ${result.files.length} DOCX files in Google Drive`);
    
    res.json({
      files: result.files,
      nextPageToken: result.nextPageToken,
      totalFound: result.files.length
    });
  } catch (error) {
    console.error('💥 Failed to list Google Drive files:', error);
    res.status(500).json({
      message: 'Failed to fetch files from Google Drive',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Download and process file from Google Drive
 */
router.post('/download-and-process', isAuthenticated, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const { fileId, fileName } = downloadFileSchema.parse(req.body);
    
    console.log(`🚀 Starting Google Drive file processing: ${fileName} (${fileId})`);
    
    // Get user tokens from DB
    const user = await storage.getUser(userId);
    if (!user || !user.googleDriveConnected) {
      return res.status(401).json({ message: 'Not authenticated with Google Drive', needsAuth: true });
    }

    let tokens = {
      accessToken: user.googleAccessToken,
      refreshToken: decryptToken(user.googleRefreshToken as any),
      expiryDate: user.googleTokenExpiresAt ? new Date(user.googleTokenExpiresAt).getTime() : undefined,
    } as any;

    if (tokens.expiryDate && Date.now() >= tokens.expiryDate) {
      try {
        googleDriveService.setCredentials(tokens);
        await googleDriveService.refreshAccessToken();
        const creds: any = (googleDriveService as any).oauth2Client?.credentials || {};
        tokens = {
          accessToken: creds.access_token,
          refreshToken: creds.refresh_token || tokens.refreshToken,
          expiryDate: creds.expiry_date,
        };
        await storage.upsertUser({
          id: userId,
          googleAccessToken: tokens.accessToken,
          googleTokenExpiresAt: tokens.expiryDate ? new Date(tokens.expiryDate) : null,
          googleDriveConnected: true,
        } as any);
      } catch (err) {
        console.warn('Failed to refresh Google access token for user', userId, err);
        return res.status(401).json({ message: 'Authentication expired. Please reconnect to Google Drive.', needsAuth: true });
      }
    } else {
      googleDriveService.setCredentials(tokens);
    }
    
    // Validate file is DOCX
    const isValidDocx = await googleDriveService.validateDocxFile(fileId);
    if (!isValidDocx) {
      return res.status(400).json({
        message: 'File is not a valid DOCX document'
      });
    }
    
    // Get file metadata
    const metadata = await googleDriveService.getFileMetadata(fileId);
    console.log(`📊 File metadata:`, {
      name: metadata.name,
      size: metadata.size,
      mimeType: metadata.mimeType
    });
    
    // Download file content
    const fileBuffer = await googleDriveService.downloadFile(fileId);
    
    // Process DOCX content (same as local upload)
    let extractedContent: string = '';
    let originalContent: string = '';
    
    try {
      // Extract HTML content from DOCX with progress tracking
      const docxResult = await DocxProcessor.parseDocx(fileBuffer, (progress) => {
        console.log(`📊 DOCX processing progress for ${fileName}: ${progress}%`);
      });
      extractedContent = docxResult.html;
      
      console.log(`📄 Extracted ${docxResult.metadata.wordCount} words from Google Drive file: ${fileName}`);
      
      // Store base64 for backup/original file access
      const chunkSize = 1024 * 1024; // 1MB chunks
      const chunks: string[] = [];
      let offset = 0;
      
      while (offset < fileBuffer.length) {
        const chunk = fileBuffer.subarray(offset, Math.min(offset + chunkSize, fileBuffer.length));
        chunks.push(chunk.toString('base64'));
        offset += chunkSize;
      }
      originalContent = chunks.join('');
      
    } catch (error) {
      console.error(`Failed to process DOCX from Google Drive ${fileName}:`, error);
      // Fallback to base64 storage if DOCX processing fails
      originalContent = fileBuffer.toString('base64');
    }
    
    // Create resume record
    const resumeData = insertResumeSchema.parse({
      userId,
      fileName: metadata.name,
      originalContent,
      customizedContent: extractedContent || null,
      fileSize: parseInt(metadata.size || '0'),
      status: extractedContent ? "ready" : "uploaded",
      ephemeral: true,
      sessionId: req.sessionID as string | undefined,
    });

    const resume = await storage.createResume(resumeData);
    
    console.log(`✅ Google Drive file processed successfully: ${fileName}`);
    
    res.json({
      success: true,
      resume,
      message: `Successfully imported ${fileName} from Google Drive`,
      metadata: {
        source: 'google-drive',
        originalFileId: fileId,
        wordCount: extractedContent ? 'processed' : 'pending',
        processingStatus: extractedContent ? 'ready' : 'uploaded'
      }
    });
    
  } catch (error) {
    console.error('💥 Google Drive file processing failed:', error);
    res.status(500).json({
      message: 'Failed to process file from Google Drive',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Revoke Google Drive access
 */
router.post('/revoke-access', isAuthenticated, async (req: any, res) => {
  try {
    const userId = req.user.id;
    
    // Remove stored tokens from user record
    await storage.upsertUser({
      id: userId,
      googleAccessToken: null,
      googleRefreshToken: null,
      googleTokenExpiresAt: null,
      googleDriveConnected: false,
    } as any);
    
    console.log('🔓 Google Drive access revoked for user:', userId);
    try {
      await logAccountActivity(userId, 'google_drive_revoke', 'success', {});
    } catch (e) {}
    
    res.json({
      success: true,
      message: 'Google Drive access revoked successfully'
    });
  } catch (error) {
    console.error('💥 Failed to revoke Google Drive access:', error);
    res.status(500).json({
      message: 'Failed to revoke access',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
