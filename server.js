require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // Also load .env if it exists
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const xss = require('xss');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'requests.json');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucket = process.env.SUPABASE_STORAGE_BUCKET_NAME || 'design-requests';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || null; // Optional API key for admin endpoints

let supabase = null;
if (supabaseUrl && supabaseServiceKey) {
    supabase = createClient(supabaseUrl, supabaseServiceKey);
    console.log('✅ Supabase client initialized');
} else {
    console.warn('⚠️  Supabase credentials not found. PDF upload will be skipped.');
}

// ==================== SECURITY MIDDLEWARE ====================

// Security headers with Helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // 'unsafe-eval' needed for Vercel Analytics
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://*.supabase.co", "https://*.vercel.app"],
        },
    },
    crossOriginEmbedderPolicy: false, // Disable for compatibility
}));

// CORS configuration - restrict to your domain in production
const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'https://cerneydesigns.com', 'https://*.vercel.app'];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // Check if origin is allowed
        const isAllowed = allowedOrigins.some(allowed => {
            if (allowed.includes('*')) {
                const pattern = allowed.replace('*', '.*');
                return new RegExp(pattern).test(origin);
            }
            return allowed === origin;
        });
        
        if (isAllowed) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Request size limit (prevent DoS attacks)
app.use(express.json({ limit: '1mb' })); // Limit JSON payload to 1MB
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting - general API rate limiter
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Stricter rate limiter for form submissions
const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit form submissions to 5 per 15 minutes per IP
    message: 'Too many form submissions from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', generalLimiter);
app.use('/api/submit-request', submitLimiter);

// ==================== INPUT SANITIZATION HELPERS ====================

function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    // Remove null bytes and sanitize XSS
    return xss(input.replace(/\0/g, ''));
}

function sanitizeForPDF(input) {
    if (typeof input !== 'string') return '';
    // Remove potentially dangerous characters for PDF generation
    return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').substring(0, 10000); // Limit length
}

function sanitizeFilename(filename) {
    // Remove path traversal and dangerous characters
    return filename.replace(/[^a-zA-Z0-9._-]/g, '').substring(0, 255);
}

// ==================== VALIDATION MIDDLEWARE ====================

const validateSubmitRequest = [
    body('clientName')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('Name must be between 1 and 100 characters')
        .escape(),
    body('email')
        .trim()
        .isEmail()
        .normalizeEmail()
        .withMessage('Invalid email address')
        .isLength({ max: 255 })
        .withMessage('Email too long'),
    body('phoneNumber')
        .optional()
        .trim()
        .isLength({ max: 20 })
        .withMessage('Phone number too long')
        .custom((value) => {
            if (!value) return true;
            // Allow common phone number formats: digits, spaces, dashes, parentheses, plus sign
            const phoneRegex = /^[\d\s\-\(\)\+\.]+$/;
            return phoneRegex.test(value);
        })
        .withMessage('Invalid phone number format')
        .escape(),
    body('projectType')
        .trim()
        .isIn(['website', 'redesign', 'landing', 'ecommerce', 'other'])
        .withMessage('Invalid project type'),
    body('timeline')
        .trim()
        .isIn(['asap', '1month', '2-3months', 'flexible'])
        .withMessage('Invalid timeline selection'),
    body('budget')
        .trim()
        .isIn(['200-500', '500-1000', '1000-2500', '2500-5000', '5000+'])
        .withMessage('Invalid budget selection'),
    body('designDescription')
        .trim()
        .isLength({ min: 10, max: 5000 })
        .withMessage('Description must be between 10 and 5000 characters')
        .escape(),
    body('referenceWebsites')
        .optional()
        .trim()
        .isLength({ max: 2000 })
        .withMessage('Reference websites too long')
        .custom((value) => {
            if (!value) return true;
            // Basic URL validation
            const urls = value.split(/[\n,]/).map(url => url.trim()).filter(url => url);
            return urls.every(url => validator.isURL(url, { require_protocol: false }) || url.length < 100);
        })
        .withMessage('Invalid URL in reference websites'),
    body('colorPreferences')
        .optional()
        .trim()
        .isLength({ max: 200 })
        .withMessage('Color preferences too long')
        .escape(),
    body('stylePreferences')
        .optional()
        .trim()
        .isIn(['modern', 'minimalist', 'bold', 'professional', 'creative', 'elegant', 'playful', 'rustic', 'industrial', 'vintage', 'luxury', 'tech', 'corporate', 'artistic', 'clean', ''])
        .withMessage('Invalid style preference selection')
        .escape(),
    body('keyFeatures')
        .optional()
        .trim()
        .isLength({ max: 2000 })
        .withMessage('Key features too long')
        .escape(),
];

