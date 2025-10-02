import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import compression from "compression";
import helmet from "helmet";
import { config } from "dotenv";
import fs from "fs";
import path from "path";
import { createServer } from "http";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import pinoHttp from 'pino-http';
import { healthCheckHandler, simpleHealthHandler, readinessHandler } from './utils/health-check';
import { jobProcessor, registerBuiltInProcessors } from './utils/job-processor';
import { ErrorRecoveryService } from './utils/error-recovery';
import { redisService } from './services/redis';

// Load environment variables from .env file
config();

// Load NODE_ENV default to development if not set (ensures non-secure cookies locally)
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
// Validate required environment variables early (fail fast)
const requiredEnvVars = ['DATABASE_URL', 'SESSION_SECRET', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error(`Error: missing required environment variables: ${missing.join(', ')}`);
  // Exit with non-zero so deploys fail fast when a secret is missing
  process.exit(1);
}

const app = express();
// If behind a proxy/CDN, trust proxy to get the correct client IP in req.ip
app.set('trust proxy', 1);

// Use response compression for better network performance
// Enable for production and development (Vite handles HMR assets separately)
// Security middleware with development-friendly CSP
app.use(
  helmet({
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'"],
        "script-src-elem": ["'self'"],
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "style-src-elem": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "wss:"],
      },
    } : {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        "script-src-elem": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "style-src-elem": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "ws:", "wss:"],
      },
    },
    crossOriginEmbedderPolicy: process.env.NODE_ENV === 'production',
  })
);

// Response compression
app.use(compression());

// Structured logging for production performance
if (process.env.NODE_ENV === 'production') {
  app.use(pinoHttp({ level: process.env.LOG_LEVEL || 'info' }));
}

// Enhanced health check endpoints
app.get('/health', simpleHealthHandler); // Simple health check for load balancers
app.get('/health/detailed', healthCheckHandler); // Detailed health check with metrics
app.get('/health/ready', readinessHandler); // Readiness check for k8s

