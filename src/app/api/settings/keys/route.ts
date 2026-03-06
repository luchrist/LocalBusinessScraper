
import { NextRequest, NextResponse } from 'next/server';
import { getApiKeys, addApiKey, deleteApiKey, initSettingsDb, resetApiKeyUsage } from '@/lib/settings-db';

// Ensure DB is initialized
try {
  initSettingsDb();
} catch (e) {
  console.error('Failed to initialize settings DB:', e);
}

export async function GET() {
  const keys = getApiKeys().map((k: any) => ({
    ...k,
    key: k.key // Send full key to frontend? Maybe masked for specific UI needs?
    // Usually only last 4 chars are shown, but for "hideable" UI, we might need full key.
    // Let's send full key, frontend handles masking.
  }));
  return NextResponse.json(keys);
}

export async function POST(req: NextRequest) {
  try {
    const { key, action } = await req.json();

    if (action === 'reset') {
        if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 });
        resetApiKeyUsage(key);
        return NextResponse.json({ success: true });
    }

    if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    
    // Validate format? Google API keys start with AIza... usually 39 chars.
    // But let's be flexible.
    
    addApiKey(key);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { key } = await req.json();
    if (!key) return NextResponse.json({ error: 'Key is required' }, { status: 400 });

    deleteApiKey(key);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