// ==================== AUTHENTICATION MIDDLEWARE ====================

function authenticateAdmin(req, res, next) {
    // Check for API key in header or query parameter
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    
    if (!ADMIN_API_KEY) {
        return res.status(503).json({ error: 'Admin API not configured' });
    }
    
    if (apiKey !== ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
}

// API routes are defined below, before static file serving

// Ensure data directory exists
async function ensureDataDir() {
    const dataDir = path.join(__dirname, 'data');
    try {
        await fs.access(dataDir);
    } catch {
        await fs.mkdir(dataDir, { recursive: true });
    }
    
    // Initialize requests file if it doesn't exist
    try {
        await fs.access(DATA_FILE);
    } catch {
        await fs.writeFile(DATA_FILE, JSON.stringify([], null, 2));
    }
}

// Read requests from file
async function readRequests() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

// Write requests to file
async function writeRequests(requests) {
    await fs.writeFile(DATA_FILE, JSON.stringify(requests, null, 2));
}

// Generate PDF from request data (with sanitized inputs)
function generatePDF(request) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            margin: 50,
            size: 'LETTER',
        });

        const chunks = [];
        
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Sanitize all inputs for PDF generation
        const safeClientName = sanitizeForPDF(request.clientName || '');
        const safeEmail = sanitizeForPDF(request.email || '');
        const safePhoneNumber = sanitizeForPDF(request.phoneNumber || '');
        const safeProjectType = sanitizeForPDF(request.projectType || '');
        const safeTimeline = sanitizeForPDF(request.timeline || '');
        const safeBudget = sanitizeForPDF(request.budget || '');
        const safeDescription = sanitizeForPDF(request.designDescription || '');
        const safeColorPrefs = sanitizeForPDF(request.colorPreferences || '');
        const safeStylePrefs = sanitizeForPDF(request.stylePreferences || '');
        const safeKeyFeatures = sanitizeForPDF(request.keyFeatures || '');
        const safeRefWebsites = sanitizeForPDF(request.referenceWebsites || '');
        const safeId = sanitizeForPDF(request.id || '');

        // Header
        doc.fontSize(24)
           .font('Helvetica-Bold')
           .text('Design Request Submission', { align: 'center' });
        
        doc.moveDown(0.5);
        doc.fontSize(10)
           .font('Helvetica')
           .text(`Submitted: ${new Date(request.createdAt).toLocaleString()}`, { align: 'center' });
        
        doc.moveDown(1);

        // Client Information Section
        doc.fontSize(16)
           .font('Helvetica-Bold')
           .text('Client Information');
        
        doc.moveDown(0.3);
        doc.fontSize(12)
           .font('Helvetica')
           .text(`Name: ${safeClientName}`, { indent: 20 });
        doc.text(`Email: ${safeEmail}`, { indent: 20 });
        if (safePhoneNumber) {
            doc.text(`Phone: ${safePhoneNumber}`, { indent: 20 });
        }
        
        doc.moveDown(0.5);

        // Project Details Section
        doc.fontSize(16)
           .font('Helvetica-Bold')
           .text('Project Details');
        
        doc.moveDown(0.3);
        doc.fontSize(12)
           .font('Helvetica')
           .text(`Project Type: ${safeProjectType}`, { indent: 20 });
        doc.text(`Timeline: ${safeTimeline}`, { indent: 20 });
        doc.text(`Budget Range: $${safeBudget}`, { indent: 20 });
        
        doc.moveDown(0.5);

        // Design Description
        doc.fontSize(16)
           .font('Helvetica-Bold')
           .text('Project Description');
        
        doc.moveDown(0.3);
        doc.fontSize(11)
           .font('Helvetica')
           .text(safeDescription, {
               indent: 20,
               align: 'left',
               width: 500,
           });
        
        doc.moveDown(0.5);

        // Design Preferences
        if (safeColorPrefs || safeStylePrefs) {
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Design Preferences');
            
            doc.moveDown(0.3);
            doc.fontSize(12)
               .font('Helvetica');
            
            if (safeColorPrefs) {
                doc.text(`Color Preferences: ${safeColorPrefs}`, { indent: 20 });
            }
            if (safeStylePrefs) {
                doc.text(`Style Preferences: ${safeStylePrefs}`, { indent: 20 });
            }
            
            doc.moveDown(0.5);
        }

        // Key Features
        if (safeKeyFeatures) {
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Key Features Required');
            
            doc.moveDown(0.3);
            doc.fontSize(11)
               .font('Helvetica')
               .text(safeKeyFeatures, {
                   indent: 20,
                   align: 'left',
                   width: 500,
               });
            
            doc.moveDown(0.5);
        }

        // Reference Websites
        if (safeRefWebsites) {
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Reference Websites');
            
            doc.moveDown(0.3);
            doc.fontSize(11)
               .font('Helvetica')
               .text(safeRefWebsites, {
                   indent: 20,
                   align: 'left',
                   width: 500,
               });
        }

        // Footer
        doc.moveDown(2);
        doc.fontSize(8)
           .font('Helvetica')
           .text(`Request ID: ${safeId}`, { align: 'center' });

        doc.end();
    });
}

