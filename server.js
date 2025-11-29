require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // Also load .env if it exists
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'requests.json');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucket = process.env.SUPABASE_STORAGE_BUCKET_NAME || 'design-requests';

let supabase = null;
if (supabaseUrl && supabaseServiceKey) {
    supabase = createClient(supabaseUrl, supabaseServiceKey);
    console.log('✅ Supabase client initialized');
} else {
    console.warn('⚠️  Supabase credentials not found. PDF upload will be skipped.');
}

// Middleware
app.use(cors());
app.use(express.json());
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

// Generate PDF from request data
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
           .text(`Name: ${request.clientName}`, { indent: 20 });
        doc.text(`Email: ${request.email}`, { indent: 20 });
        
        doc.moveDown(0.5);

        // Project Details Section
        doc.fontSize(16)
           .font('Helvetica-Bold')
           .text('Project Details');
        
        doc.moveDown(0.3);
        doc.fontSize(12)
           .font('Helvetica')
           .text(`Project Type: ${request.projectType}`, { indent: 20 });
        doc.text(`Timeline: ${request.timeline}`, { indent: 20 });
        doc.text(`Budget Range: $${request.budget}`, { indent: 20 });
        
        doc.moveDown(0.5);

        // Design Description
        doc.fontSize(16)
           .font('Helvetica-Bold')
           .text('Project Description');
        
        doc.moveDown(0.3);
        doc.fontSize(11)
           .font('Helvetica')
           .text(request.designDescription, {
               indent: 20,
               align: 'left',
               width: 500,
           });
        
        doc.moveDown(0.5);

        // Design Preferences
        if (request.colorPreferences || request.stylePreferences) {
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Design Preferences');
            
            doc.moveDown(0.3);
            doc.fontSize(12)
               .font('Helvetica');
            
            if (request.colorPreferences) {
                doc.text(`Color Preferences: ${request.colorPreferences}`, { indent: 20 });
            }
            if (request.stylePreferences) {
                doc.text(`Style Preferences: ${request.stylePreferences}`, { indent: 20 });
            }
            
            doc.moveDown(0.5);
        }

        // Key Features
        if (request.keyFeatures) {
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Key Features Required');
            
            doc.moveDown(0.3);
            doc.fontSize(11)
               .font('Helvetica')
               .text(request.keyFeatures, {
                   indent: 20,
                   align: 'left',
                   width: 500,
               });
            
            doc.moveDown(0.5);
        }

        // Reference Websites
        if (request.referenceWebsites) {
            doc.fontSize(16)
               .font('Helvetica-Bold')
               .text('Reference Websites');
            
            doc.moveDown(0.3);
            doc.fontSize(11)
               .font('Helvetica')
               .text(request.referenceWebsites, {
                   indent: 20,
                   align: 'left',
                   width: 500,
               });
        }

        // Footer
        doc.moveDown(2);
        doc.fontSize(8)
           .font('Helvetica')
           .text(`Request ID: ${request.id}`, { align: 'center' });

        doc.end();
    });
}

// Upload PDF to Supabase Storage
async function uploadPDFToSupabase(pdfBuffer, fileName) {
    if (!supabase) {
        throw new Error('Supabase client not initialized');
    }

    const { data, error } = await supabase.storage
        .from(supabaseBucket)
        .upload(fileName, pdfBuffer, {
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

// Submit design request
app.post('/api/submit-request', async (req, res) => {
    try {
        const {
            clientName,
            email,
            projectType,
            timeline,
            budget,
            designDescription,
            referenceWebsites,
            colorPreferences,
            stylePreferences,
            keyFeatures,
        } = req.body;

        // Trim whitespace and validate required fields
        const trimmedClientName = clientName?.trim();
        const trimmedEmail = email?.trim();
        const trimmedProjectType = projectType?.trim();
        const trimmedTimeline = timeline?.trim();
        const trimmedBudget = budget?.trim();
        const trimmedDescription = designDescription?.trim();

        if (!trimmedClientName || !trimmedEmail || !trimmedProjectType || !trimmedTimeline || !trimmedBudget || !trimmedDescription) {
            console.log('Validation failed. Received:', { 
                clientName: trimmedClientName, 
                email: trimmedEmail, 
                projectType: trimmedProjectType, 
                timeline: trimmedTimeline,
                budget: trimmedBudget,
                designDescription: trimmedDescription 
            });
            return res.status(400).json({ error: 'Missing required fields. Please fill in all required fields.' });
        }

        // Create request object with all website-specific information
        const request = {
            id: Date.now().toString(),
            clientName: trimmedClientName,
            email: trimmedEmail,
            projectType: trimmedProjectType,
            timeline: trimmedTimeline,
            budget: trimmedBudget,
            designDescription: trimmedDescription,
            referenceWebsites: referenceWebsites?.trim() || '',
            colorPreferences: colorPreferences?.trim() || '',
            stylePreferences: stylePreferences?.trim() || '',
            keyFeatures: keyFeatures?.trim() || '',
            status: 'pending_review',
            createdAt: new Date().toISOString(),
        };

        // Save request
        const requests = await readRequests();
        requests.push(request);
        await writeRequests(requests);

        console.log('New design request submitted:', {
            id: request.id,
            clientName: request.clientName,
            email: request.email,
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

        // Return success
        res.json({
            success: true,
            requestId: request.id,
            message: 'Request submitted successfully',
        });
    } catch (error) {
        console.error('Error submitting request:', error);
        res.status(500).json({ error: 'Failed to submit request' });
    }
});



// Get all requests (for admin purposes)
app.get('/api/requests', async (req, res) => {
    try {
        const requests = await readRequests();
        res.json(requests);
    } catch (error) {
        console.error('Error fetching requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests' });
    }
});

// Static file serving - must come AFTER API routes
app.use(express.static(__dirname));

// Start server
async function startServer() {
    await ensureDataDir();
    
    app.listen(PORT, () => {
        console.log(`\n🚀 CerneyDesigns server is running!`);
        console.log(`📍 Local: http://localhost:${PORT}`);
        console.log(`\n📝 Design requests are saved to: ${DATA_FILE}\n`);
    });
}

startServer().catch(console.error);

