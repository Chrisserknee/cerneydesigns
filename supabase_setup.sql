-- Create table for design requests
-- Run this SQL in your Supabase SQL Editor: https://app.supabase.com/project/_/sql

CREATE TABLE IF NOT EXISTS design_requests (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone_number TEXT,
    project_type TEXT NOT NULL,
    timeline TEXT NOT NULL,
    budget TEXT NOT NULL,
    design_description TEXT NOT NULL,
    reference_websites TEXT,
    color_preferences TEXT,
    style_preferences TEXT,
    key_features TEXT,
    status TEXT DEFAULT 'pending_review',
    pdf_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_design_requests_email ON design_requests(email);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_design_requests_status ON design_requests(status);

-- Create index on created_at for sorting
CREATE INDEX IF NOT EXISTS idx_design_requests_created_at ON design_requests(created_at DESC);

-- Create a function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_design_requests_updated_at 
    BEFORE UPDATE ON design_requests 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS) - adjust policies as needed
ALTER TABLE design_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role to do everything (for server-side operations)
-- This is already handled by using the service role key, but we can add explicit policy
CREATE POLICY "Service role can do everything"
    ON design_requests
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Optional: Policy to allow authenticated users to read their own requests
-- Uncomment if you want users to view their own requests
-- CREATE POLICY "Users can view their own requests"
--     ON design_requests
--     FOR SELECT
--     USING (auth.uid()::text = id OR auth.email() = email);