// Upload PDF to Supabase Storage (with filename sanitization)
async function uploadPDFToSupabase(pdfBuffer, fileName) {
    if (!supabase) {
        throw new Error('Supabase client not initialized');
    }

    // Sanitize filename to prevent path traversal attacks
    const safeFileName = sanitizeFilename(fileName);
    
    // Validate PDF buffer
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new Error('Invalid PDF buffer');
    }
    
    // Check PDF size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (pdfBuffer.length > maxSize) {
        throw new Error('PDF file too large');
    }

    const { data, error } = await supabase.storage
        .from(supabaseBucket)
        .upload(safeFileName, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: false,
        });

    if (error) {
        throw error;
    }

    return data;
}

// Save request to Supabase database
async function saveRequestToDatabase(request) {
    if (!supabase) {
        throw new Error('Supabase client not initialized');
    }

    const { data, error } = await supabase
        .from('design_requests')
        .insert({
            id: request.id,
            client_name: request.clientName,
            email: request.email,
            phone_number: request.phoneNumber || null,
            project_type: request.projectType,
            timeline: request.timeline,
            budget: request.budget,
            design_description: request.designDescription,
            reference_websites: request.referenceWebsites || null,
            color_preferences: request.colorPreferences || null,
            style_preferences: request.stylePreferences || null,
            key_features: request.keyFeatures || null,
            status: request.status,
            pdf_url: request.pdfUrl || null,
            created_at: request.createdAt,
        })
        .select();

    if (error) {
        throw error;
    }

    return data;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Submit design request (with validation and sanitization)
app.post('/api/submit-request', validateSubmitRequest, async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ 
                error: 'Validation failed',
                details: errors.array().map(err => err.msg)
            });
        }

        // Get sanitized and validated data from express-validator
        const {
            clientName,
            email,
            phoneNumber,
            projectType,
            timeline,
            budget,
            designDescription,
            referenceWebsites,
            colorPreferences,
            stylePreferences,
            keyFeatures,
        } = req.body;

        // Additional sanitization
        const request = {
            id: Date.now().toString(),
            clientName: sanitizeInput(clientName?.trim() || ''),
            email: sanitizeInput(email?.trim() || ''),
            phoneNumber: sanitizeInput(phoneNumber?.trim() || ''),
            projectType: sanitizeInput(projectType?.trim() || ''),
            timeline: sanitizeInput(timeline?.trim() || ''),
            budget: sanitizeInput(budget?.trim() || ''),
            designDescription: sanitizeInput(designDescription?.trim() || ''),
            referenceWebsites: sanitizeInput(referenceWebsites?.trim() || ''),
            colorPreferences: sanitizeInput(colorPreferences?.trim() || ''),
            stylePreferences: sanitizeInput(stylePreferences?.trim() || ''),
            keyFeatures: sanitizeInput(keyFeatures?.trim() || ''),
            status: 'pending_review',
            createdAt: new Date().toISOString(),
        };

        // Save request
        const requests = await readRequests();
        requests.push(request);
        await writeRequests(requests);

        // Log request (without sensitive data in production)
        console.log('New design request submitted:', {
            id: request.id,
            clientName: request.clientName.substring(0, 20) + '...', // Truncate for logging
            email: request.email.substring(0, 20) + '...', // Truncate for logging
            projectType: request.projectType,
        });

        // Generate PDF and upload to Supabase
        let pdfUrl = null;
        try {
            const pdfBuffer = await generatePDF(request);
            const fileName = `design-request-${request.id}-${Date.now()}.pdf`;
            
            // Upload to Supabase Storage
            if (supabase) {
                try {
                    const uploadResult = await uploadPDFToSupabase(pdfBuffer, fileName);
                    console.log('✅ PDF uploaded to Supabase:', uploadResult.path);
                    pdfUrl = `${supabaseUrl}/storage/v1/object/public/${supabaseBucket}/${fileName}`;
                    request.pdfUrl = pdfUrl;
                } catch (uploadError) {
                    console.error('❌ Error uploading PDF to Supabase:', uploadError);
                    // Continue even if upload fails - request is still saved locally
                }
            } else {
                console.warn('⚠️  Supabase not configured, skipping PDF upload');
            }
        } catch (pdfError) {
            console.error('❌ Error generating PDF:', pdfError);
            // Continue even if PDF generation fails - request is still saved
        }

        // Save request to Supabase database
        if (supabase) {
            try {
                await saveRequestToDatabase(request);
                console.log('✅ Request saved to Supabase database');
            } catch (dbError) {
                console.error('❌ Error saving request to database:', dbError);
                // Continue even if database save fails - request is still saved locally
            }
        }

        // Return success (don't expose internal IDs in production)
        res.json({
            success: true,
            message: 'Request submitted successfully',
        });
    } catch (error) {
        // Log full error for debugging but don't expose to client
        console.error('Error submitting request:', error);
        
        // Return generic error message to prevent information leakage
        res.status(500).json({ 
            error: 'An error occurred while processing your request. Please try again later.' 
        });
    }
});



