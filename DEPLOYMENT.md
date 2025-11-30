# Vercel Deployment Guide

## Prerequisites

1. **Vercel Account**: Sign up at https://vercel.com if you don't have an account
2. **Environment Variables**: Make sure you have your Supabase credentials ready

## Deployment Steps

### Option 1: Using Vercel CLI (Recommended)

1. **Login to Vercel** (if not already logged in):
   ```bash
   vercel login
   ```
   This will open a browser window for authentication.

2. **Deploy to Vercel**:
   ```bash
   vercel
   ```
   Follow the prompts:
   - Link to existing project? (Choose No for first deployment)
   - Project name: (Press Enter for default or enter a custom name)
   - Directory: (Press Enter for current directory)
   - Override settings? (Press Enter for No)

3. **Set Environment Variables**:
   After deployment, you need to set environment variables in Vercel dashboard:
   - Go to your project on https://vercel.com
   - Navigate to Settings → Environment Variables
   - Add the following variables:
     - `SUPABASE_URL` - Your Supabase project URL
     - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key
     - `SUPABASE_STORAGE_BUCKET_NAME` - Your Supabase storage bucket name (default: `design-requests`)
     - `PORT` - Optional (Vercel sets this automatically)

4. **Redeploy** after setting environment variables:
   ```bash
   vercel --prod
   ```

### Option 2: Using GitHub Integration

1. **Push your code to GitHub** (if not already):
   ```bash
   git add .
   git commit -m "Prepare for Vercel deployment"
   git push origin main
   ```

2. **Import Project on Vercel**:
   - Go to https://vercel.com/new
   - Import your GitHub repository
   - Vercel will automatically detect the configuration

3. **Set Environment Variables**:
   - In the project settings, add all environment variables listed above
   - Vercel will automatically redeploy

## Important Notes

- **File Storage**: The `data/` directory and local JSON files won't persist on Vercel's serverless functions. Make sure Supabase is configured properly as it's the primary storage solution.
- **Static Files**: Static files (HTML, CSS, images) are served automatically by Vercel.
- **Vercel Analytics**: Already integrated and will work automatically once deployed.

## Post-Deployment

After deployment, your site will be available at:
- Production: `https://your-project-name.vercel.app`
- Preview: `https://your-project-name-git-branch.vercel.app`

## Troubleshooting

- If you see errors about missing environment variables, make sure they're set in Vercel dashboard
- If API routes don't work, check that `vercel.json` is configured correctly
- Check Vercel function logs in the dashboard for debugging

