# Security Implementation

This document outlines the security measures implemented in the CerneyDesigns website.

## Security Features Implemented

### 1. Security Headers (Helmet.js)
- **Content Security Policy (CSP)**: Restricts resource loading to prevent XSS attacks
- **X-Content-Type-Options**: Prevents MIME type sniffing
- **X-Frame-Options**: Prevents clickjacking attacks
- **X-XSS-Protection**: Enables browser XSS filtering
- **Strict-Transport-Security**: Forces HTTPS (when configured)

### 2. Rate Limiting
- **General API Rate Limit**: 100 requests per 15 minutes per IP
- **Form Submission Rate Limit**: 5 submissions per 15 minutes per IP
- Prevents DoS attacks and spam submissions

### 3. Input Validation & Sanitization
- **Server-side Validation**: Using `express-validator` for all form inputs
- **XSS Protection**: All user inputs are sanitized using `xss` library
- **Input Length Limits**: 
  - Name: 1-100 characters
  - Email: Max 255 characters (validated as email)
  - Description: 10-5000 characters
  - Other fields have appropriate limits
- **Email Validation**: Proper email format validation
- **URL Validation**: Reference websites are validated
- **Select Field Validation**: Only allowed values accepted

### 4. CORS Configuration
- **Restricted Origins**: Only allows requests from configured domains
- **Production Domains**: `cerneydesigns.com` and Vercel deployments
- **Development**: Allows `localhost:3000`
- Prevents unauthorized cross-origin requests

### 5. Request Size Limits
- **JSON Payload**: Limited to 1MB
- **URL Encoded**: Limited to 1MB
- **PDF Files**: Limited to 10MB
- Prevents resource exhaustion attacks

### 6. API Endpoint Protection
- **Admin Endpoint**: `/api/requests` requires API key authentication
- **API Key**: Set via `ADMIN_API_KEY` environment variable
- **Unauthorized Access**: Returns 401 for invalid API keys

### 7. Error Handling
- **Generic Error Messages**: Prevents information leakage
- **No Stack Traces**: Error details not exposed to clients
- **Sanitized Logging**: Sensitive data truncated in logs

### 8. PDF Generation Security
- **Input Sanitization**: All PDF content is sanitized
- **Filename Sanitization**: Prevents path traversal attacks
- **Buffer Validation**: Validates PDF buffer before upload
- **Size Limits**: Enforces maximum PDF size

### 9. Frontend Security
- **Request Timeout**: 30-second timeout for API requests
- **Error Handling**: Proper error message display
- **Input Sanitization**: Client-side trimming and validation
- **CSP Meta Tags**: Additional security headers in HTML

### 10. Database Security
- **Parameterized Queries**: Using Supabase client (prevents SQL injection)
- **Row Level Security**: Enabled in Supabase (if configured)
- **Service Role Key**: Stored securely in environment variables

## Environment Variables

### Required Security Variables

```env
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_STORAGE_BUCKET_NAME=design-requests

# Optional: Admin API Key (for /api/requests endpoint)
ADMIN_API_KEY=your-secure-random-api-key-here

# Optional: Allowed CORS Origins (comma-separated)
ALLOWED_ORIGINS=https://cerneydesigns.com,https://*.vercel.app
```

### Generating a Secure API Key

For the `ADMIN_API_KEY`, generate a secure random string:

```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Using OpenSSL
openssl rand -hex 32
```

## Security Best Practices

### 1. Environment Variables
- ✅ Never commit `.env` or `.env.local` files
- ✅ Use strong, random API keys
- ✅ Rotate keys periodically
- ✅ Use different keys for development and production

### 2. API Key Usage
To access the protected `/api/requests` endpoint:

```bash
# Using header
curl -H "X-API-Key: your-api-key" https://your-domain.com/api/requests

# Using query parameter
curl https://your-domain.com/api/requests?apiKey=your-api-key
```

### 3. Rate Limiting
If legitimate users hit rate limits:
- Adjust limits in `server.js` (generalLimiter and submitLimiter)
- Consider implementing user authentication for higher limits
- Use IP whitelisting for trusted sources

### 4. CORS Configuration
Update `ALLOWED_ORIGINS` in production:
```env
ALLOWED_ORIGINS=https://cerneydesigns.com,https://www.cerneydesigns.com
```

### 5. Monitoring
- Monitor rate limit violations
- Check error logs for suspicious activity
- Review Supabase logs for database access patterns

## Security Checklist

- [x] Security headers configured
- [x] Rate limiting implemented
- [x] Input validation and sanitization
- [x] CORS properly configured
- [x] API endpoints protected
- [x] Error messages sanitized
- [x] Request size limits set
- [x] PDF generation secured
- [x] Frontend security headers
- [x] Environment variables secured

## Reporting Security Issues

If you discover a security vulnerability, please:
1. Do not open a public issue
2. Contact the maintainer directly
3. Provide detailed information about the vulnerability

## Updates

This security implementation follows industry best practices and is regularly reviewed. Keep dependencies updated:

```bash
npm audit
npm audit fix
```

