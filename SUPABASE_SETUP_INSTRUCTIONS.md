# Supabase Setup Instructions

## Step 1: Create Storage Bucket (via UI)

1. Go to your Supabase project dashboard: https://app.supabase.com
2. Navigate to **Storage** in the left sidebar
3. Click **"New bucket"**
4. Name it: `design-requests`
5. Set it to **Public** (if you want public access to PDFs) or **Private** (if you want restricted access)
6. Click **"Create bucket"**

## Step 2: Create Database Table (via SQL)

1. Go to **SQL Editor** in your Supabase dashboard
2. Click **"New query"**
3. Copy and paste the contents of `supabase_setup.sql`
4. Click **"Run"** to execute the SQL

This will create:
- `design_requests` table with all necessary columns
- Indexes for faster queries
- Automatic timestamp updates
- Row Level Security policies

## Step 3: Verify Setup

After running the SQL, you should see:
- ✅ Table `design_requests` created
- ✅ Indexes created
- ✅ Trigger function created
- ✅ RLS policies enabled

## What Gets Stored Where?

- **PDF files** → Supabase Storage bucket (`design-requests`)
- **Request metadata** → Supabase Database table (`design_requests`)
- **Local backup** → `data/requests.json` (still saved as backup)

## Viewing Your Data

You can view requests in:
- **Supabase Dashboard** → Table Editor → `design_requests`
- **Supabase Dashboard** → Storage → `design-requests` bucket (for PDFs)