// Get all requests (for admin purposes - PROTECTED)
app.get('/api/requests', authenticateAdmin, async (req, res) => {
    try {
        const requests = await readRequests();
        // Sanitize sensitive data before sending
        const sanitizedRequests = requests.map(req => ({
            ...req,
            email: req.email ? req.email.substring(0, 3) + '***' : '', // Partially mask email
        }));
        res.json(sanitizedRequests);
    } catch (error) {
        console.error('Error fetching requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// Error handling middleware (must be after routes)
app.use((err, req, res, next) => {
    console.error('Error:', err);
    
    // Don't leak error details to client
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid request format' });
    }
    
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS policy violation' });
    }
    
    res.status(err.status || 500).json({ 
        error: 'An error occurred. Please try again later.' 
    });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// Static file serving - must come AFTER API routes
app.use(express.static(__dirname));

// Export app for Vercel serverless functions
module.exports = app;

// Start server (only if running locally, not in Vercel)
if (require.main === module) {
    async function startServer() {
        await ensureDataDir();
        
        app.listen(PORT, () => {
            console.log(`\n🚀 CerneyDesigns server is running!`);
            console.log(`📍 Local: http://localhost:${PORT}`);
            console.log(`\n📝 Design requests are saved to: ${DATA_FILE}\n`);
        });
    }

    startServer().catch(console.error);
}