// Lightweight Prometheus metrics (optional)
try {
  // @ts-ignore - optional dependency, types may not be installed
  const client: any = await import('prom-client');
  const register = client.register;
  client.collectDefaultMetrics();
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  });
} catch {
  // prom-client not installed; skip metrics
}
// Respect configurable body size limits to avoid accidental large payloads
app.use(express.json({ limit: process.env.MAX_BODY_SIZE || '1mb' }));
app.use(express.urlencoded({ extended: false, limit: process.env.MAX_BODY_SIZE || '1mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Create HTTP server instance first
  const server = createServer(app);
  
  // Setup Vite middleware for proper React development
  try {
    if (app.get("env") === "development") {
      console.log('Setting up Vite middleware...');
      await setupVite(app, server);
      console.log('Vite middleware setup complete');
    } else {
      serveStatic(app);
    }
  } catch (e) {
    console.error('Error setting up Vite middleware:', e);
    
    // Fallback: serve static files and HTML
    const clientPublicPath = path.resolve(__dirname, '..', 'client', 'public');
    const clientHtmlPath = path.resolve(__dirname, '..', 'client', 'index.html');
    
    app.use(express.static(clientPublicPath));
    app.get('*', (req, res) => {
      res.sendFile(clientHtmlPath);
    });
  }

  // Set up API routes after Vite middleware
  await registerRoutes(app);

  // Handle WebSocket upgrade requests
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
    
    // Allow Vite HMR WebSocket upgrades
    if (pathname.includes('?token=')) {
      return; // Let Vite handle its own upgrade
    }
  });

  // Enhanced error handler with categorization
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const errorRecovery = ErrorRecoveryService.getInstance();
    const errorInfo = errorRecovery.categorizeAndHandle(err, {
      operation: 'express_handler',
      metadata: {
        method: req.method,
        path: req.path,
        userAgent: req.get('User-Agent')
      }
    });

    // Enhanced logging with error categorization
    console.error('Unhandled error in request handler:', {
      error: err instanceof Error ? err.stack || err.message : err,
      category: errorInfo.category,
      severity: errorInfo.severity,
      recoverable: errorInfo.recoverable,
      suggestedAction: errorInfo.suggestedAction,
      path: req.path,
      method: req.method
    });

    if (!res.headersSent) {
      // Send appropriate response based on error category
      let statusCode = 500;
      let message = "Internal Server Error";

      switch (errorInfo.category) {
        case 'auth':
          statusCode = 401;
          message = 'Authentication required';
          break;
        case 'rate_limit':
          statusCode = 429;
          message = 'Rate limit exceeded';
          break;
        case 'network':
          statusCode = 503;
          message = 'Service temporarily unavailable';
          break;
        case 'file_processing':
          statusCode = 422;
          message = 'File processing failed';
          break;
        default:
          statusCode = err.status || err.statusCode || 500;
          message = err.message || "Internal Server Error";
      }

      res.status(statusCode).json({
        message,
        category: errorInfo.category,
        recoverable: errorInfo.recoverable,
        ...(process.env.NODE_ENV === 'development' && { details: err.message })
      });
    }
  });

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  const port = parseInt(process.env.PORT || '5000', 10);

  // Configure server timeouts to prevent hanging uploads
  server.timeout = 120000; // 2 minutes for file uploads
  server.keepAliveTimeout = 61000;
  server.headersTimeout = 65000;
  
  // Start listening first so any dev tooling (like Vite's HMR) can inspect
  // the actual bound server and obtain the correct port. After the server
  // is listening, set up either Vite (development) or the static file server.
  server.listen({
    port,
    host: process.env.NODE_ENV === 'production' ? "0.0.0.0" : "localhost",
  }, async () => {
    log(`serving on port ${port} (env=${process.env.NODE_ENV})`);

    // Initialize enhanced services
    try {
      // Initialize Redis health (client connects lazily under the hood)
      log('Checking Redis health...');
      const redisHealthy = await redisService.isHealthy();
      if (redisHealthy) {
        log('Redis is healthy');
      } else {
        console.warn('Redis is not healthy, continuing in degraded mode');
      }

      // Initialize and start job processor
      log('Starting job processor...');
      registerBuiltInProcessors();
      await jobProcessor.startProcessing();
      log('Job processor started');
    } catch (error) {
      console.error('Error initializing enhanced services:', error);
    }

    // Static/vite middleware already set up earlier
  });

  // Ensure logs directory exists (PM2 expects configured log paths)
  try {
    const logsDir = path.resolve(process.cwd(), 'logs', 'pm2');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      log(`Created logs directory at ${logsDir}`);
    }
  } catch (e) {
    console.warn('Could not create logs directory:', e);
  }

  // Enhanced graceful shutdown with cleanup
  const shutdown = async (signal: string) => {
    try {
      log(`Received ${signal}, shutting down gracefully...`);
      
      server.close(async () => {
        log('HTTP server closed');
        
        try {
          // Stop job processing
          if (jobProcessor) {
            await jobProcessor.stopProcessing();
            log('Job processor stopped');
          }
          
          // Stop email sync service
          try {
            const { EmailSyncService } = await import('./services/emailSyncService');
            await EmailSyncService.stopBackgroundSync();
            log('Email sync service stopped');
          } catch (e) {
            console.warn('Error stopping email sync service:', e);
          }
          
          // Close Redis connections (pool)
          if (redisService) {
            await redisService.cleanup();
            log('Redis connections closed');
          }
          
          log('Graceful shutdown completed');
          process.exit(0);
        } catch (error) {
          console.error('Error during graceful shutdown:', error);
          process.exit(1);
        }
      });
      
      // Force shutdown after 30s (increased from 10s for job cleanup)
      setTimeout(() => {
        console.error('Forcing shutdown after 30s');
        process.exit(1);
      }, 30_000).unref();
    } catch (e) {
      console.error('Error during shutdown', e);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err instanceof Error ? err.stack || err.message : err);
    // exit after logging
    process.exit(1);
  });

  // Initialize OAuth services
  try {
    const { GmailOAuthService } = await import('./services/gmailOAuthService');
    const { OutlookOAuthService } = await import('./services/outlookOAuthService');
    
    // Initialize Gmail OAuth (use existing Google credentials)
    GmailOAuthService.initialize({
      clientId: process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: process.env.GMAIL_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:5000'}/api/marketing/oauth/gmail/callback`,
    });
    
    // Initialize Outlook OAuth
    OutlookOAuthService.initialize({
      clientId: process.env.OUTLOOK_CLIENT_ID || '',
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET || '',
      redirectUri: process.env.OUTLOOK_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:5000'}/api/marketing/oauth/outlook/callback`,
      tenantId: process.env.OUTLOOK_TENANT_ID || 'common',
    });
    
    log('OAuth services initialized');
  } catch (e) {
    console.warn('Could not initialize OAuth services:', e);
  }

  // Start email background sync service
  try {
    const { EmailSyncService } = await import('./services/emailSyncService');
    await EmailSyncService.startBackgroundSync();
    log('Email sync service started');
  } catch (e) {
    console.warn('Could not start email sync service:', e);
  }

  // Schedule periodic cleanup of expired refresh tokens (every hour)
  try {
    const { AuthService } = await import('./services/authService');
    // Run once at startup
    AuthService.cleanupExpiredRefreshTokens();
    // Schedule hourly
    setInterval(() => AuthService.cleanupExpiredRefreshTokens(), 60 * 60 * 1000).unref();
  } catch (e) {
    console.warn('Could not schedule refresh token cleanup:', e);
  }

})();
